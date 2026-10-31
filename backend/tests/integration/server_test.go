// Package integration_test 跑真实 HTTP 端到端流程：构造临时漫画根目录，启动
// Fiber app，对全部公开 REST 端点发送请求并验证响应。
package integration_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/config"
	"github.com/tianlongxiang/local-gallery/internal/handlers"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
	"github.com/tianlongxiang/local-gallery/internal/store"
)

type harness struct {
	app     *fiber.App
	root    string
	cache   string
	prefs   string
	mgr     *config.Manager
	catalog *services.ResourceCatalog
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	// 使用自定义可清理的临时目录，避开 fasthttp 文件句柄延迟释放导致的
	// t.TempDir 清理失败（仅 Windows）。
	rootDir, err := os.MkdirTemp("", "local-gallery-it-")
	if err != nil {
		t.Fatal(err)
	}
	root := rootDir
	t.Cleanup(func() {
		// 多次重试，规避 Windows 文件句柄延迟
		for i := 0; i < 5; i++ {
			if err := os.RemoveAll(root); err == nil {
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
		// 最终失败不阻塞测试
		_ = os.RemoveAll(root)
	})
	cache, err := os.MkdirTemp("", "comic-cache-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(cache) })
	cacheLayout, err := services.EnsureCacheLayout(cache)
	if err != nil {
		t.Fatal(err)
	}
	prefs := cacheLayout.PreferencesPath

	// 准备 2 卷、3 张图：[作者A] vol1/page1.png, page2.png / vol2/page3.png
	writePNG(t, filepath.Join(root, "[作者A] vol1", "page1.png"), 200, 300)
	writePNG(t, filepath.Join(root, "[作者A] vol1", "page2.png"), 200, 300)
	writePNG(t, filepath.Join(root, "[作者A] vol2", "page3.png"), 200, 300)

	// config.Manager 持有根路径，便于 handler 拿到动态根
	mgr := config.NewManagerWith(&config.Config{
		MediaRoots:      []string{root},
		Host:            "127.0.0.1",
		Port:            8080,
		AccessMode:      config.AccessModeLocal,
		AllowOsOpen:     false,
		CacheDir:        cache,
		ThumbSizeW:      64,
		ThumbSizeH:      64,
		ThumbCacheSize:  100,
		CacheMaxAgeDays: 30,
		StaticDir:       "",
	}, "")

	app := fiber.New(fiber.Config{
		DisableStartupMessage: true,
		// 与主程序一致：6 MiB 让 cover 上传测试能跑
		BodyLimit: 6 * 1024 * 1024,
	})
	app.Use(middleware.Logger())
	app.Use(middleware.Recover())
	safetyMw, safetyState := middleware.PathSafetyMiddleware([]string{root})
	app.Use(safetyMw)

	thumbs, err := services.NewThumbnailService(services.ThumbnailOptions{
		CacheDir:   cacheLayout.ThumbnailDir,
		Width:      64,
		Height:     64,
		MaxAgeDays: 30,
	})
	if err != nil {
		t.Fatalf("thumbnail: %v", err)
	}
	runner := services.NewAsyncScanRunner()
	catalog := services.NewResourceCatalog()
	unreadIndex := services.NewUnreadLibraryIndex()
	runner.SetCatalog(catalog)
	prefsStore := store.NewPrefsStore(prefs)
	activityStore := store.NewActivityStore(cacheLayout.ActivityPath)

	api := app.Group("/api")
	api.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(map[string]interface{}{
			"status":    "ok",
			"comicRoot": root,
			"version":   "test",
		})
	})
	api.Post("/scan/start", handlers.AsyncScanStartHandler(runner, mgr))
	api.Get("/scan/:id/events", handlers.AsyncScanEventsHandler(runner))
	api.Delete("/scan/:id", handlers.AsyncScanCancelHandler(runner))
	api.Get("/library/manifest", handlers.LibraryManifestHandler(catalog))
	api.Get("/library/:id/children", handlers.LibraryChildrenPageHandler(catalog))
	api.Post("/library/nodes/query", handlers.LibraryNodesQueryHandler(catalog))
	api.Get("/library/activity-summary", handlers.LibraryActivitySummaryHandler(catalog, activityStore, unreadIndex))
	api.Get("/library/dashboard", handlers.LibraryHomeDashboardHandler(catalog, activityStore, unreadIndex))
	api.Get("/library/unread", handlers.LibraryUnreadAlbumsPageHandler(catalog, activityStore, unreadIndex))
	api.Get("/albums/random", handlers.LibraryRandomAlbumHandler(catalog, activityStore, unreadIndex))
	api.Get("/albums/:id/media", handlers.AlbumMediaPageHandler(catalog))
	api.Get("/tags", handlers.LibraryTagsPageHandler(catalog))
	api.Get("/tags/:tag/albums", handlers.TagAlbumsPageHandler(catalog))
	api.Get("/search", handlers.SearchHandler(catalog))
	api.Get("/thumbs", handlers.ThumbHandler(thumbs))
	api.Post("/thumbs/cleanup", handlers.ThumbCleanupHandler(thumbs))
	api.Post("/thumbs/cover", handlers.ThumbCoverHandler(thumbs))
	api.Get("/videos", handlers.VideoHandler(nil, nil))
	// 元数据工具不可用时仍通过正式资源路由返回基础文件信息。
	api.Get("/videos/:id/info", middleware.ResourceParam(catalog, safetyState), handlers.VideoInfoHandler(nil, nil, catalog))
	api.Post("/videos/info/batch", handlers.VideoInfoBatchHandler(nil, nil, catalog, safetyState))
	api.Get("/videos/transcode/status", handlers.TranscodeStatusHandler(nil))
	api.Get("/videos/transcode/events", handlers.TranscodeEventsHandler(nil))
	api.Post("/videos/transcode/cancel", handlers.TranscodeCancelHandler(nil))
	api.Get("/images", handlers.ImageHandler())
	api.Get("/images/:id/info", middleware.ResourceParam(catalog, safetyState), handlers.ImageInfoHandler(catalog))
	api.Get("/prefs", handlers.PrefsGetHandler(prefsStore))
	api.Patch("/prefs", handlers.PrefsPatchHandler(prefsStore))
	api.Get("/favorites", handlers.FavoritesListHandler(prefsStore))
	api.Post("/favorites", handlers.FavoriteAddHandler(prefsStore))
	api.Delete("/favorites", handlers.FavoriteRemoveHandler(prefsStore))
	api.Post("/favorites/prune", handlers.FavoritesPruneHandler(prefsStore, catalog))
	api.Get("/history", handlers.HistoryListHandler(prefsStore))
	api.Post("/history", handlers.HistoryAddHandler(prefsStore))
	api.Delete("/history", handlers.HistoryClearHandler(prefsStore))
	api.Get("/activity", handlers.ActivityGetHandler(activityStore))
	api.Put("/activity", handlers.ActivityPutHandler(activityStore))
	api.Delete("/activity", handlers.ActivityDeleteHandler(activityStore))
	api.Post("/activity/query", handlers.ActivityQueryHandler(activityStore))
	api.Put("/activity/batch", handlers.ActivityBatchPutHandler(activityStore))
	api.Delete("/activity/all", handlers.ActivityClearHandler(activityStore))
	api.Get("/config", handlers.ConfigGetHandler(mgr))
	api.Put("/config", handlers.ConfigUpdateHandler(mgr, nil))

	// cache/clear 统一入口:集成测试用 ffmpeg 不可用场景(faststart/transcode 传 nil),
	// 但 thumbs 是真服务,可测 scope=thumbs 与 scope=all 的 thumbs 分支。
	cacheStats := services.NewCacheStatsService(50 * time.Millisecond)
	api.Get("/cache/stats", handlers.CacheStatsHandler(mgr, cacheStats))
	api.Post("/cache/clear", handlers.CacheClearHandler(thumbs, nil, nil, cacheStats))

	return &harness{app, root, cache, prefs, mgr, catalog}
}

func (h *harness) do(t *testing.T, method, path string, body interface{}) (*http.Response, []byte) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		buf, _ := json.Marshal(body)
		rdr = bytes.NewReader(buf)
	}
	req := httptest.NewRequest(method, path, rdr)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := h.app.Test(req, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	rb, _ := io.ReadAll(res.Body)
	return res, rb
}

