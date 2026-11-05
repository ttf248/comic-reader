package integration_test

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/valyala/fasthttp"

	"github.com/tianlongxiang/local-gallery/internal/config"
	"github.com/tianlongxiang/local-gallery/internal/handlers"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func directoryPickerApp(cfg *config.Config) (*fiber.App, *config.Manager) {
	mgr := config.NewManagerWith(cfg, "")
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	gate := middleware.NewAccessGate(mgr.Get)
	safety, _ := middleware.PathSafetyMiddleware(cfg.Roots())
	api := app.Group("/api", gate.Middleware(), safety)
	api.Post("/admin/fs/directories", middleware.LoopbackOnly(), handlers.DirectoriesHandler())
	api.Put("/config", middleware.LoopbackOnly(), handlers.ConfigUpdateHandler(mgr, nil))
	return app, mgr
}

func TestDirectoryPickerBrowsesAndSavesExactSelection(t *testing.T) {
	cfg := config.Default()
	cfg.MediaRoots = []config.MediaRoot{{Path: t.TempDir(), Kind: config.DefaultMediaRootKind}}
	cfg.CacheDir = t.TempDir()
	cfg.StaticDir = ""
	app, mgr := directoryPickerApp(cfg)
	outside := t.TempDir()
	selected := filepath.Join(outside, "照片 [100%] #")
	if err := os.Mkdir(selected, 0755); err != nil {
		t.Fatal(err)
	}
	response, body := doHTTPJSON(t, app, http.MethodPost, "http://127.0.0.1/api/admin/fs/directories", fiber.Map{"directory": outside})
	if response.StatusCode != http.StatusOK || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	var page services.DirectoryPage
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].Name != filepath.Base(selected) {
		t.Fatalf("items=%+v", page.Items)
	}
	if !reflect.DeepEqual(mgr.Get().Roots(), cfg.Roots()) {
		t.Fatal("browsing changed configuration")
	}
	selected, err := filepath.EvalSymlinks(selected)
	if err != nil || page.Items[0].Path != selected {
		t.Fatal("selected path was guessed or altered")
	}
	response, body = doHTTPJSON(t, app, http.MethodPut, "http://127.0.0.1/api/config", fiber.Map{"mediaRoots": []config.MediaRoot{{Path: page.Items[0].Path, Kind: config.DefaultMediaRootKind}}})
	if response.StatusCode != http.StatusOK || !reflect.DeepEqual(mgr.Get().Roots(), []string{selected}) {
		t.Fatalf("selection did not save: status=%d body=%s", response.StatusCode, body)
	}
}

func TestDirectoryPickerSkipsLinksAndSanitizesErrors(t *testing.T) {
	cfg := config.Default()
	app, _ := directoryPickerApp(cfg)
	root := t.TempDir()
	createFsDirectoryLink(t, filepath.Join(root, "link"), t.TempDir())
	response, body := doHTTPJSON(t, app, http.MethodPost, "http://127.0.0.1/api/admin/fs/directories", fiber.Map{"directory": root})
	var page services.DirectoryPage
	if err := json.Unmarshal(body, &page); err != nil || response.StatusCode != http.StatusOK || len(page.Items) != 0 {
		t.Fatalf("listed directory link: status=%d body=%s err=%v", response.StatusCode, body, err)
	}
	for _, input := range []struct {
		directory string
		status    int
		code      string
	}{
		{filepath.Join(root, "private-missing"), 404, "directory_not_found"},
		{"bad\x00private", 400, "invalid_directory_request"},
	} {
		response, body = doHTTPJSON(t, app, http.MethodPost, "http://127.0.0.1/api/admin/fs/directories", fiber.Map{"directory": input.directory})
		requireFsResponse(t, response.StatusCode, body, input.status, input.code)
		if strings.Contains(string(body), "private") || strings.Contains(string(body), root) {
			t.Fatal("directory error exposed a filesystem path")
		}
	}
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/api/admin/fs/directories", strings.NewReader("{"))
	req.Header.Set("Content-Type", "application/json")
	response, err := app.Test(req)
	if err != nil || response.StatusCode != 400 {
		t.Fatal("malformed request was accepted")
	}
	response.Body.Close()
}

func TestDirectoryPickerRequiresLocalAuthenticatedSameOriginAccess(t *testing.T) {
	cfg := config.Default()
	cfg.AccessMode = config.AccessModeLAN
	cfg.AccessToken = "0123456789abcdef0123456789abcdef"
	app, _ := directoryPickerApp(cfg)
	for _, scenario := range []struct{ token, host, origin, remote, code string }{
		{"", "127.0.0.1", "", "127.0.0.1", "authentication_required"},
		{cfg.AccessToken, "attacker.example", "", "127.0.0.1", "request_host_rejected"},
		{cfg.AccessToken, "127.0.0.1", "http://attacker.example", "127.0.0.1", "cross_origin_request_rejected"},
		{cfg.AccessToken, "127.0.0.1", "", "203.0.113.8", "local_access_required"},
	} {
		var request fasthttp.Request
		request.Header.SetMethod(http.MethodPost)
		request.Header.SetHost(scenario.host)
		request.Header.SetContentType("application/json")
		if scenario.token != "" {
			request.Header.Set("Authorization", "Bearer "+scenario.token)
		}
		if scenario.origin != "" {
			request.Header.Set("Origin", scenario.origin)
		}
		request.SetRequestURI("/api/admin/fs/directories")
		request.SetBodyString(`{"directory":"private-missing"}`)
		var ctx fasthttp.RequestCtx
		ctx.Init(&request, &net.TCPAddr{IP: net.ParseIP(scenario.remote), Port: 40123}, nil)
		app.Handler()(&ctx)
		if status := ctx.Response.StatusCode(); status != 401 && status != 403 {
			t.Fatalf("untrusted request reached directory enumeration: %d %s", status, ctx.Response.Body())
		}
		var result struct {
			Code string `json:"code"`
		}
		if err := json.Unmarshal(ctx.Response.Body(), &result); err != nil || result.Code != scenario.code {
			t.Fatalf("unexpected access denial: %s", ctx.Response.Body())
		}
	}
}
