package integration_test

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMediaIfRangeUsesCurrentRepresentation(t *testing.T) {
	for _, extension := range []string{".png", ".webm"} {
		t.Run(extension, func(t *testing.T) {
			h := newHarness(t)
			src := filepath.Join(h.root, "resume"+extension)
			original := []byte("original-video-content")
			if err := os.WriteFile(src, original, 0o644); err != nil {
				t.Fatal(err)
			}
			app, url := mediaUpdateRoute(t, h, src)
			first, _ := doHTTP(t, app, http.MethodGet, url)
			etag := first.Header.Get("ETag")
			modified := first.Header.Get("Last-Modified")
			for _, tc := range []struct {
				name, value string
				status      int
			}{
				{"without-validator", "", 206},
				{"current-etag", etag, 206},
				{"current-date", modified, 206},
				{"old-etag", `"old-representation"`, 200},
				{"weak-etag", "W/" + etag, 200},
				{"etag-list", `"old", ` + etag, 200},
				{"old-date", time.Now().Add(-time.Hour).UTC().Format(http.TimeFormat), 200},
				{"future-date", time.Now().Add(time.Hour).UTC().Format(http.TimeFormat), 200},
				{"invalid", "not-a-validator", 200},
			} {
				t.Run(tc.name, func(t *testing.T) {
					req := httptest.NewRequest(http.MethodGet, url, nil)
					req.Header.Set("Range", "bytes=3-6")
					if tc.value != "" {
						req.Header.Set("If-Range", tc.value)
					}
					response, body := readVideoCacheResponse(t, app, req)
					want := original
					if tc.status == http.StatusPartialContent {
						want = original[3:7]
					}
					if response.StatusCode != tc.status || !bytes.Equal(body, want) {
						t.Errorf("If-Range=%q: status=%d bytes=%d want status=%d bytes=%d", tc.value, response.StatusCode, len(body), tc.status, len(want))
					}
					if tc.status == http.StatusOK && response.Header.Get("Content-Range") != "" {
						t.Error("full representation retained a partial Content-Range")
					}
				})
			}
			t.Run("not-modified-takes-precedence", func(t *testing.T) {
				req := httptest.NewRequest(http.MethodGet, url, nil)
				req.Header.Set("If-None-Match", etag)
				req.Header.Set("If-Range", `"old-representation"`)
				req.Header.Set("Range", "bytes=999999-")
				response, body := readVideoCacheResponse(t, app, req)
				if response.StatusCode != http.StatusNotModified || len(body) != 0 {
					t.Errorf("cache precondition lost precedence: status=%d bytes=%d", response.StatusCode, len(body))
				}
				if response.Header.Get("Content-Range") != "" {
					t.Error("not-modified response retained a partial Content-Range")
				}
			})
			updated := []byte("updated-video-content-with-new-bytes")
			if err := os.WriteFile(src, updated, 0o644); err != nil {
				t.Fatal(err)
			}
			later := time.Now().Add(2 * time.Minute)
			if err := os.Chtimes(src, later, later); err != nil {
				t.Fatal(err)
			}
			for _, validator := range []string{etag, modified} {
				req := httptest.NewRequest(http.MethodGet, url, nil)
				req.Header.Set("Range", "bytes=5-")
				req.Header.Set("If-Range", validator)
				response, body := readVideoCacheResponse(t, app, req)
				if response.StatusCode != http.StatusOK || !bytes.Equal(body, updated) {
					t.Errorf("updated source can be spliced into old bytes: status=%d bytes=%d want=%d", response.StatusCode, len(body), len(updated))
				}
				// 过期 If-Range 必须先忽略 Range，不能返回范围错误。
				req = httptest.NewRequest(http.MethodGet, url, nil)
				req.Header.Set("Range", "bytes=999999-")
				req.Header.Set("If-Range", validator)
				response, body = readVideoCacheResponse(t, app, req)
				if response.StatusCode != http.StatusOK || !bytes.Equal(body, updated) {
					t.Errorf("stale If-Range evaluated invalid range: status=%d body=%s", response.StatusCode, body)
				}
			}
		})
	}
}
