package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func newContentKindApp(t *testing.T) (*fiber.App, *services.ResourceCatalog, *services.ContentKindStore, string) {
	t.Helper()
	root := t.TempDir()
	albumPath := filepath.Join(root, "album")
	result := &models.ScanResult{
		Roots: []string{root}, AlbumCount: 1,
		Albums: []models.Album{
			{
				Type: "album", Path: albumPath, Name: "album", SourceRoot: root,
				ImageFiles: []string{filepath.Join(albumPath, "1.jpg")}, ImageCount: 1,
				CoverImage: filepath.Join(albumPath, "1.jpg"), CoverKind: "image",
			},
		},
	}
	catalog := services.NewResourceCatalog()
	catalog.SetContentKindPolicy(services.NewContentKindPolicy("photo", []string{root}, nil))
	catalog.Publish(result, []string{root})
	albumID := catalog.ExternalID(albumPath, services.ResourceAlbum)

	kinds := services.NewContentKindStore(filepath.Join(t.TempDir(), "content_kinds.json"))

	app := fiber.New()
	app.Get("/api/albums/:id/content-kind", AlbumContentKindHandler(catalog, kinds))
	app.Put("/api/albums/:id/content-kind", AlbumContentKindHandler(catalog, kinds))
	app.Delete("/api/albums/:id/content-kind", AlbumContentKindHandler(catalog, kinds))
	return app, catalog, kinds, albumID
}

func decodeContentKind(t *testing.T, response *http.Response) contentKindResponseBody {
	t.Helper()
	var body contentKindResponseBody
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return body
}

func TestAlbumContentKindDefaultsToPhoto(t *testing.T) {
	app, _, _, albumID := newContentKindApp(t)

	response, err := app.Test(httptest.NewRequest("GET", "/api/albums/"+albumID+"/content-kind", nil))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	body := decodeContentKind(t, response)
	if body.ContentKind != "photo" {
		t.Fatalf("content kind = %q, want photo", body.ContentKind)
	}
	if body.ContentKindOverridden {
		t.Fatal("album without override must not be flagged")
	}
}

func TestAlbumContentKindPutPersistsOverride(t *testing.T) {
	app, _, kinds, albumID := newContentKindApp(t)

	request := httptest.NewRequest("PUT", "/api/albums/"+albumID+"/content-kind", strings.NewReader(`{"kind":"comic"}`))
	request.Header.Set("Content-Type", "application/json")
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	body := decodeContentKind(t, response)
	if body.ContentKind != "comic" {
		t.Fatalf("content kind = %q, want comic", body.ContentKind)
	}
	if !body.ContentKindOverridden {
		t.Fatal("override flag not set")
	}
	if len(kinds.Snapshot()) != 1 {
		t.Fatalf("override not persisted: %v", kinds.Snapshot())
	}

	// 覆盖后的摘要也要跟着变，首页与列表才不会显示旧用途。
	getResponse, err := app.Test(httptest.NewRequest("GET", "/api/albums/"+albumID+"/content-kind", nil))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if got := decodeContentKind(t, getResponse).ContentKind; got != "comic" {
		t.Fatalf("content kind after put = %q, want comic", got)
	}
}

func TestAlbumContentKindDeleteRestoresDefault(t *testing.T) {
	app, _, _, albumID := newContentKindApp(t)

	putRequest := httptest.NewRequest("PUT", "/api/albums/"+albumID+"/content-kind", strings.NewReader(`{"kind":"comic"}`))
	putRequest.Header.Set("Content-Type", "application/json")
	if _, err := app.Test(putRequest); err != nil {
		t.Fatalf("put: %v", err)
	}

	response, err := app.Test(httptest.NewRequest("DELETE", "/api/albums/"+albumID+"/content-kind", nil))
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	body := decodeContentKind(t, response)
	if body.ContentKind != "photo" {
		t.Fatalf("content kind = %q, want photo", body.ContentKind)
	}
	if body.ContentKindOverridden {
		t.Fatal("override flag must be cleared")
	}
}

func TestAlbumContentKindRejectsInvalidKind(t *testing.T) {
	app, _, _, albumID := newContentKindApp(t)

	request := httptest.NewRequest("PUT", "/api/albums/"+albumID+"/content-kind", strings.NewReader(`{"kind":"sketch"}`))
	request.Header.Set("Content-Type", "application/json")
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if response.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.StatusCode)
	}
}
