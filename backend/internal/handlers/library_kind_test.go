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

// newKindHandlerApp 搭一个混排用途的媒体库与对应的 HTTP 路由。
func newKindHandlerApp(t *testing.T) (*fiber.App, *services.ResourceCatalog, string) {
	t.Helper()
	root := t.TempDir()
	photoPath := filepath.Join(root, "photo")
	comicPath := filepath.Join(root, "comic")
	photoFile := filepath.Join(photoPath, "p.jpg")
	comicFile := filepath.Join(comicPath, "c.jpg")
	result := &models.ScanResult{
		Roots: []string{root}, AlbumCount: 2,
		Albums: []models.Album{
			{Type: "album", Path: photoPath, Name: "photo", ImageFiles: []string{photoFile}, ImageCount: 1, CoverImage: photoFile, CoverKind: "image"},
			{Type: "album", Path: comicPath, Name: "comic", ImageFiles: []string{comicFile}, ImageCount: 1, CoverImage: comicFile, CoverKind: "image"},
		},
	}
	catalog := services.NewResourceCatalog()
	catalog.Publish(result, []string{root})
	catalog.SetContentKindOverrides(map[string]models.ContentKind{
		filepath.Clean(comicPath): models.ContentKindComic,
	})

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
	return app, catalog, catalog.ExternalID(root, services.ResourceRoot)
}

func TestLibraryKindParameterFiltersChildren(t *testing.T) {
	app, _, rootID := newKindHandlerApp(t)

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

	if got := decode("/api/library/" + rootID + "/children?kind=photo").Total; got != 1 {
		t.Fatalf("photo children total=%d, want 1", got)
	}
	if got := decode("/api/library/" + rootID + "/children?kind=comic").Total; got != 1 {
		t.Fatalf("comic children total=%d, want 1", got)
	}
	if got := decode("/api/library/" + rootID + "/children").Total; got != 2 {
		t.Fatalf("default children total=%d, want 2", got)
	}
}

func TestLibraryKindParameterRejectsUnknownValue(t *testing.T) {
	app, _, rootID := newKindHandlerApp(t)

	resp, err := app.Test(httptest.NewRequest("GET", "/api/library/"+rootID+"/children?kind=manga", nil))
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
	app, _, _ := newKindHandlerApp(t)

	type summary struct {
		UnreadCount int `json:"unreadCount"`
		AlbumCount  int `json:"albumCount"`
	}
	resp, err := app.Test(httptest.NewRequest("GET", "/api/library/activity-summary?kind=photo", nil))
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Summary summary `json:"summary"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Summary.UnreadCount != 1 || payload.Summary.AlbumCount != 1 {
		t.Fatalf("photo summary=%+v", payload.Summary)
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
