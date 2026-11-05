package integration_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/config"
	"github.com/tianlongxiang/local-gallery/internal/handlers"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

type fsOpenHarness struct {
	app       *fiber.App
	root      string
	album     string
	file      string
	validFile string
	catalog   *services.ResourceCatalog
	opened    chan string
}

func newFsOpenHarness(t *testing.T) *fsOpenHarness {
	t.Helper()
	root := t.TempDir()
	album := filepath.Join(root, "集合 [100%]", "相册")
	file := filepath.Join(album, "page.png")
	validFile := filepath.Join(root, "valid", "page.png")
	writePNG(t, file, 2, 3)
	writePNG(t, validFile, 2, 3)
	result, err := services.NewScanner().Scan(services.ScanOptions{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	catalog := services.NewResourceCatalog()
	catalog.Publish(result, []string{root})
	cfg := config.Default()
	cfg.MediaRoots = []config.MediaRoot{{Path: root, Kind: config.DefaultMediaRootKind}}
	cfg.CacheDir = t.TempDir()
	cfg.StaticDir = ""
	cfg.AllowOsOpen = true
	mgr := config.NewManagerWith(cfg, "")
	safetyMw, safety := middleware.PathSafetyMiddleware(cfg.Roots(), catalog)
	t.Cleanup(mgr.OnChange("fs-safety", func(current *config.Config) { safety.SetRoots(current.Roots()) }))
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	gate := middleware.NewAccessGate(mgr.Get)
	api := app.Group("/api", gate.Middleware(), safetyMw)
	opened := make(chan string, 16)
	api.Post("/fs/open", middleware.LoopbackOnly(), handlers.FsOpenResourceHandler(mgr, catalog, safety, func(path string) error { opened <- path; return nil }))
	api.Put("/config", middleware.LoopbackOnly(), handlers.ConfigUpdateHandler(mgr, nil))
	return &fsOpenHarness{app: app, root: root, album: album, file: file, validFile: validFile, catalog: catalog, opened: opened}
}

func requireFsResponse(t *testing.T, status int, body []byte, wantStatus int, wantCode string) {
	t.Helper()
	var result struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	if status != wantStatus || result.Code != wantCode {
		t.Fatalf("status=%d body=%s; want %d %s", status, body, wantStatus, wantCode)
	}
}

func doHTTPJSON(t *testing.T, app *fiber.App, method, path string, payload any) (*http.Response, []byte) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	response, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response, data
}

func createFsDirectoryLink(t *testing.T, path, target string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		command := exec.Command("powershell", "-NoProfile", "-Command", "New-Item -ItemType Junction -Path $env:FS_TEST_LINK -Target $env:FS_TEST_TARGET -ErrorAction Stop | Out-Null")
		command.Env = append(os.Environ(), "FS_TEST_LINK="+path, "FS_TEST_TARGET="+target)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("junction: %v %s", err, output)
		}
	} else if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	// 先移除链接本身，再由 t.TempDir 清理测试目录，避免遍历链接目标。
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil {
			t.Errorf("remove test link: %v", err)
		}
	})
}

func TestFsOpenRejectsDirectoryLinksAfterScan(t *testing.T) {
	h := newFsOpenHarness(t)
	fileID := h.catalog.ExternalID(h.file, services.ResourceFile)
	albumID := h.catalog.ExternalID(h.album, services.ResourceAlbum)
	backup := filepath.Join(h.root, "original")
	if rel, err := filepath.Rel(h.root, backup); err != nil || rel != "original" {
		t.Fatal("invalid test backup target")
	}
	if err := os.Rename(h.album, backup); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	writePNG(t, filepath.Join(outside, "page.png"), 4, 5)
	createFsDirectoryLink(t, h.album, outside)
	for _, id := range []string{fileID, albumID} {
		for _, suffix := range []string{"", "?allowConfig=1&path=" + url.QueryEscape(outside)} {
			response, body := doHTTPJSON(t, h.app, http.MethodPost, "http://127.0.0.1/api/fs/open"+suffix, map[string]string{"id": id})
			requireFsResponse(t, response.StatusCode, body, http.StatusNotFound, "resource_not_found")
		}
	}
	if len(h.opened) != 0 {
		t.Fatal("linked resource reached system opener")
	}
	validID := h.catalog.ExternalID(h.validFile, services.ResourceFile)
	response, body := doHTTPJSON(t, h.app, http.MethodPost, "http://127.0.0.1/api/fs/open", map[string]string{"id": validID})
	requireFsResponse(t, response.StatusCode, body, http.StatusOK, "")
	select {
	case path := <-h.opened:
		if path != h.validFile {
			t.Fatalf("opened %q", path)
		}
	default:
		t.Fatal("valid resource did not reach opener")
	}
}

func TestFsOpenRootChangesInvalidateOldCatalogPaths(t *testing.T) {
	h := newFsOpenHarness(t)
	id := h.catalog.ExternalID(h.file, services.ResourceFile)
	response, body := doHTTPJSON(t, h.app, http.MethodPut, "http://127.0.0.1/api/config", map[string]any{"mediaRoots": []config.MediaRoot{{Path: t.TempDir(), Kind: config.DefaultMediaRootKind}}})
	requireFsResponse(t, response.StatusCode, body, http.StatusOK, "")
	if _, ok := h.catalog.Lookup(id); !ok {
		t.Fatal("test must retain the old scan snapshot")
	}
	response, body = doHTTPJSON(t, h.app, http.MethodPost, "http://127.0.0.1/api/fs/open", map[string]string{"id": id})
	requireFsResponse(t, response.StatusCode, body, http.StatusNotFound, "resource_not_found")
	if len(h.opened) != 0 {
		t.Fatal("removed root reached system opener")
	}
}

func TestFsOpenDeletedResourcesReturnNotFound(t *testing.T) {
	h := newFsOpenHarness(t)
	id := h.catalog.ExternalID(h.file, services.ResourceFile)
	if err := os.Remove(h.file); err != nil {
		t.Fatal(err)
	}
	response, body := doHTTPJSON(t, h.app, http.MethodPost, "http://127.0.0.1/api/fs/open", map[string]string{"id": id})
	requireFsResponse(t, response.StatusCode, body, http.StatusNotFound, "resource_not_found")
	if len(h.opened) != 0 {
		t.Fatal("deleted resource reached system opener")
	}
}
