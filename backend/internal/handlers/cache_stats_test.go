package handlers

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/config"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

// 媒体派生缓存的占用要和「可清理的五类」对得上。
//
// totalBytes 统计的是整棵 derived/ 子树，里面还有 AI 分析产物与媒体
// 尺寸缓存；用户看到的「媒体缓存占多少」必须用 mediaBytes，否则数字
// 与「一键全清」能释放的字节对不上账。
func TestCacheStatsSeparatesMediaBytesFromDerivedTotal(t *testing.T) {
	root := t.TempDir()
	cacheDir := filepath.Join(root, "cache")
	derived := filepath.Join(cacheDir, "derived")
	thumbFile := filepath.Join(derived, "thumbnails", "0123456789abcdef0123456789abcdef.jpg")
	previewFile := filepath.Join(derived, "previews", "aaaabbbbccccddddeeeeffff00001111.jpg")
	analysisFile := filepath.Join(derived, "metadata", "ocr", "batches", "job", "00000001.json")
	for _, file := range []string{thumbFile, previewFile, analysisFile} {
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("data"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	cfg := config.Default()
	cfg.CacheDir = cacheDir
	manager := config.NewManagerWith(cfg, "")
	stats := services.NewCacheStatsService(0)

	app := fiber.New()
	app.Get("/api/cache/stats", CacheStatsHandler(manager, stats))
	response, err := app.Test(httptest.NewRequest("GET", "/api/cache/stats", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	var body CacheStatsResponse
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.MediaBytes != int64(2*len("data")) {
		t.Fatalf("media bytes = %d", body.MediaBytes)
	}
	if body.MediaFileCount != 2 {
		t.Fatalf("media file count = %d", body.MediaFileCount)
	}
	if body.TotalBytes != int64(3*len("data")) {
		t.Fatalf("total bytes = %d", body.TotalBytes)
	}
	if body.FileCount != 3 {
		t.Fatalf("total file count = %d", body.FileCount)
	}
}