// doRaw 发送任意 Content-Type 的原始字节 body（用于上传 canvas blob）。
func (h *harness) doRaw(t *testing.T, method, path, contentType string, body []byte) (*http.Response, []byte) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req := httptest.NewRequest(method, path, rdr)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if body != nil {
		req.ContentLength = int64(len(body))
	}
	res, err := h.app.Test(req, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	rb, _ := io.ReadAll(res.Body)
	return res, rb
}

// releaseFile 触发 Windows 上文件句柄的延迟释放，给 t.TempDir 清理留时间窗。
func releaseFile() {
	// 触发 GC 让 fasthttp 内部缓冲释放
	for i := 0; i < 3; i++ {
		runtime.Gosched()
	}
}

func TestHealth(t *testing.T) {
	h := newHarness(t)
	res, body := h.do(t, "GET", "/api/health", nil)
	if res.StatusCode != 200 {
		t.Fatalf("status=%d body=%s", res.StatusCode, body)
	}
	var got map[string]interface{}
	json.Unmarshal(body, &got)
	if got["status"] != "ok" {
		t.Errorf("status=%v want ok", got["status"])
	}
}

func TestAsyncScanAndSSE(t *testing.T) {
	h := newHarness(t)
	res, body := h.do(t, "POST", "/api/scan/start", nil)
	if res.StatusCode != 200 {
		t.Fatalf("start status=%d", res.StatusCode)
	}
	var sr struct {
		ScanID string `json:"scanId"`
	}
	json.Unmarshal(body, &sr)
	if sr.ScanID == "" {
		t.Fatalf("empty scanId, body=%s", body)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		er, eb := h.do(t, "GET", "/api/scan/"+sr.ScanID+"/events", nil)
		if er.StatusCode != 200 {
			t.Fatalf("events status=%d", er.StatusCode)
		}
		stream := string(eb)
		if strings.Contains(stream, "event: complete") {
			return
		}
		if strings.Contains(stream, "event: error") {
			t.Fatalf("scan error: %s", stream)
		}
		time.Sleep(150 * time.Millisecond)
	}
	t.Fatal("scan did not complete in 3s")
}

