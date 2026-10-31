package handlers

import (
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func mediaInfoFixture(t *testing.T, relative string) (string, string, *services.ResourceCatalog) {
	t.Helper()
	root := t.TempDir()
	path := filepath.Join(root, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(file, image.NewRGBA(image.Rect(0, 0, 2, 3))); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	video := filepath.Join(filepath.Dir(path), "clip.webm")
	if err := os.WriteFile(video, []byte("video"), 0o644); err != nil {
		t.Fatal(err)
	}
	album := models.Album{
		Path:       filepath.Dir(path),
		Name:       filepath.Base(filepath.Dir(path)),
		ImageFiles: []string{path},
		VideoFiles: []string{video},
	}
	catalog := services.NewResourceCatalog()
	catalog.Publish(&models.ScanResult{
		Roots: []string{root},
		Collections: []models.Collection{{
			Path: root, Name: filepath.Base(root), Albums: []models.Album{album},
		}},
	}, []string{root})
	return root, path, catalog
}

func imageInfoTestApp(root string, catalog *services.ResourceCatalog, afterResolve ...fiber.Handler) *fiber.App {
	app := fiber.New()
	_, safety := middleware.PathSafetyMiddleware([]string{root})
	handlers := []fiber.Handler{middleware.ResourceParam(catalog, safety)}
	handlers = append(handlers, afterResolve...)
	handlers = append(handlers, ImageInfoHandler(catalog))
	app.Get("/api/images/:id/info", handlers...)
	return app
}

func TestImageInfoUsesFileIDAndParentDirectory(t *testing.T) {
	for _, relative := range []string{"root image.png", "相册 [100%]/子目录/photo %20.png"} {
		t.Run(relative, func(t *testing.T) {
			root, path, catalog := mediaInfoFixture(t, relative)
			id := catalog.ExternalID(path, services.ResourceFile)
			app := imageInfoTestApp(root, catalog)
			res, err := app.Test(httptest.NewRequest(http.MethodGet, "/api/images/"+id+"/info", nil))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if res.StatusCode != http.StatusOK {
				t.Fatalf("status = %d", res.StatusCode)
			}
			var info services.ImageInfo
			if err := json.NewDecoder(res.Body).Decode(&info); err != nil {
				t.Fatal(err)
			}
			wantDir := filepath.ToSlash(filepath.Join(filepath.Base(root), filepath.Dir(filepath.FromSlash(relative))))
			if info.Path != id || info.Dir != wantDir || info.Name != filepath.Base(path) {
				t.Fatalf("public fields = %q, %q, %q; want %q, %q, %q", info.Path, info.Dir, info.Name, id, wantDir, filepath.Base(path))
			}
			if info.Width != 2 || info.Height != 3 || info.Format != "png" || len(info.Checksum) != 16 || info.Size <= 0 {
				t.Fatalf("invalid metadata: %+v", info)
			}
		})
	}
}

func TestImageInfoRejectsWrongResourceTypes(t *testing.T) {
	root, path, catalog := mediaInfoFixture(t, "album/page.png")
	app := imageInfoTestApp(root, catalog)
	cases := []struct {
		name   string
		id     string
		code   string
		status int
	}{
		{"root", catalog.ExternalID(root, services.ResourceRoot), "invalid_resource_kind", http.StatusBadRequest},
		{"collection", catalog.ExternalID(root, services.ResourceCollection), "invalid_resource_kind", http.StatusBadRequest},
		{"album", catalog.ExternalID(filepath.Dir(path), services.ResourceAlbum), "invalid_resource_kind", http.StatusBadRequest},
		{"video", catalog.ExternalID(filepath.Join(filepath.Dir(path), "clip.webm"), services.ResourceFile), "unsupported_image_format", http.StatusUnsupportedMediaType},
		{"unknown", "f_unknown", "resource_not_found", http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.id == "" {
				t.Fatal("missing fixture resource id")
			}
			res, err := app.Test(httptest.NewRequest(http.MethodGet, "/api/images/"+tc.id+"/info", nil))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			var response struct {
				Code string `json:"code"`
			}
			if err := json.NewDecoder(res.Body).Decode(&response); err != nil {
				t.Fatal(err)
			}
			if res.StatusCode != tc.status || response.Code != tc.code {
				t.Fatalf("status/code = %d/%q; want %d/%q", res.StatusCode, response.Code, tc.status, tc.code)
			}
		})
	}
}

func TestImageInfoKeepsResolvedSnapshot(t *testing.T) {
	root, path, catalog := mediaInfoFixture(t, "album/page.png")
	id := catalog.ExternalID(path, services.ResourceFile)
	app := imageInfoTestApp(root, catalog, func(c *fiber.Ctx) error {
		catalog.Clear()
		return c.Next()
	})
	res, err := app.Test(httptest.NewRequest(http.MethodGet, "/api/images/"+id+"/info", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var info services.ImageInfo
	if err := json.NewDecoder(res.Body).Decode(&info); err != nil {
		t.Fatal(err)
	}
	wantDir := filepath.Base(root) + "/album"
	if res.StatusCode != http.StatusOK || info.Path != id || info.Dir != wantDir {
		t.Fatalf("metadata mixed catalog versions: status=%d path=%q dir=%q", res.StatusCode, info.Path, info.Dir)
	}
}

func TestImageInfoDecodeFailureHidesFilesystemPath(t *testing.T) {
	root, path, catalog := mediaInfoFixture(t, "album/page.png")
	if err := os.WriteFile(path, []byte("broken image"), 0o644); err != nil {
		t.Fatal(err)
	}
	id := catalog.ExternalID(path, services.ResourceFile)
	res, err := imageInfoTestApp(root, catalog).Test(httptest.NewRequest(http.MethodGet, "/api/images/"+id+"/info", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusInternalServerError || !strings.Contains(string(body), `"code":"image_info_failed"`) {
		t.Fatalf("status=%d body=%s", res.StatusCode, body)
	}
	if strings.Contains(string(body), "page.png") || strings.Contains(string(body), "album") {
		t.Fatalf("decode failure leaked filesystem details: %s", body)
	}
}
