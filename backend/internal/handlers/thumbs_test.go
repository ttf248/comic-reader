package handlers

import (
	"bytes"
	"image"
	"image/jpeg"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func TestThumbnailRevalidationAfterSizeChange(t *testing.T) {
	path := filepath.Join(t.TempDir(), "image.jpg")
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 80, 80)), nil); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, encoded.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	svc, err := services.NewThumbnailService(services.ThumbnailOptions{CacheDir: t.TempDir(), Width: 8, Height: 8})
	if err != nil {
		t.Fatal(err)
	}
	app := fiber.New()
	app.Get("/thumb", func(c *fiber.Ctx) error { c.Locals("safePath", path); return c.Next() }, ThumbHandler(svc))
	first, err := app.Test(httptest.NewRequest("GET", "/thumb", nil))
	if err != nil {
		t.Fatal(err)
	}
	first.Body.Close()
	if first.Header.Get("Cache-Control") != "private, no-cache" {
		t.Fatal("must revalidate stable URLs")
	}
	oldETag := first.Header.Get("ETag")
	if err := svc.UpdateOptions(services.ThumbnailOptions{Width: 32, Height: 32}); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "/thumb", nil)
	req.Header.Set("If-None-Match", oldETag)
	second, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(second.Body)
	second.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width != 32 || second.StatusCode != 200 || second.Header.Get("ETag") == oldETag {
		t.Fatalf("stale rendition: %+v %v", cfg, err)
	}
	req.Header.Set("If-None-Match", second.Header.Get("ETag"))
	third, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	third.Body.Close()
	if third.StatusCode != 304 {
		t.Fatalf("unchanged=%d", third.StatusCode)
	}
}