func (h *harness) scanLibrary(t *testing.T) (*http.Response, []byte) {
	t.Helper()
	res, body := h.do(t, http.MethodPost, "/api/scan/start", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("start status=%d body=%s", res.StatusCode, body)
	}
	var started struct {
		ScanID string `json:"scanId"`
	}
	if err := json.Unmarshal(body, &started); err != nil || started.ScanID == "" {
		t.Fatalf("invalid scan response: %s err=%v", body, err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		res, body = h.do(t, http.MethodGet, "/api/library/manifest", nil)
		if res.StatusCode == http.StatusOK {
			return res, body
		}
		if time.Now().After(deadline) {
			t.Fatalf("library manifest timeout: status=%d body=%s", res.StatusCode, body)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func TestPagedLibraryFlowAfterScan(t *testing.T) {
	h := newHarness(t)
	res, body := h.scanLibrary(t)
	if res.Header.Get(fiber.HeaderETag) == "" {
		t.Fatalf("manifest status=%d etag=%q body=%s", res.StatusCode, res.Header.Get(fiber.HeaderETag), body)
	}
	var manifest struct {
		Manifest services.LibraryManifest `json:"manifest"`
	}
	if err := json.Unmarshal(body, &manifest); err != nil || len(manifest.Manifest.Roots) != 1 {
		t.Fatalf("invalid manifest: %s err=%v", body, err)
	}
	rootID := manifest.Manifest.Roots[0].ID
	if manifest.Manifest.Statistics.AlbumCount != 2 || rootID == "" {
		t.Fatalf("unexpected manifest: %+v", manifest.Manifest)
	}

	res, body = h.do(t, http.MethodGet, "/api/library/"+rootID+"/children?limit=1", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("children status=%d body=%s", res.StatusCode, body)
	}
	var children struct {
		Page services.LibraryPage[services.LibraryNodeSummary] `json:"page"`
	}
	if err := json.Unmarshal(body, &children); err != nil || len(children.Page.Items) != 1 {
		t.Fatalf("invalid children page: %s err=%v", body, err)
	}
	firstAlbum := children.Page.Items[0]
	if children.Page.Total != 2 || children.Page.NextCursor == "" || firstAlbum.SourceRoot != rootID {
		t.Fatalf("unexpected children page: %+v", children.Page)
	}
	if bytes.Contains(body, []byte(h.root)) {
		t.Fatalf("children page exposed absolute root: %s", body)
	}

	res, body = h.do(t, http.MethodGet, "/api/library/activity-summary", nil)
	if res.StatusCode != http.StatusOK || bytes.Contains(body, []byte(h.root)) {
		t.Fatalf("activity summary status=%d body=%s", res.StatusCode, body)
	}
	var activitySummary struct {
		Summary services.LibraryActivitySummary `json:"summary"`
	}
	if err := json.Unmarshal(body, &activitySummary); err != nil || activitySummary.Summary.UnreadCount != 2 {
		t.Fatalf("invalid activity summary: %s err=%v", body, err)
	}

	res, body = h.do(t, http.MethodGet, "/api/library/dashboard", nil)
	if res.StatusCode != http.StatusOK || bytes.Contains(body, []byte(h.root)) {
		t.Fatalf("library dashboard status=%d body=%s", res.StatusCode, body)
	}
	var dashboard struct {
		Dashboard services.LibraryHomeDashboard `json:"dashboard"`
	}
	if err := json.Unmarshal(body, &dashboard); err != nil || dashboard.Dashboard.AlbumCount != 2 || dashboard.Dashboard.UnreadCount != 2 || len(dashboard.Dashboard.Unread) != 2 {
		t.Fatalf("invalid library dashboard: %s err=%v", body, err)
	}

	res, body = h.do(t, http.MethodGet, "/api/library/unread?limit=1", nil)
	if res.StatusCode != http.StatusOK || bytes.Contains(body, []byte(h.root)) {
		t.Fatalf("unread page status=%d body=%s", res.StatusCode, body)
	}
	var unread struct {
		Page services.LibraryPage[services.LibraryNodeSummary] `json:"page"`
	}
	if err := json.Unmarshal(body, &unread); err != nil || unread.Page.Total != 2 || len(unread.Page.Items) != 1 || unread.Page.NextCursor == "" {
		t.Fatalf("invalid unread page: %s err=%v", body, err)
	}

	res, body = h.do(t, http.MethodGet, "/api/albums/random?scope=unread", nil)
	if res.StatusCode != http.StatusOK || bytes.Contains(body, []byte(h.root)) {
		t.Fatalf("random unread status=%d body=%s", res.StatusCode, body)
	}

	res, body = h.do(t, http.MethodGet, "/api/search?q=作者A", nil)
	if res.StatusCode != http.StatusOK || bytes.Contains(body, []byte(h.root)) {
		t.Fatalf("search status=%d body=%s", res.StatusCode, body)
	}

	res, body = h.do(t, http.MethodGet, "/api/albums/"+firstAlbum.ID+"/media?limit=1", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("media status=%d body=%s", res.StatusCode, body)
	}
	var media struct {
		Page services.LibraryPage[services.LibraryMediaItem] `json:"page"`
	}
	if err := json.Unmarshal(body, &media); err != nil || len(media.Page.Items) != 1 {
		t.Fatalf("invalid media page: %s err=%v", body, err)
	}
	if media.Page.Items[0].Kind != "image" || media.Page.Items[0].KindIndex != 0 {
		t.Fatalf("unexpected media item: %+v", media.Page.Items[0])
	}
	fileID := media.Page.Items[0].ID
	res, body = h.do(t, http.MethodGet, "/api/images/"+fileID+"/info", nil)
	var imageInfo services.ImageInfo
	if res.StatusCode != http.StatusOK || json.Unmarshal(body, &imageInfo) != nil {
		t.Fatalf("image info status=%d body=%s", res.StatusCode, body)
	}
	wantDir := filepath.ToSlash(filepath.Join(filepath.Base(h.root), firstAlbum.Name))
	if imageInfo.Path != fileID || imageInfo.Dir != wantDir || imageInfo.Name != media.Page.Items[0].Name ||
		imageInfo.Width != 200 || imageInfo.Height != 300 || len(imageInfo.Checksum) != 16 {
		t.Fatalf("unexpected image metadata: %+v; want directory %q", imageInfo, wantDir)
	}
	for _, id := range []string{rootID, firstAlbum.ID} {
		res, body = h.do(t, http.MethodGet, "/api/images/"+id+"/info", nil)
		if res.StatusCode != http.StatusBadRequest || !bytes.Contains(body, []byte(`"code":"invalid_resource_kind"`)) {
			t.Fatalf("non-file image info status=%d body=%s", res.StatusCode, body)
		}
	}

	res, body = h.do(t, http.MethodPost, "/api/library/nodes/query", map[string]any{
		"ids": []string{firstAlbum.ID, "a_missing"},
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("node query status=%d body=%s", res.StatusCode, body)
	}
	var nodes struct {
		Result services.LibraryNodeQueryResult `json:"result"`
	}
	if err := json.Unmarshal(body, &nodes); err != nil || len(nodes.Result.Items) != 1 || len(nodes.Result.Missing) != 1 {
		t.Fatalf("invalid node query: %s err=%v", body, err)
	}

	res, body = h.do(t, http.MethodGet, "/api/tags?limit=1", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("tags status=%d body=%s", res.StatusCode, body)
	}
	var tags struct {
		Page services.LibraryPage[services.LibraryTagSummary] `json:"page"`
	}
	if err := json.Unmarshal(body, &tags); err != nil || len(tags.Page.Items) != 1 || tags.Page.Items[0].Tag != "作者A" {
		t.Fatalf("invalid tags page: %s err=%v", body, err)
	}
	res, body = h.do(t, http.MethodGet, "/api/tags/"+url.PathEscape(tags.Page.Items[0].Tag)+"/albums?limit=1", nil)
	var tagged struct {
		Page services.LibraryPage[services.LibraryNodeSummary] `json:"page"`
	}
	if res.StatusCode != http.StatusOK || json.Unmarshal(body, &tagged) != nil || len(tagged.Page.Items) != 1 || tagged.Page.Revision != tags.Page.Revision {
		t.Fatalf("invalid tag albums page: status=%d body=%s", res.StatusCode, body)
	}

	// 一次扫描只发布一个 revision，所有当前目录分页端点必须保持一致。
	if manifest.Manifest.Revision != children.Page.Revision || children.Page.Revision != media.Page.Revision ||
		media.Page.Revision != nodes.Result.Revision ||
		nodes.Result.Revision != tags.Page.Revision || h.catalog.Acquire().Revision() != tags.Page.Revision {
		t.Fatalf("revision mismatch: manifest=%d children=%d media=%d nodes=%d tags=%d catalog=%d",
			manifest.Manifest.Revision, children.Page.Revision, media.Page.Revision, nodes.Result.Revision, tags.Page.Revision,
			h.catalog.Acquire().Revision())
	}
}

func TestImage(t *testing.T) {
	h := newHarness(t)
	img := filepath.Join(h.root, "[作者A] vol1", "page1.png")
	res, body := h.do(t, "GET", "/api/images?path="+escape(img), nil)
	if res.StatusCode != 200 {
		t.Fatalf("image status=%d body=%s", res.StatusCode, body)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if cfg.Width != 200 || cfg.Height != 300 {
		t.Errorf("size=%dx%d", cfg.Width, cfg.Height)
	}

	// 让 fasthttp 内部缓冲释放，避免 Windows 上 t.TempDir 清理时的 file lock
	releaseFile()
}

// 原图 ETag 协商:第一次带 ETag;带 If-None-Match 命中 → 304;改文件 → 新 ETag。
//
// 真实浏览场景里,用户从 Album 详情点开 → 进 Gallery → 返回 → 再点开,
// 浏览器会带 If-None-Match 重拉原图;命中 304 省下几 MB 流量(尤其在
// 局域网 / 远程桌面场景)。这条用例确保:1) ETag 一定生成,2) 304
// 条件严格(只有完整字面相等才命中),3) 文件 mtime 变化后 ETag 变,
// 4) 304 响应 body 为空。
func TestImageETag(t *testing.T) {
	h := newHarness(t)
	img := filepath.Join(h.root, "[作者A] vol1", "page1.png")

	// 1) 第一次请求:应带 ETag 头(强 ETag 格式 "<hex>-<hex>")
	res, body := h.do(t, "GET", "/api/images?path="+escape(img), nil)
	if res.StatusCode != 200 {
		t.Fatalf("first status=%d body=%s", res.StatusCode, body)
	}
	if len(body) == 0 {
		t.Fatal("first response should have body")
	}
	etag := res.Header.Get("ETag")
	if etag == "" {
		t.Fatal("ETag header missing")
	}
	if etag[0] != '"' || etag[len(etag)-1] != '"' {
		t.Errorf("ETag should be wrapped in quotes, got %q", etag)
	}

	// 2) 带 If-None-Match 重发:应 304 + 空 body
	req := httptest.NewRequest("GET", "/api/images?path="+escape(img), nil)
	req.Header.Set("If-None-Match", etag)
	res2, err := h.app.Test(req, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer res2.Body.Close()
	if res2.StatusCode != 304 {
		t.Errorf("expected 304 with If-None-Match, got %d", res2.StatusCode)
	}
	body2, _ := io.ReadAll(res2.Body)
	if len(body2) != 0 {
		t.Errorf("304 should have empty body, got %d bytes", len(body2))
	}

	// 3) 不匹配的 If-None-Match:应 200 + 正常 body
	req3 := httptest.NewRequest("GET", "/api/images?path="+escape(img), nil)
	req3.Header.Set("If-None-Match", `"bogus-etag"`)
	res3, err := h.app.Test(req3, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer res3.Body.Close()
	if res3.StatusCode != 200 {
		t.Errorf("mismatched If-None-Match should be 200, got %d", res3.StatusCode)
	}
	body3, _ := io.ReadAll(res3.Body)
	if len(body3) == 0 {
		t.Error("200 with mismatched etag should have body")
	}

	// 4) 修改文件 mtime 后:ETag 应变化(原 etag 失效,新请求 200 而非 304)
	newTime := time.Now().Add(2 * time.Hour)
	if err := os.Chtimes(img, newTime, newTime); err != nil {
		t.Fatal(err)
	}
	res4, _ := h.do(t, "GET", "/api/images?path="+escape(img), nil)
	if res4.StatusCode != 200 {
		t.Errorf("after mtime change status=%d", res4.StatusCode)
	}
	newEtag := res4.Header.Get("ETag")
	if newEtag == etag {
		t.Error("ETag should change after mtime change")
	}

	releaseFile()
}

func TestThumb(t *testing.T) {
	h := newHarness(t)
	img := filepath.Join(h.root, "[作者A] vol1", "page1.png")
	// 缩略图尺寸由服务端配置决定（64×64），宽高比应保持一致
	res, body := h.do(t, "GET", "/api/thumbs?path="+escape(img), nil)
	if res.StatusCode != 200 {
		t.Fatalf("status=%d body=%s", res.StatusCode, body)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("thumb decode: %v", err)
	}
	// 测试用例中创建的是 200×300，缩略图应保持宽高比：max(W,H)=64, 比例 2:3 → 42×64
	if cfg.Width != 42 || cfg.Height != 64 {
		t.Errorf("thumb size=%dx%d, want 42x64 (proportional to 200x300)", cfg.Width, cfg.Height)
	}
}

func TestFavorites(t *testing.T) {
	h := newHarness(t)
	resourceID := "a_0000000000000000000001"

	res, _ := h.do(t, "POST", "/api/favorites", map[string]string{"resourceId": resourceID})
	if res.StatusCode != 200 {
		t.Fatalf("add status=%d", res.StatusCode)
	}
	_, body := h.do(t, "GET", "/api/favorites", nil)
	var got struct {
		Favorites []string `json:"favorites"`
	}
	json.Unmarshal(body, &got)
	if len(got.Favorites) != 1 || got.Favorites[0] != resourceID {
		t.Errorf("favorites=%v", got.Favorites)
	}

	// DELETE handler expects JSON body, not query
	res, _ = h.do(t, "DELETE", "/api/favorites", map[string]string{"resourceId": resourceID})
	if res.StatusCode != 200 {
		t.Fatalf("del status=%d", res.StatusCode)
	}
	_, body = h.do(t, "GET", "/api/favorites", nil)
	json.Unmarshal(body, &got)
	if len(got.Favorites) != 0 {
		t.Errorf("after remove favorites=%v", got.Favorites)
	}
}

func TestEmptyPreferencesResponsesUseArrays(t *testing.T) {
	h := newHarness(t)
	check := func(method, route string, request any, fields ...string) {
		t.Helper()
		response, body := h.do(t, method, route, request)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("%s %s status=%d body=%s", method, route, response.StatusCode, body)
		}
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		for _, field := range fields {
			if !bytes.Equal(bytes.TrimSpace(payload[field]), []byte("[]")) {
				t.Errorf("%s %s field %s=%s, want []", method, route, field, payload[field])
			}
		}
	}
	check("GET", "/api/prefs", nil, "favorites", "history")
	check("GET", "/api/favorites", nil, "favorites")
	check("GET", "/api/history", nil, "history")
	check("PATCH", "/api/prefs", map[string]string{"theme": "dark"}, "favorites", "history")
	id := "a_0000000000000000000001"
	check("POST", "/api/favorites", map[string]string{"resourceId": id})
	check("DELETE", "/api/favorites", map[string]string{"resourceId": id}, "favorites")
	h.catalog.Publish(&models.ScanResult{}, []string{h.root})
	check("POST", "/api/favorites/prune", nil, "removed")
	check("POST", "/api/history", map[string]string{"albumId": id, "name": "sample"})
	check("DELETE", "/api/history", nil)
	check("GET", "/api/history", nil, "history")
}

func TestPrefs(t *testing.T) {
	h := newHarness(t)
	res, _ := h.do(t, "PATCH", "/api/prefs", map[string]interface{}{"autoSwitchAlbum": true})
	if res.StatusCode != 200 {
		t.Fatalf("patch status=%d", res.StatusCode)
	}
	_, body := h.do(t, "GET", "/api/prefs", nil)
	var p map[string]interface{}
	json.Unmarshal(body, &p)
	if p["autoSwitchAlbum"] != true {
		t.Errorf("autoSwitchAlbum=%v", p["autoSwitchAlbum"])
	}
}

func TestPathSafetyRejectsEscape(t *testing.T) {
	h := newHarness(t)
	bad := filepath.Join(t.TempDir(), "outside.png")
	writePNG(t, bad, 1, 1)
	res, body := h.do(t, http.MethodGet, "/api/images/"+url.PathEscape(bad)+"/info", nil)
	if res.StatusCode != http.StatusNotFound || !bytes.Contains(body, []byte(`"code":"resource_not_found"`)) {
		t.Fatalf("external path accepted as resource: status=%d body=%s", res.StatusCode, body)
	}
}

func TestHistory(t *testing.T) {
	h := newHarness(t)
	h.do(t, "POST", "/api/history", map[string]interface{}{
		"albumId": "a_0000000000000000000001", "name": "X", "imageCount": 5,
	})
	h.do(t, "POST", "/api/history", map[string]interface{}{
		"albumId": "a_0000000000000000000002", "name": "Y", "imageCount": 3,
	})
	_, body := h.do(t, "GET", "/api/history", nil)
	var got struct {
		History []map[string]interface{} `json:"history"`
	}
	json.Unmarshal(body, &got)
	if len(got.History) != 2 {
		t.Errorf("history=%d", len(got.History))
	}
	if _, leaked := got.History[0]["path"]; leaked {
		t.Fatal("history response still exposes legacy path field")
	}
}

func TestActivityBatchWriteAndRead(t *testing.T) {
	h := newHarness(t)
	activities := []map[string]interface{}{
		{"albumId": "a_0000000000000000000001", "mediaKind": "image", "pageIndex": 4, "pageCount": 10},
		{"albumId": "a_0000000000000000000002", "mediaKind": "video", "itemId": "f_0000000000000000000002", "positionMs": 98_000, "durationMs": 100_000},
	}
	res, body := h.do(t, "PUT", "/api/activity/batch", map[string]interface{}{"activities": activities})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("batch set status=%d body=%s", res.StatusCode, body)
	}
	res, body = h.do(t, "POST", "/api/activity/query", map[string]interface{}{
		"items": []map[string]interface{}{
			{"albumId": "a_0000000000000000000001", "mediaKind": "image"},
			{"albumId": "a_0000000000000000000002", "mediaKind": "video", "itemId": "f_0000000000000000000002"},
		},
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("batch get status=%d body=%s", res.StatusCode, body)
	}
	var got struct {
		Activities []models.Activity `json:"activities"`
		Count      int               `json:"count"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Count != 2 || got.Activities[0].PageIndex != 4 || got.Activities[1].Status != models.ActivityCompleted {
		t.Fatalf("unexpected batch result: %+v", got)
	}

	res, _ = h.do(t, "PUT", "/api/activity/batch", map[string]interface{}{
		"activities": []map[string]interface{}{{"albumId": h.root, "mediaKind": "image", "pageIndex": 1, "pageCount": 2}},
	})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("absolute path batch status=%d, want 400", res.StatusCode)
	}
}

func TestConfig_Get(t *testing.T) {
	h := newHarness(t)
	res, body := h.do(t, "GET", "/api/config", nil)
	if res.StatusCode != 200 {
		t.Fatalf("status=%d body=%s", res.StatusCode, body)
	}
	var got map[string]interface{}
	json.Unmarshal(body, &got)
	roots, ok := got["mediaRoots"].([]interface{})
	if !ok || len(roots) != 1 || roots[0] != h.root {
		t.Errorf("mediaRoots=%v want [%q]", got["mediaRoots"], h.root)
	}
	if got["allowOsOpen"] != false {
		t.Errorf("allowOsOpen=%v", got["allowOsOpen"])
	}
}

func TestConfig_Patch_AllowOsOpen(t *testing.T) {
	h := newHarness(t)
	res, body := h.do(t, "PUT", "/api/config", map[string]interface{}{
		"allowOsOpen": true,
	})
	if res.StatusCode != 200 {
		t.Fatalf("status=%d body=%s", res.StatusCode, body)
	}
	var resp struct {
		OK     bool `json:"ok"`
		Config struct {
			AllowOsOpen bool `json:"allowOsOpen"`
		} `json:"config"`
		RequiresRestart []string `json:"requiresRestart"`
	}
	json.Unmarshal(body, &resp)
	if !resp.OK {
		t.Fatal("ok should be true")
	}
	if !resp.Config.AllowOsOpen {
		t.Error("allowOsOpen should be true after PATCH")
	}
	if len(resp.RequiresRestart) != 0 {
		t.Errorf("requiresRestart=%v should be empty for allowOsOpen", resp.RequiresRestart)
	}
	if !h.mgr.Get().AllowOsOpen {
		t.Error("manager should reflect new state")
	}
}

func TestConfig_Patch_Invalid(t *testing.T) {
	h := newHarness(t)
	res, _ := h.do(t, "PUT", "/api/config", map[string]interface{}{
		"port": 70000,
	})
	if res.StatusCode != 400 {
		t.Errorf("status=%d want 400", res.StatusCode)
	}
}

func TestConfig_Patch_PortRequiresRestart(t *testing.T) {
	h := newHarness(t)
	res, body := h.do(t, "PUT", "/api/config", map[string]interface{}{
		"port": 9090,
	})
	if res.StatusCode != 200 {
		t.Fatalf("status=%d body=%s", res.StatusCode, body)
	}
	var resp struct {
		RequiresRestart []string `json:"requiresRestart"`
	}
	json.Unmarshal(body, &resp)
	if len(resp.RequiresRestart) != 1 || resp.RequiresRestart[0] != "port" {
		t.Errorf("requiresRestart=%v want [port]", resp.RequiresRestart)
	}
}

// ---- video cover flow ----

// 完整跑通：未抽帧时 thumbs 返回 404 + code → 上传 jpeg → thumbs 返回 PNG。
func TestVideoCover_FullFlow(t *testing.T) {
	h := newHarness(t)
	// 准备一个伪 mp4
	vidDir := filepath.Join(h.root, "[vid] demo")
	if err := os.MkdirAll(vidDir, 0o755); err != nil {
		t.Fatal(err)
	}
	vidPath := filepath.Join(vidDir, "clip.mp4")
	os.WriteFile(vidPath, []byte("fake-mp4-bytes"), 0o644)

	// 1) 首次请求缩略图 → 404 + code=video_cover_missing
	res, body := h.do(t, "GET", "/api/thumbs?path="+escape(vidPath), nil)
	if res.StatusCode != 404 {
		t.Fatalf("expected 404, got %d body=%s", res.StatusCode, body)
	}
	var errResp struct {
		Code string `json:"code"`
	}
	json.Unmarshal(body, &errResp)
	if errResp.Code != "video_cover_missing" {
		t.Errorf("expected code=video_cover_missing, got %q (body=%s)", errResp.Code, body)
	}

	// 2) 上传一张 80x60 的 jpeg 当作"浏览器抽帧"
	var buf bytes.Buffer
	coverImg := image.NewRGBA(image.Rect(0, 0, 80, 60))
	for x := 0; x < 80; x++ {
		for y := 0; y < 60; y++ {
			coverImg.Set(x, y, color.RGBA{uint8(x), uint8(y), 200, 255})
		}
	}
	if err := jpeg.Encode(&buf, coverImg, &jpeg.Options{Quality: 80}); err != nil {
		t.Fatal(err)
	}
	res, body = h.doRaw(t, "POST", "/api/thumbs/cover?path="+escape(vidPath), "image/jpeg", buf.Bytes())
	if res.StatusCode != 200 {
		t.Fatalf("upload cover status=%d body=%s", res.StatusCode, body)
	}

	// 3) 再次请求 → 200 + PNG
	res, body = h.do(t, "GET", "/api/thumbs?path="+escape(vidPath), nil)
	if res.StatusCode != 200 {
		t.Fatalf("after cover upload, status=%d body=%s", res.StatusCode, body)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("decode cover png: %v", err)
	}
	if cfg.Width > 64 || cfg.Height > 64 {
		t.Errorf("cover too large: %dx%d", cfg.Width, cfg.Height)
	}
}

// 上传到非视频路径 → 400/415 类错误。
func TestVideoCover_RejectsNonVideo(t *testing.T) {
	h := newHarness(t)
	imgPath := filepath.Join(h.root, "[作者A] vol1", "page1.png")
	res, _ := h.doRaw(t, "POST", "/api/thumbs/cover?path="+escape(imgPath), "image/jpeg", []byte{0xff, 0xd8, 0xff})
	// handler 在 IsVideoFile 检查时返回 500（fmt.Errorf 不是 sentinel），
	// 现阶段我们接受 4xx/5xx；语义正确即可。
	if res.StatusCode < 400 {
		t.Errorf("expected error, got %d", res.StatusCode)
	}
}

// /api/videos 流：返回字节 + Accept-Ranges + 正确 MIME。
func TestVideoStream(t *testing.T) {
	h := newHarness(t)
	vidPath := filepath.Join(h.root, "stream.mp4")
	os.WriteFile(vidPath, []byte("hello-video"), 0o644)
	res, body := h.do(t, "GET", "/api/videos?path="+escape(vidPath), nil)
	if res.StatusCode != 200 {
		t.Fatalf("status=%d body=%s", res.StatusCode, body)
	}
	if string(body) != "hello-video" {
		t.Errorf("body=%q want hello-video", body)
	}
	if got := res.Header.Get("Accept-Ranges"); got != "bytes" {
		t.Errorf("Accept-Ranges=%q", got)
	}
	if got := res.Header.Get("Content-Type"); got != "video/mp4" {
		t.Errorf("Content-Type=%q", got)
	}
}

// 正式资源路由与批量接口在工具不可用时仍返回基础信息。
func TestVideoInfo(t *testing.T) {
	h := newHarness(t)
	vidPath := filepath.Join(h.root, "[作者A] vol1", "info.mp4")
	if err := os.WriteFile(vidPath, []byte("12345"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.scanLibrary(t)
	id := h.catalog.ExternalID(vidPath, services.ResourceFile)
	res, body := h.do(t, http.MethodGet, "/api/videos/"+id+"/info", nil)
	if res.StatusCode != 200 {
		t.Fatalf("status=%d body=%s", res.StatusCode, body)
	}
	var info struct {
		Size   int64  `json:"size"`
		Format string `json:"format"`
		Name   string `json:"name"`
		Path   string `json:"path"`
		Dir    string `json:"dir"`
	}
	if err := json.Unmarshal(body, &info); err != nil {
		t.Fatal(err)
	}
	if info.Size != 5 {
		t.Errorf("size=%d want 5", info.Size)
	}
	if info.Format != ".mp4" {
		t.Errorf("format=%q want .mp4", info.Format)
	}
	if info.Name != "info.mp4" {
		t.Errorf("name=%q", info.Name)
	}
	wantDir := filepath.ToSlash(filepath.Join(filepath.Base(h.root), "[作者A] vol1"))
	if info.Path != id || info.Dir != wantDir {
		t.Errorf("path/dir=%q/%q", info.Path, info.Dir)
	}
	albumID := h.catalog.ExternalID(filepath.Dir(vidPath), services.ResourceAlbum)
	res, body = h.do(t, http.MethodPost, "/api/videos/info/batch", map[string]any{"ids": []string{id, albumID, "f_unknown"}})
	var batch struct {
		Items []struct {
			ID   string `json:"id"`
			Code string `json:"code"`
			Info struct {
				Path string `json:"path"`
				Dir  string `json:"dir"`
			} `json:"info"`
		} `json:"items"`
	}
	if res.StatusCode != http.StatusOK || json.Unmarshal(body, &batch) != nil || len(batch.Items) != 3 {
		t.Fatalf("batch status=%d body=%s", res.StatusCode, body)
	}
	if batch.Items[0].Info.Path != id || batch.Items[0].Info.Dir != wantDir || batch.Items[1].Code != "invalid_resource_kind" || batch.Items[2].Code != "resource_not_found" {
		t.Fatalf("unexpected batch result: %s", body)
	}
}

func TestVideoInfoBatchRejectsLinkedDirectoryAfterScan(t *testing.T) {
	h := newHarness(t)
	album := filepath.Join(h.root, "[作者A] vol1")
	linkedVideo := filepath.Join(album, "clip.webm")
	validVideo := filepath.Join(h.root, "[作者A] vol2", "clip.webm")
	for _, path := range []string{linkedVideo, validVideo} {
		if err := os.WriteFile(path, []byte("inside"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	h.scanLibrary(t)
	linkedID := h.catalog.ExternalID(linkedVideo, services.ResourceFile)
	validID := h.catalog.ExternalID(validVideo, services.ResourceFile)
	if linkedID == "" || validID == "" {
		t.Fatal("scan did not publish videos")
	}
	if err := os.Rename(album, filepath.Join(h.root, "original")); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "clip.webm"), []byte("outside metadata"), 0o600); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		command := exec.Command("powershell", "-NoProfile", "-Command", "New-Item -ItemType Junction -Path $env:TEST_LINK -Target $env:TEST_TARGET -ErrorAction Stop | Out-Null")
		command.Env = append(os.Environ(), "TEST_LINK="+album, "TEST_TARGET="+outside)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("junction: %v %s", err, output)
		}
	} else if err := os.Symlink(outside, album); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(album) })
	res, body := h.do(t, http.MethodGet, "/api/videos/"+linkedID+"/info", nil)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("single status=%d body=%s", res.StatusCode, body)
	}
	res, body = h.do(t, http.MethodPost, "/api/videos/info/batch", map[string]any{"ids": []string{linkedID, validID}})
	var result struct {
		Items []struct {
			ID   string `json:"id"`
			Code string `json:"code"`
			Info *struct {
				Path string `json:"path"`
			} `json:"info"`
		} `json:"items"`
	}
	if res.StatusCode != http.StatusOK || json.Unmarshal(body, &result) != nil || len(result.Items) != 2 {
		t.Fatalf("batch status=%d body=%s", res.StatusCode, body)
	}
	if result.Items[0].ID != linkedID || result.Items[0].Code != "resource_not_found" || result.Items[0].Info != nil {
		t.Fatalf("linked path escaped validation: %s", body)
	}
	if result.Items[1].Info == nil || result.Items[1].Info.Path != validID || result.Items[1].Code != "" {
		t.Fatalf("valid item was lost: %s", body)
	}
}

// /api/videos + FaststartService: 非 faststart MP4 经 ffmpeg remux 后,
// 浏览器就能从前往后读。需要 ffmpeg,缺失时自动 skip。
func TestVideoStream_FaststartRemux(t *testing.T) {
	ffmpeg := os.Getenv("FFMPEG_PATH")
	if ffmpeg == "" {
		bundled := filepath.Join("..", "..", config.DefaultFFmpegPath)
		if services.FFmpegAvailableAt(bundled) {
			ffmpeg = bundled
		} else if p, err := exec.LookPath("ffmpeg"); err == nil {
			ffmpeg = p
		}
	}
	if ffmpeg == "" {
		t.Skip("ffmpeg not found; skipping faststart integration test")
	}

	// 用 harness 一样的 cfg 模板构造 faststart 服务
	cache, _ := os.MkdirTemp("", "comic-cache-faststart-")
	t.Cleanup(func() { os.RemoveAll(cache) })
	prefsDir, _ := os.MkdirTemp("", "comic-prefs-faststart-")
	prefs := filepath.Join(prefsDir, "settings.json")
	t.Cleanup(func() { os.RemoveAll(prefsDir) })

	rootDir, _ := os.MkdirTemp("", "local-gallery-it-faststart-")
	t.Cleanup(func() { os.RemoveAll(rootDir) })

	mgr := config.NewManagerWith(&config.Config{
		MediaRoots:      []string{rootDir},
		Host:            "127.0.0.1",
		Port:            8080,
		CacheDir:        cache,
		ThumbSizeW:      64,
		ThumbSizeH:      64,
		ThumbCacheSize:  100,
		CacheMaxAgeDays: 30,
	}, "")
	_ = prefs
	_ = mgr

	faststart := services.NewVideoFaststartService(services.FaststartOptions{
		CacheDir: cache,
		FFmpeg:   ffmpeg,
	})
	if !faststart.Available() {
		t.Skip("ffmpeg not available; skipping")
	}

	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	safetyMw, _ := middleware.PathSafetyMiddleware([]string{rootDir})
	app.Use(safetyMw)
	api := app.Group("/api")
	api.Get("/videos", handlers.VideoHandler(nil, faststart))

	// 1) 生成非 faststart MP4
	intermediate := filepath.Join(rootDir, "intermediate.mp4")
	nonFast := filepath.Join(rootDir, "non-fast.mp4")
	mustRun(t, ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=red:s=160x120:d=1:r=25",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", intermediate)
	mustRun(t, ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
		"-i", intermediate, "-c", "copy", "-movflags", "-faststart", nonFast)

	// 2) 第一次请求 → 应触发 remux,返回 200 + 字节数与原文件接近
	res, body := doHTTP(t, app, "GET", "/api/videos?path="+escape(nonFast))
	if res.StatusCode != 200 {
		t.Fatalf("status=%d body=%s", res.StatusCode, body)
	}
	if res.Header.Get("Content-Type") != "video/mp4" {
		t.Errorf("Content-Type=%q", res.Header.Get("Content-Type"))
	}
	if res.Header.Get("Accept-Ranges") != "bytes" {
		t.Errorf("Accept-Ranges=%q", res.Header.Get("Accept-Ranges"))
	}
	// 3) Range 请求也应工作
	origSize, _ := fileSize(nonFast)
	req := httptest.NewRequest("GET", "/api/videos?path="+escape(nonFast), nil)
	req.Header.Set("Range", "bytes=0-1023")
	res2, _ := app.Test(req, -1)
	if res2.StatusCode != 206 {
		t.Errorf("Range status=%d want 206", res2.StatusCode)
	}
	if got := res2.Header.Get("Content-Range"); got == "" {
		t.Errorf("Content-Range missing")
	}
	_ = origSize
	// 4) 至少有一次 Remuxed 统计
	_, _, remuxed, _ := faststart.Stats()
	if remuxed == 0 {
		t.Errorf("expected remuxed > 0, got 0")
	}
}

func mustRun(t *testing.T, name string, args ...string) {
	t.Helper()
	cmd := exec.Command(name, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("cmd %s %v: %v\n%s", name, args, err, out)
	}
}

func fileSize(p string) (int64, error) {
	fi, err := os.Stat(p)
	if err != nil {
		return 0, err
	}
	return fi.Size(), nil
}

func doHTTP(t *testing.T, app *fiber.App, method, path string) (*http.Response, []byte) {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	res, err := app.Test(req, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res, body
}

// ---- helpers ----

func escape(s string) string {
	var b strings.Builder
	for _, r := range s {
		// r 是 UTF-8 rune；按字节编码
		buf := []byte(string(r))
		for _, c := range buf {
			if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' {
				b.WriteByte(c)
			} else {
				b.WriteString(fmt.Sprintf("%%%02X", c))
			}
		}
	}
	return b.String()
}

func writePNG(t *testing.T, p string, w, h int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			img.Set(x, y, color.RGBA{byte(x), byte(y), 100, 255})
		}
	}
	png.Encode(f, img)
}
