package handlers

import (
	"bytes"
	"image"
	"image/jpeg"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func writeThumbFixture(t *testing.T, size int) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "image.jpg")
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, size, size)), nil); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, encoded.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func newThumbApp(t *testing.T, path string) *fiber.App {
	t.Helper()
	svc, err := services.NewThumbnailService(services.ThumbnailOptions{CacheDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	app := fiber.New()
	app.Get("/thumb", func(c *fiber.Ctx) error { c.Locals("safePath", path); return c.Next() }, ThumbHandler(svc))
	return app
}

// 请求宽度会向上对齐到档位阶梯：320/640/1280/1920/2560/4096。
// 档位进 ETag，所以换一个档位就是另一个资源，条件请求不会误命中。
func TestThumbnailRenditionWidthBuckets(t *testing.T) {
	path := writeThumbFixture(t, 800)
	app := newThumbApp(t, path)

	small, err := app.Test(httptest.NewRequest("GET", "/thumb?w=32", nil))
	if err != nil {
		t.Fatal(err)
	}
	smallData, _ := io.ReadAll(small.Body)
	small.Body.Close()
	cfg, _, err := image.DecodeConfig(bytes.NewReader(smallData))
	if err != nil || cfg.Width != 320 {
		t.Fatalf("w=32 should snap to 320, got %+v (%v)", cfg, err)
	}
	smallETag := small.Header.Get("ETag")

	large, err := app.Test(httptest.NewRequest("GET", "/thumb?w=500", nil))
	if err != nil {
		t.Fatal(err)
	}
	largeData, _ := io.ReadAll(large.Body)
	large.Body.Close()
	cfg, _, err = image.DecodeConfig(bytes.NewReader(largeData))
	if err != nil || cfg.Width != 640 {
		t.Fatalf("w=500 should snap to 640, got %+v (%v)", cfg, err)
	}
	if large.Header.Get("ETag") == smallETag {
		t.Fatal("different widths must not share an ETag")
	}
}

// 带上的版本号与当前源文件一致时，响应可以被浏览器长期缓存；
// 不带或对不上时回到「每次重新验证」。
func TestThumbnailVersionedURLGetsImmutable(t *testing.T) {
	path := writeThumbFixture(t, 800)
	app := newThumbApp(t, path)

	version, err := services.MediaVersion(path)
	if err != nil {
		t.Fatal(err)
	}

	plain, err := app.Test(httptest.NewRequest("GET", "/thumb?w=320", nil))
	if err != nil {
		t.Fatal(err)
	}
	plain.Body.Close()
	if got := plain.Header.Get("Cache-Control"); got != "private, no-cache" {
		t.Fatalf("unversioned URL must revalidate, got %q", got)
	}

	versioned, err := app.Test(httptest.NewRequest("GET", "/thumb?w=320&v="+version, nil))
	if err != nil {
		t.Fatal(err)
	}
	versioned.Body.Close()
	if got := versioned.Header.Get("Cache-Control"); got != "private, max-age=31536000, immutable" {
		t.Fatalf("versioned URL must be immutable, got %q", got)
	}
	if versioned.Header.Get("ETag") != plain.Header.Get("ETag") {
		t.Fatal("same rendition must share one ETag")
	}

	stale, err := app.Test(httptest.NewRequest("GET", "/thumb?w=320&v=0-0-r0", nil))
	if err != nil {
		t.Fatal(err)
	}
	stale.Body.Close()
	if got := stale.Header.Get("Cache-Control"); got != "private, no-cache" {
		t.Fatalf("stale version must revalidate, got %q", got)
	}
}

// 条件请求只做一次 stat 与字符串比较：ETag 由内容版本与档位派生，
// 不需要先把整张图读进内存算哈希。
func TestThumbnailConditionalRequestHonoursRenditionETag(t *testing.T) {
	path := writeThumbFixture(t, 800)
	app := newThumbApp(t, path)

	first, err := app.Test(httptest.NewRequest("GET", "/thumb?w=320", nil))
	if err != nil {
		t.Fatal(err)
	}
	first.Body.Close()
	etag := first.Header.Get("ETag")

	req := httptest.NewRequest("GET", "/thumb?w=320", nil)
	req.Header.Set("If-None-Match", etag)
	second, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	second.Body.Close()
	if second.StatusCode != 304 {
		t.Fatalf("unchanged rendition should be 304, got %d", second.StatusCode)
	}

	// 换了档位，ETag 不匹配，必须回 200 与新内容。
	req = httptest.NewRequest("GET", "/thumb?w=640", nil)
	req.Header.Set("If-None-Match", etag)
	third, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(third.Body)
	third.Body.Close()
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width != 640 || third.StatusCode != 200 {
		t.Fatalf("stale rendition: %+v %v status=%d", cfg, err, third.StatusCode)
	}
}
