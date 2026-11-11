package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func TestRunServerGracefulShutdownFlushesRuntime(t *testing.T) {
	root := t.TempDir()
	cachePath := filepath.Join(t.TempDir(), "scan_cache.json")
	cache := services.NewScanResultCache(cachePath)
	cache.Set(&models.ScanResult{Roots: []string{root}})
	runner := services.NewAsyncScanRunner()
	transcode := services.NewTranscodeService(services.TranscodeOptions{
		CacheDir: t.TempDir(),
		FFmpeg:   "missing",
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := runServer(ctx, fiber.New(), "127.0.0.1:0", runner, transcode, cache, nil); err != nil {
		t.Fatalf("runServer: %v", err)
	}
	if _, err := os.Stat(cachePath); err != nil {
		t.Fatalf("scan cache was not flushed: %v", err)
	}
	if _, _, err := runner.StartOrReuse(services.ScanOptions{Roots: []string{root}}); err == nil {
		t.Fatal("scan runner accepted work after shutdown")
	}
	if _, status := transcode.Resolve("video.mp4", nil); status != services.TranscodeStatusUnavailable {
		t.Fatalf("transcode status after shutdown = %v", status)
	}
}
