package integration_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/handlers"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func TestMediaConditionalETagMatching(t *testing.T) {
	h := newHarness(t)
	imagePath := filepath.Join(h.root, "[作者A] vol1", "page1.png")
	videoPath := filepath.Join(h.root, "conditional.webm")
	if err := os.WriteFile(videoPath, []byte("temporary-video-content"), 0o600); err != nil {
		t.Fatal(err)
	}
	app, videoURL := mediaUpdateRoute(t, h, videoPath)
	_, validator := middleware.PathSafetyMiddleware([]string{h.root})
	thumbs, err := services.NewThumbnailService(services.ThumbnailOptions{CacheDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	app.Get("/api/thumbs/:id", middleware.ResourceParam(h.catalog, validator), handlers.ThumbHandler(thumbs))
	imageID := h.catalog.ExternalID(imagePath, services.ResourceFile)
	for _, resource := range []struct{ name, url string }{
		{"image", "/api/media/" + imageID},
		{"video", videoURL},
		{"thumbnail", "/api/thumbs/" + imageID},
	} {
		t.Run(resource.name, func(t *testing.T) {
			first, original := readVideoCacheResponse(t, app, httptest.NewRequest(http.MethodGet, resource.url, nil))
			etag := first.Header.Get("ETag")
			if first.StatusCode != http.StatusOK || len(original) == 0 || etag == "" {
				t.Fatalf("initial response: status=%d bytes=%d etag=%q", first.StatusCode, len(original), etag)
			}
			for _, method := range []string{http.MethodGet, http.MethodHead} {
				for _, tc := range []struct {
					name, value string
					match       bool
				}{
					{"strong", etag, true},
					{"weak", "W/" + etag, true},
					{"repeated-fields", "W/" + etag, true},
					{"first", etag + `, "other"`, true},
					{"middle", `"old", W/` + etag + `, "other"`, true},
					{"last", `"old", ` + etag, true},
					{"quoted-comma", `"old,version", ` + etag, true},
					{"empty-members", ", ,\t" + etag + ", ,", true},
					{"wildcard", "*", true},
					{"different", `W/"old", "other"`, false},
					{"unquoted", etag[1 : len(etag)-1], false},
				} {
					t.Run(method+"/"+tc.name, func(t *testing.T) {
						req := httptest.NewRequest(method, resource.url, nil)
						if tc.name == "repeated-fields" {
							req.Header.Add("If-None-Match", `"old"`)
						}
						req.Header.Add("If-None-Match", tc.value)
						// ETag 未命中时不得回退到较宽松的时间条件。
						req.Header.Set("If-Modified-Since", time.Now().Add(time.Hour).UTC().Format(http.TimeFormat))
						// 条件命中应先于 Range，避免发送无须重传的媒体字节。
						if resource.name != "thumbnail" {
							req.Header.Set("Range", "bytes=0-3")
						}
						response, body := readVideoCacheResponse(t, app, req)
						want := http.StatusOK
						if tc.match {
							want = http.StatusNotModified
						} else if resource.name != "thumbnail" {
							want = http.StatusPartialContent
						}
						if response.StatusCode != want {
							t.Errorf("If-None-Match=%q status=%d want=%d", tc.value, response.StatusCode, want)
						}
						if response.Header.Get("ETag") != etag || response.Header.Get("Cache-Control") != "private, no-cache" {
							t.Error("conditional response lost its current validator or cache policy")
						}
						if (tc.match || method == http.MethodHead) && len(body) != 0 {
							t.Errorf("conditional/HEAD response sent %d bytes", len(body))
						}
						if tc.match && response.Header.Get("Content-Range") != "" {
							t.Error("304 retained a partial content range")
						}
					})
				}
			}
		})
	}
	if err := os.Remove(imagePath); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(videoPath); err != nil {
		t.Fatal(err)
	}
	for _, url := range []string{"/api/media/" + imageID, videoURL, "/api/thumbs/" + imageID} {
		req := httptest.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("If-None-Match", "*")
		response, _ := readVideoCacheResponse(t, app, req)
		if response.StatusCode != http.StatusNotFound || response.Header.Get("ETag") != "" {
			t.Errorf("wildcard hid a missing source: status=%d etag=%q", response.StatusCode, response.Header.Get("ETag"))
		}
	}
}
