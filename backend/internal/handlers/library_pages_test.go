package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
	"github.com/tianlongxiang/local-gallery/internal/store"
)

func TestLibraryPageHandlersCursorStatusAndResponseShape(t *testing.T) {
	root := t.TempDir()
	album1Path := filepath.Join(root, "album1")
	album2Path := filepath.Join(root, "album2")
	file1 := filepath.Join(album1Path, "1.jpg")
	file2 := filepath.Join(album2Path, "2.mp4")
	result := &models.ScanResult{
		Roots: []string{root}, AlbumCount: 2,
		Albums: []models.Album{
			{Type: "album", Path: album1Path, Name: "album1", SourceRoot: root, ImageFiles: []string{file1}, ImageCount: 1, CoverImage: file1, CoverKind: "image"},
			{Type: "album", Path: album2Path, Name: "album2", SourceRoot: root, VideoFiles: []string{file2}, VideoCount: 1, CoverImage: file2, CoverKind: "video"},
		},
		SmartCollections: []models.SmartCollection{{
			Type: "smartCollection", Tag: "收藏", AlbumCount: 2,
			Albums: []models.Album{
				{Type: "album", Path: album1Path, Name: "album1", SourceRoot: root, ImageFiles: []string{file1}, ImageCount: 1, CoverImage: file1},
				{Type: "album", Path: album2Path, Name: "album2", SourceRoot: root, VideoFiles: []string{file2}, VideoCount: 1, CoverImage: file2},
			}, CoverImage: file1,
		}},
	}
	catalog := services.NewResourceCatalog()
	catalog.SetContentKindPolicy(services.NewContentKindPolicy([]services.RootKind{
		{Path: root, Kind: models.ContentKindComic},
	}))
	catalog.Publish(result, []string{root})
	rootID := catalog.ExternalID(root, services.ResourceRoot)
	albumID := catalog.ExternalID(album1Path, services.ResourceAlbum)

	dimensions, err := services.NewMediaDimensionService(filepath.Join(t.TempDir(), "dimensions.jsonl"))
	if err != nil {
		t.Fatalf("create media dimension service: %v", err)
	}

	app := fiber.New()
	app.Get("/api/library/manifest", LibraryManifestHandler(catalog))
	app.Get("/api/library/:id/children", LibraryChildrenPageHandler(catalog))
	app.Post("/api/library/nodes/query", LibraryNodesQueryHandler(catalog))
	activities := store.NewActivityStore(filepath.Join(t.TempDir(), "activity.json"))
	unreadIndex := services.NewUnreadLibraryIndex()
	app.Get("/api/albums/random", LibraryRandomAlbumHandler(catalog, activities, unreadIndex))
	app.Get("/api/library/activity-summary", LibraryActivitySummaryHandler(catalog, activities, unreadIndex))
	app.Get("/api/library/dashboard", LibraryHomeDashboardHandler(catalog, activities, unreadIndex))
	app.Get("/api/library/unread", LibraryUnreadAlbumsPageHandler(catalog, activities, unreadIndex))
	app.Get("/api/albums/:id/media", AlbumMediaPageHandler(catalog, dimensions, store.NewPickStore(filepath.Join(t.TempDir(), "picks.json"))))
	app.Get("/api/tags", LibraryTagsPageHandler(catalog))
	app.Get("/api/tags/:tag/albums", TagAlbumsPageHandler(catalog))
	app.Get("/api/search", SearchHandler(catalog))

	manifestResp, err := app.Test(httptest.NewRequest("GET", "/api/library/manifest", nil))
	if err != nil {
		t.Fatal(err)
	}
	if manifestResp.StatusCode != fiber.StatusOK || manifestResp.Header.Get(fiber.HeaderETag) == "" {
		t.Fatalf("manifest status=%d etag=%q", manifestResp.StatusCode, manifestResp.Header.Get(fiber.HeaderETag))
	}
	assertHandlerBodyHasNoAbsolutePath(t, manifestResp.Body)

	firstResp, err := app.Test(httptest.NewRequest("GET", "/api/library/"+rootID+"/children?limit=1&kind=comic", nil))
	if err != nil {
		t.Fatal(err)
	}
	var first struct {
		Page struct {
			NextCursor string `json:"nextCursor"`
			Items      []struct {
				ID string `json:"id"`
			} `json:"items"`
		} `json:"page"`
	}
	if err := json.NewDecoder(firstResp.Body).Decode(&first); err != nil {
		t.Fatal(err)
	}
	_ = firstResp.Body.Close()
	if len(first.Page.Items) != 1 || first.Page.NextCursor == "" {
		t.Fatalf("first page=%+v", first.Page)
	}

	mediaResp, err := app.Test(httptest.NewRequest("GET", "/api/albums/"+albumID+"/media", nil))
	if err != nil {
		t.Fatal(err)
	}
	if mediaResp.StatusCode != fiber.StatusOK {
		t.Fatalf("media status=%d", mediaResp.StatusCode)
	}
	assertHandlerBodyHasNoAbsolutePath(t, mediaResp.Body)

	randomResp, err := app.Test(httptest.NewRequest("GET", "/api/albums/random?kind=comic", nil))
	if err != nil {
		t.Fatal(err)
	}
	if randomResp.StatusCode != fiber.StatusOK {
		t.Fatalf("random album status=%d", randomResp.StatusCode)
	}
	assertHandlerBodyHasNoAbsolutePath(t, randomResp.Body)

	if err := activities.Set(models.Activity{
		AlbumID: albumID, MediaKind: models.MediaKindImage, PageIndex: 0, PageCount: 1, Updated: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	summaryResp, err := app.Test(httptest.NewRequest("GET", "/api/library/activity-summary?kind=comic", nil))
	if err != nil {
		t.Fatal(err)
	}
	if summaryResp.StatusCode != fiber.StatusOK {
		t.Fatalf("activity summary status=%d", summaryResp.StatusCode)
	}
	var summaryBody struct {
		Summary services.LibraryActivitySummary `json:"summary"`
	}
	if err := json.NewDecoder(summaryResp.Body).Decode(&summaryBody); err != nil {
		t.Fatal(err)
	}
	_ = summaryResp.Body.Close()
	if summaryBody.Summary.AlbumCount != 2 || summaryBody.Summary.UnreadCount != 1 {
		t.Fatalf("activity summary=%+v", summaryBody.Summary)
	}

	randomUnreadResp, err := app.Test(httptest.NewRequest("GET", "/api/albums/random?scope=unread&kind=comic", nil))
	if err != nil {
		t.Fatal(err)
	}
	if randomUnreadResp.StatusCode != fiber.StatusOK {
		t.Fatalf("random unread status=%d", randomUnreadResp.StatusCode)
	}
	var randomUnreadBody struct {
		Albums []services.LibraryNodeSummary `json:"albums"`
	}
	if err := json.NewDecoder(randomUnreadResp.Body).Decode(&randomUnreadBody); err != nil {
		t.Fatal(err)
	}
	_ = randomUnreadResp.Body.Close()
	if len(randomUnreadBody.Albums) != 1 {
		t.Fatalf("random unread albums=%d, want 1", len(randomUnreadBody.Albums))
	}
	if randomUnreadBody.Albums[0].ID == albumID {
		t.Fatalf("started album appeared in random unread=%+v", randomUnreadBody.Albums[0])
	}

	dashboardResp, err := app.Test(httptest.NewRequest("GET", "/api/library/dashboard?kind=comic", nil))
	if err != nil {
		t.Fatal(err)
	}
	if dashboardResp.StatusCode != fiber.StatusOK {
		t.Fatalf("dashboard status=%d", dashboardResp.StatusCode)
	}
	var dashboardBody struct {
		Dashboard services.LibraryHomeDashboard `json:"dashboard"`
	}
	if err := json.NewDecoder(dashboardResp.Body).Decode(&dashboardBody); err != nil {
		t.Fatal(err)
	}
	_ = dashboardResp.Body.Close()
	if dashboardBody.Dashboard.AlbumCount != 2 || dashboardBody.Dashboard.UnreadCount != 1 || len(dashboardBody.Dashboard.Unread) != 1 || len(dashboardBody.Dashboard.InProgress) != 0 {
		t.Fatalf("dashboard=%+v", dashboardBody.Dashboard)
	}

	unreadResp, err := app.Test(httptest.NewRequest("GET", "/api/library/unread?kind=comic", nil))
	if err != nil {
		t.Fatal(err)
	}
	if unreadResp.StatusCode != fiber.StatusOK {
		t.Fatalf("unread status=%d", unreadResp.StatusCode)
	}
	var unreadBody struct {
		Page services.LibraryPage[services.LibraryNodeSummary] `json:"page"`
	}
	if err := json.NewDecoder(unreadResp.Body).Decode(&unreadBody); err != nil {
		t.Fatal(err)
	}
	_ = unreadResp.Body.Close()
	if unreadBody.Page.Total != 1 || len(unreadBody.Page.Items) != 1 || unreadBody.Page.Items[0].ID == albumID {
		t.Fatalf("unread page=%+v", unreadBody.Page)
	}

	queryRequest := httptest.NewRequest("POST", "/api/library/nodes/query", strings.NewReader(`{"ids":["`+albumID+`","a_missing"]}`))
	queryRequest.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	queryResp, err := app.Test(queryRequest)
	if err != nil {
		t.Fatal(err)
	}
	if queryResp.StatusCode != fiber.StatusOK {
		t.Fatalf("query status=%d", queryResp.StatusCode)
	}
	var queryBody struct {
		Result struct {
			Items   []services.LibraryNodeSummary `json:"items"`
			Missing []string                      `json:"missing"`
		} `json:"result"`
	}
	if err := json.NewDecoder(queryResp.Body).Decode(&queryBody); err != nil {
		t.Fatal(err)
	}
	_ = queryResp.Body.Close()
	if len(queryBody.Result.Items) != 1 || len(queryBody.Result.Missing) != 1 {
		t.Fatalf("node query=%+v", queryBody.Result)
	}

	searchResp, err := app.Test(httptest.NewRequest("GET", "/api/search?q=album1&kind=comic", nil))
	if err != nil {
		t.Fatal(err)
	}
	if searchResp.StatusCode != fiber.StatusOK {
		t.Fatalf("search status=%d", searchResp.StatusCode)
	}
	assertHandlerBodyHasNoAbsolutePath(t, searchResp.Body)

	invalidResp, err := app.Test(httptest.NewRequest("GET", "/api/tags?cursor=not-a-cursor&kind=comic", nil))
	if err != nil {
		t.Fatal(err)
	}
	if invalidResp.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("invalid cursor status=%d, want 400", invalidResp.StatusCode)
	}
	var invalidBody map[string]any
	if err := json.NewDecoder(invalidResp.Body).Decode(&invalidBody); err != nil {
		t.Fatal(err)
	}
	_ = invalidResp.Body.Close()
	if invalidBody["code"] != "invalid_cursor" {
		t.Fatalf("invalid cursor body=%+v", invalidBody)
	}

	// 资源已从新 revision 消失时，也必须先识别旧游标并返回 409；因此
	// 这两条纯目录读取路由不应挂 ResourceParam 文件系统中间件。
	catalog.Publish(&models.ScanResult{Roots: []string{root}}, []string{root})
	staleResp, err := app.Test(httptest.NewRequest("GET", "/api/library/"+rootID+"/children?limit=1&kind=comic&cursor="+first.Page.NextCursor, nil))
	if err != nil {
		t.Fatal(err)
	}
	if staleResp.StatusCode != fiber.StatusConflict {
		t.Fatalf("stale cursor status=%d, want 409", staleResp.StatusCode)
	}
	var staleBody map[string]any
	if err := json.NewDecoder(staleResp.Body).Decode(&staleBody); err != nil {
		t.Fatal(err)
	}
	_ = staleResp.Body.Close()
	if staleBody["code"] != "stale_cursor" {
		t.Fatalf("stale cursor body=%+v", staleBody)
	}

	badLimitResp, err := app.Test(httptest.NewRequest("GET", "/api/tags?limit=nope&kind=comic", nil))
	if err != nil {
		t.Fatal(err)
	}
	if badLimitResp.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("bad limit status=%d, want 400", badLimitResp.StatusCode)
	}
}

