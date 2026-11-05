package handlers

import (
	"encoding/json"
	"io"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
	"github.com/tianlongxiang/local-gallery/internal/store"
)

// newKindHandlerApp 搭一个按目录属性分开的媒体库与对应的 HTTP 路由。
// 照片根与漫画根各一本相册，两个工作台各自只看得见自己那一半。
func newKindHandlerApp(t *testing.T) (*fiber.App, *services.ResourceCatalog, string, string) {
	t.Helper()
	parent := t.TempDir()
	photoRoot := filepath.Join(parent, "photos")
	comicRoot := filepath.Join(parent, "comics")
	photoPath := filepath.Join(photoRoot, "photo")
	comicPath := filepath.Join(comicRoot, "comic")
	photoFile := filepath.Join(photoPath, "p.jpg")
	comicFile := filepath.Join(comicPath, "c.jpg")
	result := &models.ScanResult{
		Roots: []string{photoRoot, comicRoot}, AlbumCount: 2,
		Albums: []models.Album{
			{Type: "album", Path: photoPath, Name: "photo", SourceRoot: photoRoot, ImageFiles: []string{photoFile}, ImageCount: 1, CoverImage: photoFile, CoverKind: "image"},
			{Type: "album", Path: comicPath, Name: "comic", SourceRoot: comicRoot, ImageFiles: []string{comicFile}, ImageCount: 1, CoverImage: comicFile, CoverKind: "image"},
		},
	}
	catalog := services.NewResourceCatalog()
	catalog.SetContentKindPolicy(services.NewContentKindPolicy([]services.RootKind{
		{Path: photoRoot, Kind: models.ContentKindPhoto},
		{Path: comicRoot, Kind: models.ContentKindComic},
	}))
	catalog.Publish(result, []string{photoRoot, comicRoot})

	activities := store.NewActivityStore(filepath.Join(t.TempDir(), "activity.json"))
	unreadIndex := services.NewUnreadLibraryIndex()
	app := fiber.New()
	app.Get("/api/library/:id/children", LibraryChildrenPageHandler(catalog))
	app.Get("/api/library/activity-summary", LibraryActivitySummaryHandler(catalog, activities, unreadIndex))
	app.Get("/api/library/dashboard", LibraryHomeDashboardHandler(catalog, activities, unreadIndex))
	app.Get("/api/library/unread", LibraryUnreadAlbumsPageHandler(catalog, activities, unreadIndex))
	app.Get("/api/albums/random", LibraryRandomAlbumHandler(catalog, activities, unreadIndex))
	app.Get("/api/tags", LibraryTagsPageHandler(catalog))
	app.Get("/api/search", SearchHandler(catalog))
	return app, catalog,
		catalog.ExternalID(photoRoot, services.ResourceRoot),
		catalog.ExternalID(comicRoot, services.ResourceRoot)
}

func TestLibraryKindParameterFiltersChildren(t *testing.T) {
	app, _, photoRootID, comicRootID := newKindHandlerApp(t)

	type page struct {
		Total int `json:"total"`
	}
	decode := func(url string) page {
		t.Helper()
		resp, err := app.Test(httptest.NewRequest("GET", url, nil))
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != fiber.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("%s status=%d body=%s", url, resp.StatusCode, body)
		}
		var payload struct {
			Page page `json:"page"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		return payload.Page
	}

	if got := decode("/api/library/" + photoRootID + "/children?kind=photo").Total; got != 1 {
		t.Fatalf("photo children total=%d, want 1", got)
	}
	if got := decode("/api/library/" + comicRootID + "/children?kind=comic").Total; got != 1 {
		t.Fatalf("comic children total=%d, want 1", got)
	}
	// 属性不匹配的目录在工作台里是空的。
	if got := decode("/api/library/" + comicRootID + "/children?kind=photo").Total; got != 0 {
		t.Fatalf("photo scope over comic root total=%d, want 0", got)
	}
}

func TestLibraryKindParameterIsRequired(t *testing.T) {
	app, _, photoRootID, _ := newKindHandlerApp(t)

	resp, err := app.Test(httptest.NewRequest("GET", "/api/library/"+photoRootID+"/children", nil))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("status=%d, want 400", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "invalid_kind") {
		t.Fatalf("body=%s", body)
	}
}

func TestLibraryKindParameterRejectsUnknownValue(t *testing.T) {
	app, _, photoRootID, _ := newKindHandlerApp(t)

	resp, err := app.Test(httptest.NewRequest("GET", "/api/library/"+photoRootID+"/children?kind=manga", nil))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("status=%d, want 400", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "invalid_kind") {
		t.Fatalf("body=%s", body)
	}
}

func TestLibraryKindParameterScopesUnreadAndRandom(t *testing.T) {
	app, _, _, _ := newKindHandlerApp(t)

	type summary struct {
		UnreadCount int `json:"unreadCount"`
		AlbumCount  int `json:"albumCount"`
	}
	resp, err := app.Test(httptest.NewRequest("GET", "/api/library/activity-summary?kind=comic", nil))
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Summary summary `json:"summary"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	// 未读只统计漫画相册：漫画根那一本还没读过。
	if payload.Summary.UnreadCount != 1 || payload.Summary.AlbumCount != 1 {
		t.Fatalf("comic summary=%+v", payload.Summary)
	}

	resp, err = app.Test(httptest.NewRequest("GET", "/api/library/activity-summary?kind=photo", nil))
	if err != nil {
		t.Fatal(err)
	}
	var photoPayload struct {
		Summary summary `json:"summary"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&photoPayload); err != nil {
		t.Fatal(err)
	}
	if photoPayload.Summary.UnreadCount != 0 {
		t.Fatalf("photo summary=%+v, want no unread count", photoPayload.Summary)
	}

	resp, err = app.Test(httptest.NewRequest("GET", "/api/albums/random?kind=comic", nil))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != fiber.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("random status=%d body=%s", resp.StatusCode, body)
	}
	var random struct {
		Album struct {
			ContentKind string `json:"contentKind"`
		} `json:"album"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&random); err != nil {
		t.Fatal(err)
	}
	if random.Album.ContentKind != string(models.ContentKindComic) {
		t.Fatalf("random album kind=%q, want comic", random.Album.ContentKind)
	}
}
