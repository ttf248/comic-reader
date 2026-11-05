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
)

// newRecentTagsFixture 造一个两侧分开的媒体库：照片根与漫画根，
// 一个只含漫画的标签「连载」，一个两侧都有的标签「共同」。
func newRecentTagsFixture(t *testing.T) (*fiber.App, string) {
	t.Helper()
	parent := t.TempDir()
	photoRoot := filepath.Join(parent, "photos")
	comicRoot := filepath.Join(parent, "comics")

	album := func(path, name, tag, root string) models.Album {
		files := []string{filepath.Join(path, "p1.jpg"), filepath.Join(path, "p2.jpg")}
		return models.Album{
			Type: "album", Path: path, Name: name, DisplayName: name,
			SourceRoot: root, ImageFiles: files, ImageCount: len(files),
			CoverImage: files[0], CoverKind: "image", Tags: []string{tag},
		}
	}
	photo := album(filepath.Join(photoRoot, "photo"), "photo", "共同", photoRoot)
	comic := album(filepath.Join(comicRoot, "comic"), "comic", "共同", comicRoot)
	volume := album(filepath.Join(comicRoot, "shelf", "volume1"), "volume1", "连载", comicRoot)

	result := &models.ScanResult{
		Roots:      []string{photoRoot, comicRoot},
		Albums:     []models.Album{photo, comic, volume},
		AlbumCount: 3,
		SmartCollections: []models.SmartCollection{
			{Type: "smartCollection", Tag: "共同", Albums: []models.Album{photo, comic}, AlbumCount: 2, CoverImage: photo.CoverImage},
			{Type: "smartCollection", Tag: "连载", Albums: []models.Album{volume}, AlbumCount: 1, CoverImage: volume.CoverImage},
		},
	}
	catalog := services.NewResourceCatalog()
	catalog.SetContentKindPolicy(services.NewContentKindPolicy([]services.RootKind{
		{Path: photoRoot, Kind: models.ContentKindPhoto},
		{Path: comicRoot, Kind: models.ContentKindComic},
	}))
	catalog.Publish(result, []string{photoRoot, comicRoot})

	app := fiber.New()
	app.Get("/api/library/recent", LibraryRecentHandler(catalog))
	app.Post("/api/tags/query", LibraryTagsQueryHandler(catalog))
	return app, parent
}

// 「最近加入」必须按 kind 分侧，缺 kind 直接 400。
func TestLibraryRecentHandlerRequiresKind(t *testing.T) {
	app, _ := newRecentTagsFixture(t)

	response, err := app.Test(httptest.NewRequest("GET", "/api/library/recent", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != 400 || !strings.Contains(string(body), "invalid_kind") {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}

	for _, tc := range []struct {
		kind  string
		total int
	}{{ "photo", 1 }, { "comic", 2 }} {
		response, err := app.Test(httptest.NewRequest("GET", "/api/library/recent?kind="+tc.kind, nil))
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		var parsed struct {
			Page struct {
				Total int `json:"total"`
				Items []struct {
					ContentKind string `json:"contentKind"`
				} `json:"items"`
			} `json:"page"`
		}
		if response.StatusCode != 200 || json.Unmarshal(body, &parsed) != nil {
			t.Fatalf("status=%d body=%s", response.StatusCode, body)
		}
		if parsed.Page.Total != tc.total {
			t.Fatalf("kind=%s total=%d want %d", tc.kind, parsed.Page.Total, tc.total)
		}
		for _, item := range parsed.Page.Items {
			if item.ContentKind != tc.kind {
				t.Fatalf("kind=%s leaked %+v", tc.kind, item)
			}
		}
	}
}

// 按名解析标签要同时给出两侧册数；库里没有的标签进 missing。
func TestLibraryTagsQueryHandlerReportsBothSides(t *testing.T) {
	app, _ := newRecentTagsFixture(t)

	request := httptest.NewRequest("POST", "/api/tags/query",
		strings.NewReader(`{"names":["共同","连载","查无此标签"]}`))
	request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	response, err := app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	var parsed struct {
		Result struct {
			Items []struct {
				Tag             string `json:"tag"`
				PhotoAlbumCount int    `json:"photoAlbumCount"`
				ComicAlbumCount int    `json:"comicAlbumCount"`
			} `json:"items"`
			Missing []string `json:"missing"`
		} `json:"result"`
	}
	if response.StatusCode != 200 || json.Unmarshal(body, &parsed) != nil {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	counts := map[string][2]int{}
	for _, item := range parsed.Result.Items {
		counts[item.Tag] = [2]int{item.PhotoAlbumCount, item.ComicAlbumCount}
	}
	if got := counts["共同"]; got != [2]int{1, 1} {
		t.Fatalf("共同 counts=%v want [1 1]", got)
	}
	if got := counts["连载"]; got != [2]int{0, 1} {
		t.Fatalf("连载 counts=%v want [0 1]", got)
	}
	if len(parsed.Result.Missing) != 1 || parsed.Result.Missing[0] != "查无此标签" {
		t.Fatalf("missing=%v", parsed.Result.Missing)
	}
}

// 空名单与超长名单都要被拒绝。
func TestLibraryTagsQueryHandlerRejectsBadBodies(t *testing.T) {
	app, _ := newRecentTagsFixture(t)

	for _, body := range []string{`{}`, `{"names":[]}`, `{"names":["  "]}`} {
		request := httptest.NewRequest("POST", "/api/tags/query", strings.NewReader(body))
		request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
		response, err := app.Test(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 400 {
			t.Fatalf("body=%s status=%d want 400", body, response.StatusCode)
		}
	}
}
