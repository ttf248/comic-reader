package integration_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/config"
	"github.com/tianlongxiang/local-gallery/internal/handlers"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func findIntegrationFFmpeg(t testing.TB) string {
	t.Helper()
	path := os.Getenv("FFMPEG_PATH")
	if path == "" {
		bundled := filepath.Join("..", "..", config.DefaultFFmpegPath)
		if services.FFmpegAvailableAt(bundled) {
			path = bundled
		} else if found, err := exec.LookPath("ffmpeg"); err == nil {
			path = found
		}
	}
	if path == "" || !services.FFmpegAvailableAt(path) {
		t.Skip("ffmpeg not available; skipping tool-dependent integration test")
	}
	return path
}

func TestVideoInfoUsesFFmpegFallbackThroughRoutes(t *testing.T) {
	ffmpeg := findIntegrationFFmpeg(t)
	root := t.TempDir()
	path := filepath.Join(root, "clip.webm")
	// 合成 16×16、2 秒 VP8，与浏览器回归共用同一份微型素材。
	data, err := base64.StdEncoding.DecodeString("GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAJTEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggI97AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDFXQYxMYXZmNjMuMS4xMDFEiYhAn0AAAAAAABZUrmvXrgEAAAAAAABO14EBc8WIAN7+EvCpIL6cgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QdzWUA4JCwgRC6gRCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/pzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAxc3PVY8CLY8WIAN7+EvCpIL5nyKBFo4dFTkNPREVSRIeTTGF2YzYzLjEuMTAxIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDIuMDAwMDAwMDAwAB9DtnVAhueBAKO8gQAAgLACAJ0BKhAAEAAARwiFhYiFhIgCAgJ1qgP4Agz9KAD+/00S//xYV/FhX8WFf/FhX/z8zu3F/OYAo5WBAfQAsQEAARAQABgAGFgv9AAIAACjlYED6ACxAQABEBAAGAAYWC/0AAgAAKOVgQXcALEBAAEQEAAYABhYL/QACAAAHFO7a5G7j7OBALeK94EB8YIBsfCBAw==")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	catalog := services.NewResourceCatalog()
	catalog.Publish(&models.ScanResult{Roots: []string{root}, Albums: []models.Album{{Path: root, Name: "sample", VideoFiles: []string{path}}}}, []string{root})
	id := catalog.ExternalID(path, services.ResourceFile)
	info := services.NewVideoInfoService(services.VideoInfoOptions{FFmpegPath: ffmpeg, FFprobePath: filepath.Join(t.TempDir(), "missing-ffprobe")})
	transcode := services.NewTranscodeService(services.TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: ffmpeg, Info: info})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := transcode.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	app := fiber.New()
	_, safety := middleware.PathSafetyMiddleware([]string{root})
	app.Get("/api/videos/:id/info", middleware.ResourceParam(catalog, safety), handlers.VideoInfoHandler(info, transcode, catalog))
	app.Post("/api/videos/info/batch", handlers.VideoInfoBatchHandler(info, transcode, catalog, safety))
	type responseInfo struct {
		Path      string  `json:"path"`
		Width     int     `json:"width"`
		Height    int     `json:"height"`
		Duration  float64 `json:"duration"`
		Codec     string  `json:"codec"`
		Container string  `json:"container"`
		Transcode struct {
			Status string `json:"status"`
		} `json:"transcode"`
	}
	check := func(value responseInfo) {
		t.Helper()
		if value.Path != id || value.Width != 16 || value.Height != 16 || value.Duration < 1.9 || value.Duration > 2.1 || value.Codec != "vp8" || value.Container != "matroska,webm" || value.Transcode.Status != services.TranscodeStatusNotNeeded.String() {
			t.Fatalf("fallback metadata=%+v", value)
		}
	}
	res, body := doHTTP(t, app, http.MethodGet, "/api/videos/"+id+"/info")
	var single responseInfo
	if res.StatusCode != http.StatusOK || json.Unmarshal(body, &single) != nil {
		t.Fatalf("single status=%d body=%s", res.StatusCode, body)
	}
	check(single)
	payload, err := json.Marshal(map[string][]string{"ids": {id, id}})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/videos/info/batch", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	response, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var batch struct {
		Items []struct {
			Info responseInfo `json:"info"`
		} `json:"items"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&batch) != nil || len(batch.Items) != 2 {
		t.Fatalf("batch status=%d", response.StatusCode)
	}
	for _, item := range batch.Items {
		check(item.Info)
	}
}
