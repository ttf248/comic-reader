package integration_test

import (
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

func TestStableMediaURLAlwaysRevalidates(t *testing.T) {
	for _, extension := range []string{".png", ".webm"} {
		t.Run(extension, func(t *testing.T) { testStableMediaCachePolicy(t, extension) })
	}
}

func testStableMediaCachePolicy(t *testing.T, extension string) {
	t.Helper()
	h := newHarness(t)
	src := filepath.Join(h.root, "cache-policy"+extension)
	if err := os.WriteFile(src, []byte("temporary-video-content"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := services.NewScanner().Scan(services.ScanOptions{Roots: []string{h.root}})
	if err != nil {
		t.Fatal(err)
	}
	h.catalog.Publish(result, []string{h.root})
	id := h.catalog.ExternalID(src, services.ResourceFile)
	_, validator := middleware.PathSafetyMiddleware([]string{h.root})
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Get("/api/media/:id", middleware.ResourceParam(h.catalog, validator), handlers.MediaHandler(nil, nil, nil))
	url := "/api/media/" + id
	first, body := doHTTP(t, app, http.MethodGet, url)
	if first.StatusCode != http.StatusOK || string(body) != "temporary-video-content" {
		t.Fatalf("first response: status=%d body=%s", first.StatusCode, body)
	}
	etag := first.Header.Get("ETag")
	if etag == "" {
		t.Fatal("video response has no ETag")
	}
	for _, tc := range []struct {
		name          string
		header        string
		value         string
		status        int
		modifiedSince bool
	}{
		{"full", "", "", http.StatusOK, false},
		{"range", "Range", "bytes=0-3", http.StatusPartialContent, false},
		{"conditional", "If-None-Match", etag, http.StatusNotModified, false},
		{"playback-id", "", "", http.StatusOK, false},
		{"modified-since", "", "", http.StatusNotModified, true},
		{"etag-miss-with-modified-since", "If-None-Match", `"old-version"`, http.StatusOK, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			requestURL := url
			if tc.name == "playback-id" {
				requestURL += "?playback=attempt%2B%2F"
			}
			req := httptest.NewRequest(http.MethodGet, requestURL, nil)
			if tc.header != "" {
				req.Header.Set(tc.header, tc.value)
			}
			if tc.modifiedSince {
				req.Header.Set("If-Modified-Since", time.Now().Add(24*time.Hour).UTC().Format(http.TimeFormat))
			}
			response, body := readVideoCacheResponse(t, app, req)
			if response.StatusCode != tc.status {
				t.Fatalf("status=%d want %d", response.StatusCode, tc.status)
			}
			policy := "private, no-cache"
			if got := response.Header.Get("Cache-Control"); got != policy {
				t.Errorf("stable media URL can bypass validation: policy=%q want %q", got, policy)
			}
			if response.Header.Get("ETag") != etag {
				t.Error("unchanged video lost its validator")
			}
			if tc.status == http.StatusPartialContent && len(body) != 4 {
				t.Errorf("Range returned %d bytes", len(body))
			}
			if tc.status == http.StatusNotModified && len(body) != 0 {
				t.Errorf("304 returned %d bytes", len(body))
			}
		})
	}
}
