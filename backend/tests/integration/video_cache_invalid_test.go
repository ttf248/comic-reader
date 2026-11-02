package integration_test

import (
	"context"
	"fmt"
	"io"
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

func TestVideoStreamInvalidCacheFallsBackAndRebuilds(t *testing.T) {
	ffmpeg := findIntegrationFFmpeg(t)
	for _, pipeline := range []string{"faststart", "transcode"} {
		for _, kind := range []string{"empty", "directory"} {
			t.Run(pipeline+"/"+kind, func(t *testing.T) {
				h := newHarness(t)
				src := filepath.Join(h.root, "cache-fault.mp4")
				mustRun(t, ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x120:d=1:r=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "-faststart", src)
				var faststart *services.VideoFaststartService
				var transcode *services.TranscodeService
				var cachePath string
				if pipeline == "faststart" {
					faststart = services.NewVideoFaststartService(services.FaststartOptions{CacheDir: h.cache, FFmpeg: ffmpeg})
					var status services.FaststartStatus
					cachePath, status = faststart.Resolve(src, nil)
					if status != services.StatusRemuxed || cachePath == src {
						t.Fatalf("could not prepare faststart cache: %v", status)
					}
				} else {
					transcode = services.NewTranscodeService(services.TranscodeOptions{CacheDir: h.cache, FFmpeg: ffmpeg})
					t.Cleanup(func() {
						ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
						defer cancel()
						if err := transcode.Shutdown(ctx); err != nil {
							t.Error(err)
						}
					})
					transcode.Resolve(src, nil)
					waitForVideoCacheStatus(t, transcode, src, services.TranscodeStatusCached)
					cachePath, _ = transcode.Resolve(src, nil)
				}
				if kind == "empty" {
					if err := os.Truncate(cachePath, 0); err != nil {
						t.Fatal(err)
					}
				} else {
					if err := os.Rename(cachePath, cachePath+".original"); err != nil {
						t.Fatal(err)
					}
					if err := os.Mkdir(cachePath, 0o755); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(filepath.Join(cachePath, "index.html"), []byte("preserve-directory-content"), 0o644); err != nil {
						t.Fatal(err)
					}
				}
				invalidInfo, err := os.Stat(cachePath)
				if err != nil {
					t.Fatal(err)
				}
				badETag := fmt.Sprintf(`"%x-%x"`, invalidInfo.ModTime().UnixNano(), invalidInfo.Size())
				result, err := services.NewScanner().Scan(services.ScanOptions{Roots: []string{h.root}})
				if err != nil {
					t.Fatal(err)
				}
				h.catalog.Publish(result, []string{h.root})
				id := h.catalog.ExternalID(src, services.ResourceFile)
				_, validator := middleware.PathSafetyMiddleware([]string{h.root})
				app := fiber.New(fiber.Config{DisableStartupMessage: true})
				app.Get("/api/media/:id", middleware.ResourceParam(h.catalog, validator), handlers.MediaHandler(transcode, faststart, nil))
				url := "/api/media/" + id
				conditional := httptest.NewRequest(http.MethodGet, url, nil)
				conditional.Header.Set("If-None-Match", badETag)
				response, body := readVideoCacheResponse(t, app, conditional)
				if response.StatusCode != http.StatusOK || len(body) == 0 || response.Header.Get("Location") != "" {
					t.Fatalf("invalid cache affected conditional response: status=%d location=%q bytes=%d", response.StatusCode, response.Header.Get("Location"), len(body))
				}
				if transcode != nil {
					want := services.TranscodeStatusCached
					if kind == "directory" {
						want = services.TranscodeStatusFailed
					}
					waitForVideoCacheStatus(t, transcode, src, want)
				}
				ranged := httptest.NewRequest(http.MethodGet, url, nil)
				ranged.Header.Set("Range", "bytes=0-31")
				response, body = readVideoCacheResponse(t, app, ranged)
				if response.StatusCode != http.StatusPartialContent || len(body) != 32 || response.Header.Get("Location") != "" {
					t.Fatalf("invalid cache affected Range: status=%d location=%q bytes=%d", response.StatusCode, response.Header.Get("Location"), len(body))
				}
				if kind == "directory" {
					if data, err := os.ReadFile(filepath.Join(cachePath, "index.html")); err != nil || string(data) != "preserve-directory-content" {
						t.Fatalf("cache directory content changed: data=%q err=%v", data, err)
					}
				} else if fi, err := os.Stat(cachePath); err != nil || !fi.Mode().IsRegular() || fi.Size() == 0 {
					t.Fatalf("empty cache was not rebuilt: info=%v err=%v", fi, err)
				}
			})
		}
	}
}

func waitForVideoCacheStatus(t *testing.T, svc *services.TranscodeService, path string, want services.TranscodeStatus) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if svc.GetStatus(path).Status == want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("transcode state did not reach %v: %+v", want, svc.GetStatus(path))
}

func readVideoCacheResponse(t *testing.T, app *fiber.App, req *http.Request) (*http.Response, []byte) {
	t.Helper()
	response, err := app.Test(req, -1)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	return response, body
}
