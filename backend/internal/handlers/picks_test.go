package handlers

import (
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
	"github.com/tianlongxiang/local-gallery/internal/store"
)

// newPicksHandlerFixture 造一套照片侧目录与对应的 HTTP 路由。
func newPicksHandlerFixture(t *testing.T) (*fiber.App, *services.ResourceCatalog, *store.PickStore, string, string) {
	t.Helper()
	root := t.TempDir()
	albumPath := filepath.Join(root, "album1")
	first := filepath.Join(albumPath, "1.jpg")
	second := filepath.Join(albumPath, "2.jpg")
	result := &models.ScanResult{
		Roots: []string{root}, AlbumCount: 1,
		Albums: []models.Album{{
			Type: "album", Path: albumPath, Name: "album1", DisplayName: "album1",
			SourceRoot: root, ImageFiles: []string{first, second}, ImageCount: 2,
			CoverImage: first, CoverKind: "image",
		}},
	}
	catalog := services.NewResourceCatalog()
	catalog.SetContentKindPolicy(services.NewContentKindPolicy([]services.RootKind{
		{Path: root, Kind: models.ContentKindPhoto},
	}))
	catalog.Publish(result, []string{root})
	picks := store.NewPickStore(filepath.Join(t.TempDir(), "picks.json"))
	dimensions, err := services.NewMediaDimensionService(filepath.Join(t.TempDir(), "dimensions.jsonl"))
	if err != nil {
		t.Fatalf("create media dimension service: %v", err)
	}

	app := fiber.New()
	app.Get("/api/picks", PicksListHandler(picks))
	app.Post("/api/picks/batch", PicksBatchHandler(picks))
	app.Get("/api/picks/media", PicksMediaPageHandler(catalog, picks, dimensions))
	app.Get("/api/albums/:id/media", AlbumMediaPageHandler(catalog, dimensions, picks))

	return app, catalog, picks, catalog.ExternalID(albumPath, services.ResourceAlbum), catalog.ExternalID(first, services.ResourceFile)
}

func picksRequest(t *testing.T, app *fiber.App, method, path, body string) (int, map[string]any) {
	t.Helper()
	var reader *strings.Reader = strings.NewReader(body)
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var payload map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return resp.StatusCode, payload
}

func TestPicksBatchAddsAndRemoves(t *testing.T) {
	app, _, _, _, fileID := newPicksHandlerFixture(t)

	status, payload := picksRequest(t, app, "POST", "/api/picks/batch", `{"ids":["`+fileID+`"],"action":"add"}`)
	if status != 200 {
		t.Fatalf("add picks status=%d payload=%v", status, payload)
	}
	if payload["updated"] != float64(1) || payload["total"] != float64(1) {
		t.Fatalf("unexpected add result: %v", payload)
	}

	status, payload = picksRequest(t, app, "GET", "/api/picks", "")
	if status != 200 {
		t.Fatalf("list picks status=%d", status)
	}
	list, _ := payload["picks"].([]any)
	if len(list) != 1 || list[0] != fileID {
		t.Fatalf("unexpected picks list: %v", payload)
	}

	status, payload = picksRequest(t, app, "POST", "/api/picks/batch", `{"ids":["`+fileID+`"],"action":"remove"}`)
	if status != 200 {
		t.Fatalf("remove picks status=%d", status)
	}
	if payload["updated"] != float64(1) || payload["total"] != float64(0) {
		t.Fatalf("unexpected remove result: %v", payload)
	}
}

func TestPicksBatchRejectsInvalidIdentity(t *testing.T) {
	app, _, _, _, _ := newPicksHandlerFixture(t)
	status, payload := picksRequest(t, app, "POST", "/api/picks/batch", `{"ids":["not-an-id"],"action":"add"}`)
	if status != 400 {
		t.Fatalf("expected 400, got %d (%v)", status, payload)
	}
	status, payload = picksRequest(t, app, "POST", "/api/picks/batch", `{"ids":[],"action":"add"}`)
	if status != 400 {
		t.Fatalf("expected 400 for empty batch, got %d (%v)", status, payload)
	}
}

func TestPicksMediaPageListsPickedPhotos(t *testing.T) {
	app, _, _, albumID, fileID := newPicksHandlerFixture(t)
	if status, payload := picksRequest(t, app, "POST", "/api/picks/batch", `{"ids":["`+fileID+`"],"action":"add"}`); status != 200 {
		t.Fatalf("add picks: %d %v", status, payload)
	}

	status, payload := picksRequest(t, app, "GET", "/api/picks/media", "")
	if status != 200 {
		t.Fatalf("picks media status=%d (%v)", status, payload)
	}
	page, _ := payload["page"].(map[string]any)
	items, _ := page["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("expected 1 pick item, got %v", page)
	}
	item, _ := items[0].(map[string]any)
	if item["id"] != fileID || item["albumId"] != albumID {
		t.Fatalf("unexpected pick item: %v", item)
	}
	if item["picked"] != true {
		t.Fatalf("expected picked flag: %v", item)
	}
}

func TestAlbumMediaMarksPickedPhotos(t *testing.T) {
	app, _, _, albumID, fileID := newPicksHandlerFixture(t)
	if status, payload := picksRequest(t, app, "POST", "/api/picks/batch", `{"ids":["`+fileID+`"],"action":"add"}`); status != 200 {
		t.Fatalf("add picks: %d %v", status, payload)
	}
	status, payload := picksRequest(t, app, "GET", "/api/albums/"+albumID+"/media", "")
	if status != 200 {
		t.Fatalf("album media status=%d (%v)", status, payload)
	}
	page, _ := payload["page"].(map[string]any)
	items, _ := page["items"].([]any)
	picked := 0
	for _, raw := range items {
		item, _ := raw.(map[string]any)
		if item["picked"] == true {
			picked++
		}
	}
	if picked != 1 {
		t.Fatalf("expected exactly one picked item, got %d in %v", picked, items)
	}
}
