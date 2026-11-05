package handlers

import (
	"encoding/json"
	"io"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func TestTagAlbumsPathDecoding(t *testing.T) {
	root := t.TempDir()
	albums := []models.Album{
		{Type: "album", Path: filepath.Join(root, "one"), Name: "one", SourceRoot: root},
		{Type: "album", Path: filepath.Join(root, "two"), Name: "two", SourceRoot: root},
	}
	labels := []string{"作者A", "作者 A", "C++", "100%", "字面%20", "字面%2F", "字面%25"}
	result := &models.ScanResult{Roots: []string{root}, Albums: albums, AlbumCount: len(albums)}
	for _, label := range labels {
		result.SmartCollections = append(result.SmartCollections, models.SmartCollection{
			Type: "smartCollection", Tag: label, Albums: albums, AlbumCount: len(albums),
		})
	}
	catalog := services.NewResourceCatalog()
	catalog.SetContentKindPolicy(services.NewContentKindPolicy([]services.RootKind{
		{Path: root, Kind: models.ContentKindComic},
	}))
	catalog.Publish(result, []string{root})
	app := fiber.New()
	app.Get("/api/tags/:tag/albums", TagAlbumsPageHandler(catalog))
	for _, label := range labels {
		t.Run(label, func(t *testing.T) {
			response, err := app.Test(httptest.NewRequest("GET", "/api/tags/"+url.PathEscape(label)+"/albums?kind=comic", nil))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, _ := io.ReadAll(response.Body)
			var parsed struct {
				Page struct {
					Total int               `json:"total"`
					Items []json.RawMessage `json:"items"`
				} `json:"page"`
			}
			if response.StatusCode != 200 || json.Unmarshal(body, &parsed) != nil || parsed.Page.Total != 2 || len(parsed.Page.Items) != 2 {
				t.Fatalf("status=%d body=%s", response.StatusCode, body)
			}
		})
	}
	t.Run("invalid escape", func(t *testing.T) {
		request := httptest.NewRequest("GET", "/", nil)
		request.URL.Opaque = "/api/tags/%zz/albums?kind=comic"
		request.RequestURI = request.URL.Opaque
		response, err := app.Test(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var body struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != 400 || body.Code != "invalid_tag" {
			t.Fatalf("status=%d code=%q", response.StatusCode, body.Code)
		}
	})
}
