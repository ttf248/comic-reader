package integration_test

import (
	"context"
	"encoding/json"
	"net/http"
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

func TestTranscodeEventReplayMatchesCurrentStatus(t *testing.T) {
	ffmpeg := findIntegrationFFmpeg(t)
	h := newHarness(t)
	src := filepath.Join(h.root, "transcode-events.mp4")
	mustRun(t, ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x120:d=1:r=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", src)
	opts := services.TranscodeOptions{CacheDir: h.cache, FFmpeg: ffmpeg}
	warm := services.NewTranscodeService(opts)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := warm.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	warm.Resolve(src, nil)
	waitForVideoCacheStatus(t, warm, src, services.TranscodeStatusCached)
	cachePath, _ := warm.Resolve(src, nil)
	result, err := services.NewScanner().Scan(services.ScanOptions{Roots: []string{h.root}})
	if err != nil {
		t.Fatal(err)
	}
	h.catalog.Publish(result, []string{h.root})
	id := h.catalog.ExternalID(src, services.ResourceFile)
	_, validator := middleware.PathSafetyMiddleware([]string{h.root})
	fresh := services.NewTranscodeService(opts)
	nativeOpts := opts
	nativeOpts.Info = services.NewVideoInfoService(services.VideoInfoOptions{FFmpegPath: ffmpeg})
	native := services.NewTranscodeService(nativeOpts)
	unavailable := services.NewTranscodeService(services.TranscodeOptions{CacheDir: h.cache})
	for _, tc := range []struct {
		name   string
		svc    *services.TranscodeService
		status services.TranscodeStatus
	}{
		{"completed", warm, services.TranscodeStatusCached},
		{"disk-cache", fresh, services.TranscodeStatusCached},
		{"empty-cache", warm, services.TranscodeStatusFailed},
		{"directory-cache", warm, services.TranscodeStatusFailed},
		{"native", native, services.TranscodeStatusNotNeeded},
		{"unavailable", unavailable, services.TranscodeStatusUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "empty-cache" {
				if err := os.Truncate(cachePath, 0); err != nil {
					t.Fatal(err)
				}
			}
			if tc.name == "directory-cache" {
				if err := os.Rename(cachePath, cachePath+".empty"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(cachePath, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			want := tc.svc.GetStatus(src)
			if want.Status != tc.status {
				t.Fatalf("status fixture: got %+v, want %v", want, tc.status)
			}
			app := fiber.New(fiber.Config{DisableStartupMessage: true})
			guard := middleware.ResourceParam(h.catalog, validator)
			app.Get("/api/videos/:id/transcode/status", guard, handlers.TranscodeStatusHandler(tc.svc))
			app.Get("/api/videos/:id/transcode/events", guard, handlers.TranscodeEventsHandler(tc.svc))
			url := "/api/videos/" + id + "/transcode"
			for range 2 {
				response, body := doHTTP(t, app, http.MethodGet, url+"/events")
				if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
					t.Fatalf("SSE response: status=%d body=%s", response.StatusCode, body)
				}
				var eventNames []string
				var payloads []string
				for _, line := range strings.Split(string(body), "\n") {
					if strings.HasPrefix(line, "event: ") {
						eventNames = append(eventNames, strings.TrimPrefix(line, "event: "))
					}
					if strings.HasPrefix(line, "data: ") {
						payloads = append(payloads, strings.TrimPrefix(line, "data: "))
					}
				}
				if len(eventNames) != 1 || eventNames[0] != "done" || len(payloads) != 1 {
					t.Fatalf("terminal replay must contain one typed done event: %s", body)
				}
				type statusData struct {
					Status   string  `json:"status"`
					Progress float64 `json:"progress"`
					EtaSec   int     `json:"etaSec"`
					Error    string  `json:"error"`
				}
				var event, query statusData
				if err := json.Unmarshal([]byte(payloads[0]), &event); err != nil {
					t.Fatal(err)
				}
				_, queryBody := doHTTP(t, app, http.MethodGet, url+"/status")
				if err := json.Unmarshal(queryBody, &query); err != nil {
					t.Fatal(err)
				}
				if event != query || event.Status != want.Status.String() {
					t.Fatalf("SSE=%+v status=%+v, expected %v", event, query, want.Status)
				}
			}
		})
	}
}
