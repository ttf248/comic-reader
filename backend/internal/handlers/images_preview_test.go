package handlers

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
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

// previewFixture 造一个带一张 800x400 JPEG 的媒体根。
func previewFixture(t *testing.T) (string, string, *services.ResourceCatalog) {
	t.Helper()
	root := t.TempDir()
	path := filepath.Join(root, "page.jpg")
	img := image.NewRGBA(image.Rect(0, 0, 800, 400))
	for y := 0; y < 400; y++ {
		for x := 0; x < 800; x++ {
			img.Set(x, y, color.RGBA{uint8(x % 256), uint8(y % 256), 90, 255})
		}
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := jpeg.Encode(f, img, &jpeg.Options{Quality: 90}); err != nil {
		f.Close()
		t.Fatal(err)
	}
	f.Close()

	catalog := services.NewResourceCatalog()
	catalog.Publish(&models.ScanResult{
		Roots: []string{root},
		Collections: []models.Collection{{
			Path: root,
			Name: filepath.Base(root),
			Albums: []models.Album{{
				Path:       root,
				Name:       filepath.Base(root),
				ImageFiles: []string{path},
			}},
		}},
	}, []string{root})
	return root, path, catalog
}

func previewTestApp(root string, catalog *services.ResourceCatalog, svc *services.ThumbnailService) *fiber.App {
	app := fiber.New()
	_, safety := middleware.PathSafetyMiddleware([]string{root})
	app.Get("/api/previews/:id", middleware.ResourceParam(catalog, safety), PreviewHandler(svc))
	return app
}

// TestPreviewHandlerScalesImage 验证预览图接口按 w 缩放并带 ETag。
func TestPreviewHandlerScalesImage(t *testing.T) {
	root, path, catalog := previewFixture(t)
	svc, err := services.NewThumbnailService(services.ThumbnailOptions{
		CacheDir: filepath.Join(t.TempDir(), "thumbs"),
		LRUSize:  10,
	})
	if err != nil {
		t.Fatal(err)
	}
	app := previewTestApp(root, catalog, svc)
	id := catalog.ExternalID(path, services.ResourceFile)

	res, err := app.Test(httptest.NewRequest(http.MethodGet, "/api/previews/"+id+"?w=400", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != "image/jpeg" {
		t.Fatalf("content type = %q, want image/jpeg", ct)
	}
	etag := res.Header.Get("ETag")
	if etag == "" {
		t.Fatal("缺少 ETag")
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	// w=400 会向上对齐到档位 640。
	if cfg.Width != 640 || cfg.Height != 320 {
		t.Fatalf("preview size = %dx%d, want 640x320", cfg.Width, cfg.Height)
	}

	// 带 If-None-Match 复访应返回 304，不再传图。
	req := httptest.NewRequest(http.MethodGet, "/api/previews/"+id+"?w=400", nil)
	req.Header.Set("If-None-Match", etag)
	res2, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res2.Body.Close()
	if res2.StatusCode != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", res2.StatusCode)
	}
}

// TestPreviewHandlerRejectsInvalidWidth 验证非法宽度参数返回 400。
func TestPreviewHandlerRejectsInvalidWidth(t *testing.T) {
	root, path, catalog := previewFixture(t)
	svc, err := services.NewThumbnailService(services.ThumbnailOptions{
		CacheDir: filepath.Join(t.TempDir(), "thumbs"),
		LRUSize:  10,
	})
	if err != nil {
		t.Fatal(err)
	}
	app := previewTestApp(root, catalog, svc)
	id := catalog.ExternalID(path, services.ResourceFile)

	for _, query := range []string{"?w=abc", "?w=0", "?w=-5"} {
		res, err := app.Test(httptest.NewRequest(http.MethodGet, "/api/previews/"+id+query, nil))
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s status = %d, want 400", query, res.StatusCode)
		}
		if !strings.Contains(string(body), "invalid_preview_width") {
			t.Fatalf("%s 响应应带稳定 code, got %s", query, body)
		}
	}
}

// TestPreviewHandlerRejectsVideoResource 验证视频资源不能走预览图接口。
func TestPreviewHandlerRejectsVideoResource(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "clip.mp4")
	if err := os.WriteFile(path, []byte("video"), 0o644); err != nil {
		t.Fatal(err)
	}
	catalog := services.NewResourceCatalog()
	catalog.Publish(&models.ScanResult{
		Roots: []string{root},
		Collections: []models.Collection{{
			Path: root,
			Name: filepath.Base(root),
			Albums: []models.Album{{
				Path:       root,
				Name:       filepath.Base(root),
				VideoFiles: []string{path},
			}},
		}},
	}, []string{root})
	svc, err := services.NewThumbnailService(services.ThumbnailOptions{
		CacheDir: filepath.Join(t.TempDir(), "thumbs"),
		LRUSize:  10,
	})
	if err != nil {
		t.Fatal(err)
	}
	app := previewTestApp(root, catalog, svc)
	id := catalog.ExternalID(path, services.ResourceFile)
	res, err := app.Test(httptest.NewRequest(http.MethodGet, "/api/previews/"+id, nil))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want 415", res.StatusCode)
	}
}
