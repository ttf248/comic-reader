package handlers

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

// TestVideoETagQuoted 验证 videoETag 派生出的 ETag 用双引号包裹。
//
// 背景：浏览器回传的 If-None-Match 一定带双引号，如果 server 发的 ETag
// 不带引号，string 永远不匹配，304 协商就废了。这是历史上与
// ThumbHandler 行为不一致的 bug；本测试守住「带引号」这条契约。
func TestVideoETagQuoted(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "fake.mp4")
	if err := os.WriteFile(path, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	etag := videoETag(info)
	if !strings.HasPrefix(etag, `"`) || !strings.HasSuffix(etag, `"`) {
		t.Fatalf("videoETag must be wrapped in double quotes, got %q", etag)
	}
	if etag == `""` {
		t.Fatalf("videoETag must not be empty quoted string, got %q", etag)
	}
}

// TestVideoETagStable 验证同文件两次调用结果一致（不同时钟漂移）。
func TestVideoETagStable(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "fake.mp4")
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	a := videoETag(info)
	b := videoETag(info)
	if a != b {
		t.Fatalf("videoETag not stable for same FileInfo: %q vs %q", a, b)
	}
}

// TestVideoETagChanges 验证 mtime / size 变化时 ETag 也变。
//
// 304 协商的核心就是「内容变了 ETag 必须变」，否则会发回陈旧字节。
func TestVideoETagChanges(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.mp4")
	b := filepath.Join(dir, "b.mp4")
	if err := os.WriteFile(a, []byte("12345"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 强制 b 的 mtime 晚于 a 至少 1ns
	if err := os.WriteFile(b, []byte("12345"), 0o644); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(b, future, future); err != nil {
		t.Fatal(err)
	}
	ia, _ := os.Stat(a)
	ib, _ := os.Stat(b)
	if videoETag(ia) == videoETag(ib) {
		t.Fatalf("expected different ETag for different mtime, both = %q", videoETag(ia))
	}

	// size 不同
	c := filepath.Join(dir, "c.mp4")
	if err := os.WriteFile(c, []byte("1234567"), 0o644); err != nil {
		t.Fatal(err)
	}
	ic, _ := os.Stat(c)
	if videoETag(ia) == videoETag(ic) {
		t.Fatalf("expected different ETag for different size, both = %q", videoETag(ia))
	}
}

func TestVideoInfoBatchUsesResourceIDsAndHidesAbsolutePaths(t *testing.T) {
	root := t.TempDir()
	albumDir := filepath.Join(root, "album")
	if err := os.Mkdir(albumDir, 0o755); err != nil {
		t.Fatal(err)
	}
	videoPath := filepath.Join(albumDir, "clip.mp4")
	if err := os.WriteFile(videoPath, []byte("fake video"), 0o644); err != nil {
		t.Fatal(err)
	}

	catalog := services.NewResourceCatalog()
	catalog.Publish(&models.ScanResult{
		Roots: []string{root},
		Albums: []models.Album{{
			Path:       albumDir,
			Name:       "album",
			ImageFiles: []string{},
			VideoFiles: []string{videoPath},
		}},
	}, []string{root})
	videoID := catalog.ExternalID(videoPath, services.ResourceFile)
	if videoID == "" {
		t.Fatal("catalog did not create a video resource id")
	}

	app := fiber.New()
	app.Post("/api/videos/info/batch", VideoInfoBatchHandler(nil, nil, catalog))
	payload, err := json.Marshal(map[string]any{"ids": []string{videoID}})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/videos/info/batch", bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	res, err := app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("status = %d, body = %s", res.StatusCode, body)
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), root) || strings.Contains(string(body), videoPath) {
		t.Fatalf("batch response leaked an absolute path: %s", body)
	}
	if !strings.Contains(string(body), videoID) {
		t.Fatalf("batch response does not contain resource id %q: %s", videoID, body)
	}
}

func TestVideoInfoWithoutCatalogHidesAbsolutePath(t *testing.T) {
	root := t.TempDir()
	videoPath := filepath.Join(root, "legacy.mp4")
	if err := os.WriteFile(videoPath, []byte("fake video"), 0o644); err != nil {
		t.Fatal(err)
	}

	app := fiber.New()
	app.Get("/api/videos/info", VideoInfoHandler(nil, nil))
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/videos/info?path="+url.QueryEscape(videoPath),
		nil,
	)
	res, err := app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("status = %d, body = %s", res.StatusCode, body)
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), root) || strings.Contains(string(body), videoPath) {
		t.Fatalf("legacy response leaked an absolute path: %s", body)
	}
	if !strings.Contains(string(body), `"path":"legacy.mp4"`) {
		t.Fatalf("legacy response did not use a safe public path: %s", body)
	}
}