func assertHandlerBodyHasNoAbsolutePath(t *testing.T, body io.ReadCloser) {
	t.Helper()
	defer body.Close()
	var decoded any
	if err := json.NewDecoder(body).Decode(&decoded); err != nil {
		t.Fatal(err)
	}
	var visit func(any)
	visit = func(value any) {
		switch typed := value.(type) {
		case string:
			if filepath.IsAbs(typed) {
				t.Fatalf("handler response exposed absolute path %q", typed)
			}
		case []any:
			for _, item := range typed {
				visit(item)
			}
		case map[string]any:
			for _, item := range typed {
				visit(item)
			}
		}
	}
	visit(decoded)
}

func TestLibraryOnThisDayHandlerReturnsTheMatchingPhoto(t *testing.T) {
	root := t.TempDir()
	albumPath := filepath.Join(root, "album")
	year := time.Now().Year() - 1
	// 文件名里带着拍摄日期：这一张就是「那天拍的那张」。
	matching := filepath.Join(albumPath, fmt.Sprintf("IMG_%d1107_101500.jpg", year))
	other := filepath.Join(albumPath, fmt.Sprintf("IMG_%d1108_101500.jpg", year))
	result := &models.ScanResult{
		Roots: []string{root}, AlbumCount: 1,
		Albums: []models.Album{{
			Type: "album", Path: albumPath, Name: "album", SourceRoot: root,
			ImageFiles: []string{other, matching}, ImageCount: 2,
			CoverImage: other, CoverKind: "image",
			CaptureDates: []string{fmt.Sprintf("%d1107", year)},
		}},
	}
	catalog := services.NewResourceCatalog()
	catalog.SetContentKindPolicy(services.NewContentKindPolicy([]services.RootKind{
		{Path: root, Kind: models.ContentKindPhoto},
	}))
	catalog.Publish(result, []string{root})

	app := fiber.New()
	app.Get("/api/library/on-this-day", LibraryOnThisDayHandler(catalog, nil))

	resp, err := app.Test(httptest.NewRequest("GET", "/api/library/on-this-day?kind=photo&month=11&day=7", nil))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != fiber.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
	var payload struct {
		Page struct {
			Items []struct {
				MatchedDate string `json:"matchedDate"`
				Photo       *struct {
					Name string `json:"name"`
					Date string `json:"date"`
				} `json:"photo"`
			} `json:"items"`
		} `json:"page"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Page.Items) != 1 {
		t.Fatalf("page=%+v, want one item", payload.Page)
	}
	photo := payload.Page.Items[0].Photo
	if photo == nil {
		t.Fatal("photo is nil, want the photo taken that day")
	}
	if photo.Name != filepath.Base(matching) {
		t.Fatalf("photo name=%q, want the one shot on 11-07", photo.Name)
	}
	wantDate := fmt.Sprintf("%d-11-07", year)
	if photo.Date != wantDate {
		t.Fatalf("photo date=%q, want %s", photo.Date, wantDate)
	}
	if payload.Page.Items[0].MatchedDate != wantDate {
		t.Fatalf("matchedDate=%q, want %s", payload.Page.Items[0].MatchedDate, wantDate)
	}
}

func TestLibraryOnThisDayHandlerMatchesEarlierYearsOnly(t *testing.T) {
	root := t.TempDir()
	albumPath := filepath.Join(root, "album")
	file := filepath.Join(albumPath, "1.jpg")
	result := &models.ScanResult{
		Roots: []string{root}, AlbumCount: 1,
		Albums: []models.Album{{
			Type: "album", Path: albumPath, Name: "album", SourceRoot: root,
			ImageFiles: []string{file}, ImageCount: 1, CoverImage: file, CoverKind: "image",
			// 这本相册在 11 月 7 日拍过照：今年与前两年各一次。
			CaptureDates: []string{
				fmt.Sprintf("%d1107", time.Now().Year()),
				fmt.Sprintf("%d1107", time.Now().Year()-1),
				fmt.Sprintf("%d1107", time.Now().Year()-3),
			},
		}},
	}
	catalog := services.NewResourceCatalog()
	catalog.SetContentKindPolicy(services.NewContentKindPolicy([]services.RootKind{
		{Path: root, Kind: models.ContentKindPhoto},
	}))
	catalog.Publish(result, []string{root})

	app := fiber.New()
	app.Get("/api/library/on-this-day", LibraryOnThisDayHandler(catalog, nil))

	resp, err := app.Test(httptest.NewRequest("GET", "/api/library/on-this-day?kind=photo&month=11&day=7", nil))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != fiber.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
	var payload struct {
		Page struct {
			Total int `json:"total"`
			Items []struct {
				ID          string `json:"id"`
				Name        string `json:"name"`
				MatchedDate string `json:"matchedDate"`
				Photo       *struct {
					ID   string `json:"id"`
					Name string `json:"name"`
					Date string `json:"date"`
				} `json:"photo"`
			} `json:"items"`
		} `json:"page"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	// 今年的那次不算「往年」；同一本相册只出现一次，取最近的一次命中。
	if payload.Page.Total != 1 || len(payload.Page.Items) != 1 {
		t.Fatalf("page=%+v, want one item", payload.Page)
	}
	wantMatched := fmt.Sprintf("%d-11-07", time.Now().Year()-1)
	if payload.Page.Items[0].MatchedDate != wantMatched {
		t.Fatalf("matchedDate=%q, want %s", payload.Page.Items[0].MatchedDate, wantMatched)
	}
	if payload.Page.Items[0].Name != "album" {
		t.Fatalf("name=%q, want album", payload.Page.Items[0].Name)
	}
	// 这本相册的文件名里没有拍摄日期：给不出「哪一张拍于那天」的证据，
	// 就不给照片 —— 不拿相册的通用封面冒充那一天拍的那张。
	if payload.Page.Items[0].Photo != nil {
		t.Fatalf("photo=%+v, want none without filename date evidence", payload.Page.Items[0].Photo)
	}

	// 非法月日要报错，而不是悄悄给一个空列表。
	bad, err := app.Test(httptest.NewRequest("GET", "/api/library/on-this-day?kind=photo&month=13&day=1", nil))
	if err != nil {
		t.Fatal(err)
	}
	if bad.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("month=13 status=%d, want 400", bad.StatusCode)
	}
}
