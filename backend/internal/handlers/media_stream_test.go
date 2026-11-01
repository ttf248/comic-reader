package handlers

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/valyala/fasthttp"
)

func TestMediaStreamRangeAndEarlyResponseReleaseFiles(t *testing.T) {
	src := filepath.Join(t.TempDir(), "stream.webm")
	data := bytes.Repeat([]byte("0123456789"), 2048)
	if err := os.WriteFile(src, data, 0o644); err != nil {
		t.Fatal(err)
	}
	app := fiber.New()
	app.Get("/media", func(c *fiber.Ctx) error {
		return serveMediaFile(c, src, "video/webm", "video_not_found")
	})
	first, err := app.Test(httptest.NewRequest(http.MethodGet, "/media", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	etag := first.Header.Get("ETag")
	io.Copy(io.Discard, first.Body)
	first.Body.Close()
	for _, tc := range []struct {
		name, method, header, value string
		status                      int
		body                        []byte
	}{
		{"head", http.MethodHead, "", "", 200, nil},
		{"bounded", http.MethodGet, "Range", "bytes=3-6", 206, data[3:7]},
		{"open-ended", http.MethodGet, "Range", "bytes=20000-", 206, data[20000:]},
		{"suffix", http.MethodGet, "Range", "bytes=-3", 206, data[len(data)-3:]},
		{"conditional", http.MethodGet, "If-None-Match", etag, 304, nil},
		{"invalid", http.MethodGet, "Range", "bytes=999999-", 416, nil},
		{"reversed", http.MethodGet, "Range", "bytes=6-3", 416, nil},
		{"empty-suffix", http.MethodGet, "Range", "bytes=-0", 416, nil},
		{"multiple", http.MethodGet, "Range", "bytes=0-1,4-5", 416, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "/media", nil)
			if tc.header != "" {
				req.Header.Set(tc.header, tc.value)
			}
			response, err := app.Test(req, -1)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil || response.StatusCode != tc.status {
				t.Fatalf("status=%d want=%d err=%v", response.StatusCode, tc.status, err)
			}
			if tc.status == 416 {
				if !bytes.Contains(body, []byte(`"code":"invalid_range"`)) || response.Header.Get("ETag") != "" {
					t.Fatalf("invalid Range response: headers=%v body=%s", response.Header, body)
				}
			} else if !bytes.Equal(body, tc.body) {
				t.Errorf("unexpected range body: bytes=%d want=%d", len(body), len(tc.body))
			}
			// 完整、HEAD、304 和错误路径都不得留下持有源文件的句柄。
			if err := os.Rename(src, src+".moved"); err != nil {
				t.Fatalf("response kept source open: %v", err)
			}
			if err := os.Rename(src+".moved", src); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMediaStreamAbortReleasesFileAndRedactsReadErrors(t *testing.T) {
	src := filepath.Join(t.TempDir(), "private.webm")
	if err := os.WriteFile(src, []byte("unread-response"), 0o644); err != nil {
		t.Fatal(err)
	}
	app := fiber.New()
	raw := &fasthttp.RequestCtx{}
	raw.Request.Header.SetMethod(http.MethodGet)
	c := app.AcquireCtx(raw)
	defer app.ReleaseCtx(c)
	if err := serveMediaFile(c, src, "video/webm", "video_not_found"); err != nil {
		t.Fatal(err)
	}
	reader := raw.Response.BodyStream()
	if err := raw.Response.CloseBodyStream(); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.Read(make([]byte, 1)); err == nil || strings.Contains(err.Error(), src) {
		t.Fatalf("closed stream exposed a local path: %v", err)
	}
	if err := os.Rename(src, src+".released"); err != nil {
		t.Fatalf("aborted response kept source open: %v", err)
	}
}
