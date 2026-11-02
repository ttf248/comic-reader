package integration_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/handlers"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func TestTranscodeCurrentVersionCacheOverridesOldFailure(t *testing.T) {
	ffmpeg := findIntegrationFFmpeg(t)
	h := newHarness(t)
	src := filepath.Join(h.root, "versioned.mp4")
	mustRun(t, ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x120:d=1:r=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", src)
	opts := services.TranscodeOptions{CacheDir: h.cache, FFmpeg: ffmpeg}
	current := services.NewTranscodeService(opts)
	t.Cleanup(func() { shutdownVersionService(t, current) })
	current.Resolve(src, nil)
	waitForVideoCacheStatus(t, current, src, services.TranscodeStatusCached)
	oldCache, _ := current.Resolve(src, nil)
	if err := os.Rename(oldCache, oldCache+".prepared"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(oldCache, 0o755); err != nil {
		t.Fatal(err)
	}
	current.Resolve(src, nil)
	waitForVideoCacheStatus(t, current, src, services.TranscodeStatusFailed)
	if err := os.Rename(oldCache, oldCache+".blocker"); err != nil {
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
	guard := middleware.ResourceParam(h.catalog, validator)
	app.Get("/api/media/:id", guard, handlers.MediaHandler(current, nil, nil))
	app.Get("/api/videos/:id/transcode/status", guard, handlers.TranscodeStatusHandler(current))
	app.Get("/api/videos/:id/transcode/events", guard, handlers.TranscodeEventsHandler(current))
	for _, mode := range []string{"same", "mtime", "size"} {
		t.Run(mode, func(t *testing.T) {
			if mode == "mtime" {
				future := time.Now().Add(time.Minute)
				if err := os.Chtimes(src, future, future); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "size" {
				previous, err := os.Stat(src)
				if err != nil {
					t.Fatal(err)
				}
				f, err := os.OpenFile(src, os.O_APPEND|os.O_WRONLY, 0o644)
				if err != nil {
					t.Fatal(err)
				}
				_, writeErr := f.Write([]byte{0, 0, 0, 8, 'f', 'r', 'e', 'e'})
				closeErr := f.Close()
				if writeErr != nil || closeErr != nil {
					t.Fatalf("append MP4 free box: write=%v close=%v", writeErr, closeErr)
				}
				if err := os.Chtimes(src, previous.ModTime(), previous.ModTime()); err != nil {
					t.Fatal(err)
				}
			}
			// 用独立实例生成当前版本产物，模拟缓存恢复或其他实例完成生成。
			producer := services.NewTranscodeService(opts)
			defer shutdownVersionService(t, producer)
			producer.Resolve(src, nil)
			waitForVideoCacheStatus(t, producer, src, services.TranscodeStatusCached)
			if status := current.GetStatus(src); status.Status != services.TranscodeStatusCached {
				t.Fatalf("old task hid current version: %+v", status)
			}
			base := "/api/videos/" + id + "/transcode"
			response, body := doHTTP(t, app, http.MethodGet, base+"/status")
			if response.StatusCode != http.StatusOK || !strings.Contains(string(body), `"status":"cached"`) {
				t.Fatalf("status query did not use current cache: %d %s", response.StatusCode, body)
			}
			_, body = doHTTP(t, app, http.MethodGet, base+"/events")
			if strings.Count(string(body), "event: done\n") != 1 || !strings.Contains(string(body), `"status":"cached"`) {
				t.Fatalf("SSE did not use current cache: %s", body)
			}
			req := httptest.NewRequest(http.MethodGet, "/api/media/"+id, nil)
			req.Header.Set("Range", "bytes=0-31")
			response, body = readVideoCacheResponse(t, app, req)
			if response.StatusCode != http.StatusPartialContent || len(body) != 32 {
				t.Fatalf("current cache playback failed: status=%d bytes=%d", response.StatusCode, len(body))
			}
		})
	}
}

func shutdownVersionService(t *testing.T, svc *services.TranscodeService) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := svc.Shutdown(ctx); err != nil {
		t.Error(err)
	}
}
