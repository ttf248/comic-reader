package integration_test

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/handlers"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func TestMediaInPlaceUpdateUsesCurrentBytesAndLength(t *testing.T) {
	for _, extension := range []string{".png", ".webm"} {
		t.Run(extension, func(t *testing.T) {
			h := newHarness(t)
			src := filepath.Join(h.root, "updated"+extension)
			if err := os.WriteFile(src, []byte("original-media-content"), 0o644); err != nil {
				t.Fatal(err)
			}
			app, url := mediaUpdateRoute(t, h, src)
			first, _ := doHTTP(t, app, http.MethodGet, url)
			originalETag := first.Header.Get("ETag")
			for _, data := range [][]byte{bytes.Repeat([]byte("updated-content"), 1024), []byte("small")} {
				if err := os.WriteFile(src, data, 0o644); err != nil {
					t.Fatal(err)
				}
				modified := time.Now().Add(time.Hour)
				if err := os.Chtimes(src, modified, modified); err != nil {
					t.Fatal(err)
				}
				response, body := doHTTP(t, app, http.MethodGet, url)
				if response.StatusCode != http.StatusOK || !bytes.Equal(body, data) || response.ContentLength != int64(len(data)) {
					t.Errorf("updated response: status=%d length=%d bytes=%d want=%d", response.StatusCode, response.ContentLength, len(body), len(data))
				}
				if response.Header.Get("ETag") == originalETag {
					t.Error("updated source reused old ETag")
				}
				fi, err := os.Stat(src)
				if err != nil {
					t.Fatal(err)
				}
				if got := response.Header.Get("Last-Modified"); got != fi.ModTime().UTC().Format(http.TimeFormat) {
					t.Errorf("updated source reused old Last-Modified: %q", got)
				}
				req := httptest.NewRequest(http.MethodGet, url, nil)
				req.Header.Set("Range", "bytes=-3")
				response, body = readVideoCacheResponse(t, app, req)
				if response.StatusCode != http.StatusPartialContent || !bytes.Equal(body, data[len(data)-3:]) {
					t.Errorf("tail Range used stale size: status=%d body=%q", response.StatusCode, body)
				}
				if got, want := response.Header.Get("Content-Range"), fmt.Sprintf("bytes %d-%d/%d", len(data)-3, len(data)-1, len(data)); got != want {
					t.Errorf("Content-Range=%q want %q", got, want)
				}
			}
		})
	}
}

func TestMediaResponseDoesNotLockSourceAfterCompletion(t *testing.T) {
	h := newHarness(t)
	src := filepath.Join(h.root, "replaceable.webm")
	if err := os.WriteFile(src, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	app, url := mediaUpdateRoute(t, h, src)
	doHTTP(t, app, http.MethodGet, url)
	if err := os.Rename(src, src+".original"); err != nil {
		t.Fatalf("completed response retained a file handle: %v", err)
	}
	data := []byte("new-replacement-content")
	if err := os.WriteFile(src, data, 0o644); err != nil {
		t.Fatal(err)
	}
	response, body := doHTTP(t, app, http.MethodGet, url)
	if response.StatusCode != http.StatusOK || !bytes.Equal(body, data) {
		t.Errorf("replacement source was not served: status=%d bytes=%d", response.StatusCode, len(body))
	}
}

func mediaUpdateRoute(t *testing.T, h *harness, src string) (*fiber.App, string) {
	t.Helper()
	result, err := services.NewScanner().Scan(services.ScanOptions{Roots: []string{h.root}})
	if err != nil {
		t.Fatal(err)
	}
	h.catalog.Publish(result, []string{h.root})
	id := h.catalog.ExternalID(src, services.ResourceFile)
	_, validator := middleware.PathSafetyMiddleware([]string{h.root})
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Get("/api/media/:id", middleware.ResourceParam(h.catalog, validator), handlers.MediaHandler(nil, nil))
	return app, "/api/media/" + id
}
