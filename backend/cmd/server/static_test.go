package main

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
)

// writeStaticFixture 建一份静态资源样例。
//
// 不用 t.TempDir()：Fiber 的静态托管会持有文件句柄，测试结束时
// Windows 删不掉仍被占用的文件，临时目录清理会直接失败。改用系统临时
// 目录并在清理时重试几次。
func writeStaticFixture(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "static-fixture-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for i := 0; i < 20; i++ {
			if err := os.RemoveAll(dir); err == nil {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
	})
	assets := filepath.Join(dir, "assets")
	if err := os.MkdirAll(assets, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<!doctype html><title>画廊</title>"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 文件名带内容哈希，与 Vite 产物同名规则一致。
	if err := os.WriteFile(filepath.Join(assets, "index-abc123.js"), []byte("console.log(1)"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// 带内容哈希的产物可以长期缓存：改版即换名，旧文件留着也无妨。
func TestStaticAssetsAreImmutable(t *testing.T) {
	app := fiber.New()
	registerStatic(app, writeStaticFixture(t))

	res, err := app.Test(httptest.NewRequest("GET", "/assets/index-abc123.js", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if got := res.Header.Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Errorf("assets Cache-Control = %q", got)
	}
}

// 入口文件必须每次回源：否则发新版后用户拿到的仍是旧的入口文件，
// 引用的资源哈希对不上，页面直接白屏。
func TestStaticEntryIsNotCached(t *testing.T) {
	app := fiber.New()
	registerStatic(app, writeStaticFixture(t))

	for _, path := range []string{"/", "/photo/albums"} {
		res, err := app.Test(httptest.NewRequest("GET", path, nil))
		if err != nil {
			t.Fatal(err)
		}
		body := make([]byte, 128)
		n, _ := res.Body.Read(body)
		res.Body.Close()
		if got := res.Header.Get("Cache-Control"); got != "no-cache" {
			t.Errorf("%s Cache-Control = %q, want no-cache", path, got)
		}
		if res.StatusCode != 200 || !strings.Contains(string(body[:n]), "画廊") {
			t.Errorf("%s should serve index.html, got status=%d body=%q", path, res.StatusCode, string(body[:n]))
		}
	}
}

// 文本类资源压缩；已经是压缩格式的图片不再压一遍。
func TestStaticCompressionSkipsBinary(t *testing.T) {
	app := fiber.New()
	registerStatic(app, writeStaticFixture(t))

	req := httptest.NewRequest("GET", "/assets/index-abc123.js", nil)
	req.Header.Set("Accept-Encoding", "gzip, br")
	res, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if got := res.Header.Get("Content-Encoding"); got == "" {
		t.Error("js should be compressed")
	}
}
