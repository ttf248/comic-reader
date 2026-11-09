package integration_test

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/handlers"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func TestMediaFileReplacedByDirectoryIsUnavailable(t *testing.T) {
	for _, extension := range []string{".png", ".mp4"} {
		t.Run(extension, func(t *testing.T) {
			h := newHarness(t)
			path := filepath.Join(h.root, "stale"+extension)
			if extension == ".png" {
				writePNG(t, path, 12, 12)
			} else if err := os.WriteFile(path, []byte("temporary-video"), 0o644); err != nil {
				t.Fatal(err)
			}
			result, err := services.NewScanner().Scan(services.ScanOptions{Roots: []string{h.root}})
			if err != nil {
				t.Fatal(err)
			}
			h.catalog.Publish(result, []string{h.root})
			id := h.catalog.ExternalID(path, services.ResourceFile)
			if id == "" {
				t.Fatal("fixture file was not indexed")
			}
			thumbs, err := services.NewThumbnailService(services.ThumbnailOptions{
				CacheDir: filepath.Join(h.cache, "type-change"), MaxAgeDays: 30,
			})
			if err != nil {
				t.Fatal(err)
			}
			cover, err := os.ReadFile(filepath.Join(h.root, "[作者A] vol1", "page1.png"))
			if err != nil {
				t.Fatal(err)
			}
			if extension == ".mp4" {
				if err := thumbs.SaveVideoCover(path, cover); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := thumbs.GetOrCreate(path, 320); err != nil {
				t.Fatal(err)
			}
			// 只替换当前夹具中的文件，原文件保留为同目录的普通文件。
			if err := os.Rename(path, filepath.Join(h.root, "original"+extension)); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(path, 0o755); err != nil {
				t.Fatal(err)
			}
			marker := []byte("<p>local-gallery-temporary-directory-index</p>")
			if err := os.WriteFile(filepath.Join(path, "index.html"), marker, 0o644); err != nil {
				t.Fatal(err)
			}
			_, validator := middleware.PathSafetyMiddleware([]string{h.root})
			app := fiber.New(fiber.Config{DisableStartupMessage: true})
			guard := middleware.ResourceParam(h.catalog, validator)
			app.Get("/api/media/:id", guard, handlers.MediaHandler(nil, nil, nil))
			app.Get("/api/images/:id/info", guard, handlers.ImageInfoHandler(h.catalog))
			app.Get("/api/videos/:id/info", guard, handlers.VideoInfoHandler(nil, nil, h.catalog))
			app.Get("/api/thumbs/:id", guard, handlers.ThumbHandler(thumbs))
			app.Post("/api/thumbs/:id/cover", guard, handlers.ThumbCoverHandler(thumbs))
			infoURL := "/api/images/" + id + "/info"
			if extension == ".mp4" {
				infoURL = "/api/videos/" + id + "/info"
			}
			for _, url := range []string{"/api/media/" + id, "/api/media/" + id + "/", infoURL, "/api/thumbs/" + id} {
				response, err := app.Test(httptest.NewRequest(http.MethodGet, url, nil), -1)
				if err != nil {
					t.Fatal(err)
				}
				body, err := io.ReadAll(response.Body)
				response.Body.Close()
				if err != nil {
					t.Fatal(err)
				}
				if response.StatusCode != http.StatusNotFound {
					t.Errorf("directory returned through file API: url=%s status=%d contentType=%s location=%q body=%s", url, response.StatusCode, response.Header.Get("Content-Type"), response.Header.Get("Location"), body)
				}
				if url == "/api/thumbs/"+id && !bytes.Contains(body, []byte(`"code":"source_not_found"`)) {
					t.Errorf("directory treated as a retriable cover miss: %s", body)
				}
			}
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			conditional := httptest.NewRequest(http.MethodGet, "/api/media/"+id, nil)
			conditional.Header.Set("If-None-Match", fmt.Sprintf(`"%x-%x"`, info.ModTime().UnixNano(), info.Size()))
			response, err := app.Test(conditional, -1)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != http.StatusNotFound || response.Header.Get("ETag") != "" {
				t.Errorf("directory passed cache negotiation: status=%d etag=%q", response.StatusCode, response.Header.Get("ETag"))
			}
			if extension == ".mp4" {
				request := httptest.NewRequest(http.MethodPost, "/api/thumbs/"+id+"/cover", bytes.NewReader(cover))
				request.Header.Set("Content-Type", "image/png")
				response, err := app.Test(request, -1)
				if err != nil {
					t.Fatal(err)
				}
				response.Body.Close()
				if response.StatusCode != http.StatusNotFound {
					t.Errorf("directory accepted video cover upload: status=%d", response.StatusCode)
				}
			}
			if err := os.Rename(path, filepath.Join(h.root, "invalid-directory"+extension)); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(filepath.Join(h.root, "original"+extension), path); err != nil {
				t.Fatal(err)
			}
			restored := httptest.NewRequest(http.MethodGet, "/api/media/"+id, nil)
			restored.Header.Set("Range", "bytes=0-3")
			response, err = app.Test(restored, -1)
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil || response.StatusCode != http.StatusPartialContent || len(data) != 4 {
				t.Fatalf("restored file did not recover: status=%d bytes=%d err=%v", response.StatusCode, len(data), err)
			}
		})
	}
}
