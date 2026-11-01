package middleware

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func TestValidatePathMulti(t *testing.T) {
	root, _ := filepath.Abs("/safe/root")

	cases := []struct {
		name    string
		path    string
		wantErr bool
	}{
		{"inside", filepath.Join(root, "sub", "a.png"), false},
		{"exact root", root, false},
		{"relative", "sub/a.png", true},
		{"escape", filepath.Join(root, "..", "evil.png"), true},
		{"prefix-attack", "/safe/root-other/x.png", true},
		{"empty", "", true},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := validatePathMulti([]string{root}, c.path)
			if (err != nil) != c.wantErr {
				t.Fatalf("path=%q err=%v wantErr=%v", c.path, err, c.wantErr)
			}
		})
	}
}

// 多根：path 在任一根之下即放行。
func TestValidatePathMulti_MultipleRoots(t *testing.T) {
	dir1 := t.TempDir()
	dir2 := t.TempDir()
	abs1, _ := filepath.Abs(dir1)
	abs2, _ := filepath.Abs(dir2)

	roots := []string{abs1, abs2}

	// dir1 子路径
	if _, err := validatePathMulti(roots, filepath.Join(abs1, "a.png")); err != nil {
		t.Errorf("dir1 path should pass: %v", err)
	}
	// dir2 子路径
	if _, err := validatePathMulti(roots, filepath.Join(abs2, "b.jpg")); err != nil {
		t.Errorf("dir2 path should pass: %v", err)
	}
	// 其他目录应被拒绝
	other := t.TempDir()
	absOther, _ := filepath.Abs(other)
	if _, err := validatePathMulti(roots, filepath.Join(absOther, "x.png")); err == nil {
		t.Error("path outside all roots should be rejected")
	}
}

func TestBlankRootUpdatesNeverAuthorizeWorkingDirectory(t *testing.T) {
	root := t.TempDir()
	_, validator := PathSafetyMiddleware([]string{root})
	if _, err := validator.Validate(filepath.Join(root, "page.png")); err != nil {
		t.Fatal(err)
	}
	validator.SetRoots([]string{"", " ", "\t"})
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(cwd, "page.png"), filepath.Join(root, "page.png")} {
		if _, err := validator.Validate(path); err == nil {
			t.Fatal("blank roots retained or implicitly created filesystem authorization")
		}
	}
}

func TestOpenInOS_Empty(t *testing.T) {
	if err := OpenInOS(""); err == nil {
		t.Fatal("want error for empty path")
	}
}

func TestOpenInOS_NotExist(t *testing.T) {
	if err := OpenInOS("/this/path/does/not/exist/zzz"); err == nil {
		t.Fatal("want error for missing path")
	}
}

// 跳过需要图形界面的真实打开调用（CI/headless 环境）。
func TestOpenInOS_SkipReal(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("不实际启动 explorer")
	}
}

// 验证中间件可以通过 SetRoots 热更新根集合，无需重启 Fiber app。
func TestPathSafetyMiddleware_HotReload(t *testing.T) {
	dir1 := t.TempDir()
	dir2 := t.TempDir()
	abs1, _ := filepath.Abs(dir1)
	abs2, _ := filepath.Abs(dir2)

	mw, state := PathSafetyMiddleware([]string{abs1})
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(mw)
	app.Get("/x", func(c *fiber.Ctx) error {
		return c.SendString("ok")
	})

	// 第一次：dir2 下的路径应被拒绝
	res, _ := app.Test(httptest.NewRequest("GET", "/x?path="+filepath.Join(abs2, "a.png"), nil), -1)
	if res.StatusCode != 400 {
		t.Fatalf("dir2 path should be rejected, got %d", res.StatusCode)
	}

	// 热更新根到 dir2（替换）
	state.SetRoots([]string{abs2})

	// 再次请求同一 URL：现在应通过
	res2, _ := app.Test(httptest.NewRequest("GET", "/x?path="+filepath.Join(abs2, "a.png"), nil), -1)
	if res2.StatusCode == 400 {
		t.Fatalf("dir2 path should pass after hot reload, got %d", res2.StatusCode)
	}
	// dir1 的旧路径现在应被拒绝
	res3, _ := app.Test(httptest.NewRequest("GET", "/x?path="+filepath.Join(abs1, "a.png"), nil), -1)
	if res3.StatusCode != 400 {
		t.Fatalf("dir1 path should now be rejected, got %d", res3.StatusCode)
	}
}

// 验证 SetRoots 接受多根，path 在任一根之下即放行。
func TestPathSafetyMiddleware_MultiRoots(t *testing.T) {
	dir1 := t.TempDir()
	dir2 := t.TempDir()
	abs1, _ := filepath.Abs(dir1)
	abs2, _ := filepath.Abs(dir2)

	mw, _ := PathSafetyMiddleware([]string{abs1, abs2})
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(mw)
	app.Get("/x", func(c *fiber.Ctx) error {
		return c.SendString("ok")
	})

	// 两个根的子路径都应通过
	for _, root := range []string{abs1, abs2} {
		res, _ := app.Test(httptest.NewRequest("GET", "/x?path="+filepath.Join(root, "a.png"), nil), -1)
		if res.StatusCode == 400 {
			t.Errorf("path under %s should pass with multi-root config", root)
		}
	}
}
