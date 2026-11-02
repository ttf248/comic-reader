package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/services"
)

// 缩略图与整图转换缓存必须能分别清理。
//
// 整图转换产物(HEIC/HEIF/TIFF 转 JPEG)单张可达 MB 级,和缩略图混在一个
// scope 里时,用户在设置页点「缩略图」的清理按钮,释放的字节数里会夹带
// 转换缓存,数字对不上自己点的那个分类。
func newCacheScopeService(t *testing.T) (*services.ThumbnailService, string, string) {
	t.Helper()
	root := t.TempDir()
	thumbDir := filepath.Join(root, "thumbnails")
	convertedDir := filepath.Join(root, "converted")
	for _, dir := range []string{thumbDir, convertedDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	thumbFile := filepath.Join(thumbDir, "0123456789abcdef0123456789abcdef.jpg")
	convertedFile := filepath.Join(convertedDir, "fedcba9876543210fedcba9876543210.jpg")
	if err := os.WriteFile(thumbFile, []byte("thumb"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(convertedFile, []byte("converted-image"), 0o644); err != nil {
		t.Fatal(err)
	}
	svc, err := services.NewThumbnailService(services.ThumbnailOptions{
		CacheDir:     thumbDir,
		ConvertedDir: convertedDir,
	})
	if err != nil {
		t.Fatal(err)
	}
	return svc, thumbFile, convertedFile
}

func TestCacheClearSeparatesThumbnailsAndConverted(t *testing.T) {
	for _, scope := range []string{"thumbs", "converted", "all"} {
		t.Run(scope, func(t *testing.T) {
			svc, thumbFile, convertedFile := newCacheScopeService(t)
			app := fiber.New()
			app.Post("/api/cache/clear", CacheClearHandler(svc, nil, nil, nil, nil))
			res, err := app.Test(httptest.NewRequest(http.MethodPost, "/api/cache/clear?scope="+scope, nil))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if res.StatusCode != http.StatusOK {
				t.Fatalf("status=%d", res.StatusCode)
			}
			var result CacheClearResult
			if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
				t.Fatal(err)
			}

			thumbExists := fileExists(thumbFile)
			convertedExists := fileExists(convertedFile)
			switch scope {
			case "thumbs":
				if thumbExists {
					t.Error("scope=thumbs 应删除缩略图缓存")
				}
				if !convertedExists {
					t.Error("scope=thumbs 不应删除整图转换缓存")
				}
				if result.Thumbs == nil || result.Thumbs.Deleted != 1 {
					t.Errorf("thumbs 子项=%+v, want deleted=1", result.Thumbs)
				}
				if result.Converted != nil {
					t.Errorf("scope=thumbs 不应返回 converted 子项: %+v", result.Converted)
				}
			case "converted":
				if convertedExists {
					t.Error("scope=converted 应删除整图转换缓存")
				}
				if !thumbExists {
					t.Error("scope=converted 不应删除缩略图缓存")
				}
				if result.Converted == nil || result.Converted.Deleted != 1 {
					t.Errorf("converted 子项=%+v, want deleted=1", result.Converted)
				}
				if result.Thumbs != nil {
					t.Errorf("scope=converted 不应返回 thumbs 子项: %+v", result.Thumbs)
				}
			case "all":
				if thumbExists || convertedExists {
					t.Error("scope=all 应删除两类缓存")
				}
				if result.Thumbs == nil || result.Converted == nil {
					t.Errorf("scope=all 应分别报告两类: %+v", result)
				}
				if result.TotalDeleted != 2 {
					t.Errorf("totalDeleted=%d, want 2", result.TotalDeleted)
				}
			}
		})
	}
}

// 无效 scope 必须被拒绝，且不能顺手清掉任何缓存。
func TestCacheClearRejectsUnknownScope(t *testing.T) {
	svc, thumbFile, convertedFile := newCacheScopeService(t)
	app := fiber.New()
	app.Post("/api/cache/clear", CacheClearHandler(svc, nil, nil, nil, nil))
	res, err := app.Test(httptest.NewRequest(http.MethodPost, "/api/cache/clear?scope=unknown", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400", res.StatusCode)
	}
	if !fileExists(thumbFile) || !fileExists(convertedFile) {
		t.Error("无效 scope 不应删除任何缓存文件")
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
