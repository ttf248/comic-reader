package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/config"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

type fsValidatorFunc func(string) (string, error)

func (f fsValidatorFunc) Validate(path string) (string, error) { return f(path) }

func fsOpenFixture(t *testing.T) (string, string, *services.ResourceCatalog, *config.Manager) {
	t.Helper()
	root, picture, catalog := mediaInfoFixture(t, "集合 [100%]/相册/picture.png")
	result, err := services.NewScanner().Scan(services.ScanOptions{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	catalog.Publish(result, []string{root})
	cfg := config.Default()
	cfg.MediaRoots = []config.MediaRoot{{Path: root, Kind: config.DefaultMediaRootKind}}
	cfg.AllowOsOpen = true
	return root, picture, catalog, config.NewManagerWith(cfg, "")
}

func fsOpenApp(mgr *config.Manager, catalog *services.ResourceCatalog, validator middleware.PathValidator, opener func(string) error) *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Post("/api/fs/open", FsOpenResourceHandler(mgr, catalog, validator, opener))
	return app
}

func requestFsOpen(t *testing.T, app *fiber.App, id string) (int, []byte) {
	t.Helper()
	payload, err := json.Marshal(struct {
		ID string `json:"id"`
	}{id})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/fs/open", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	response, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, body
}

func expectFsCode(t *testing.T, status int, body []byte, wantStatus int, code string) {
	t.Helper()
	var result struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	if status != wantStatus || result.Code != code {
		t.Fatalf("status=%d code=%s body=%s; want %d %s", status, result.Code, body, wantStatus, code)
	}
}

func TestFsOpenAcceptsCurrentResourceKinds(t *testing.T) {
	root, picture, catalog, mgr := fsOpenFixture(t)
	_, safety := middleware.PathSafetyMiddleware([]string{root})
	opened := make(chan string, 4)
	app := fsOpenApp(mgr, catalog, safety, func(path string) error { opened <- path; return nil })
	for _, item := range []struct {
		path string
		kind services.ResourceKind
	}{
		{root, services.ResourceRoot},
		{filepath.Dir(filepath.Dir(picture)), services.ResourceCollection},
		{filepath.Dir(picture), services.ResourceAlbum},
		{picture, services.ResourceFile},
	} {
		id := catalog.ExternalID(item.path, item.kind)
		if id == "" {
			t.Fatalf("resource missing: %s", item.kind)
		}
		status, body := requestFsOpen(t, app, id)
		if status != http.StatusOK || string(body) != `{"ok":true}` {
			t.Fatalf("status=%d body=%s", status, body)
		}
		select {
		case path := <-opened:
			if path != item.path {
				t.Fatalf("opened=%q want=%q", path, item.path)
			}
		default:
			t.Fatal("system opener was not called")
		}
	}
}

func TestFsOpenRevalidatesCurrentRoots(t *testing.T) {
	root, picture, catalog, mgr := fsOpenFixture(t)
	_, safety := middleware.PathSafetyMiddleware([]string{root})
	opened := make(chan string, 2)
	app := fsOpenApp(mgr, catalog, safety, func(path string) error { opened <- path; return nil })
	id := catalog.ExternalID(picture, services.ResourceFile)
	safety.SetRoots([]string{t.TempDir()})
	status, body := requestFsOpen(t, app, id)
	expectFsCode(t, status, body, http.StatusNotFound, "resource_not_found")
	if len(opened) != 0 {
		t.Fatal("removed root reached system opener")
	}
}

func TestFsOpenRequiresValidationAndUsesValidatedPath(t *testing.T) {
	root, picture, catalog, mgr := fsOpenFixture(t)
	id := catalog.ExternalID(picture, services.ResourceFile)
	for _, rejected := range []struct {
		name string
		path string
		err  error
	}{
		{"denied", "", errors.New("outside root")}, {"empty", "", nil},
	} {
		t.Run(rejected.name, func(t *testing.T) {
			called := false
			app := fsOpenApp(mgr, catalog, fsValidatorFunc(func(path string) (string, error) {
				if path != picture {
					t.Errorf("validated wrong input: %q", path)
				}
				return rejected.path, rejected.err
			}), func(string) error { called = true; return nil })
			status, body := requestFsOpen(t, app, id)
			expectFsCode(t, status, body, http.StatusNotFound, "resource_not_found")
			if called {
				t.Fatal("rejected path reached system opener")
			}
		})
	}
	validated := filepath.Join(root, "validated.png")
	if err := os.WriteFile(validated, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	opened := make(chan string, 1)
	app := fsOpenApp(mgr, catalog, fsValidatorFunc(func(string) (string, error) { return validated, nil }), func(path string) error { opened <- path; return nil })
	status, body := requestFsOpen(t, app, id)
	if status != http.StatusOK {
		t.Fatalf("status=%d body=%s", status, body)
	}
	if path := <-opened; path != validated {
		t.Fatalf("opened unvalidated path %q", path)
	}
}

func TestFsOpenRejectsDeletedOrReplacedResources(t *testing.T) {
	for _, replacement := range []string{"deleted-file", "file-to-directory", "directory-to-file"} {
		t.Run(replacement, func(t *testing.T) {
			root, picture, catalog, mgr := fsOpenFixture(t)
			_, safety := middleware.PathSafetyMiddleware([]string{root})
			path, kind := picture, services.ResourceFile
			if replacement == "directory-to-file" {
				path, kind = filepath.Dir(picture), services.ResourceAlbum
				if err := os.Remove(filepath.Join(path, "clip.webm")); err != nil {
					t.Fatal(err)
				}
			}
			id := catalog.ExternalID(path, kind)
			if err := os.Remove(picture); err != nil {
				t.Fatal(err)
			}
			if replacement == "file-to-directory" {
				if err := os.Mkdir(picture, 0o755); err != nil {
					t.Fatal(err)
				}
			} else if replacement == "directory-to-file" {
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte("replacement"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			called := false
			app := fsOpenApp(mgr, catalog, safety, func(string) error { called = true; return nil })
			status, body := requestFsOpen(t, app, id)
			expectFsCode(t, status, body, http.StatusNotFound, "resource_not_found")
			if called {
				t.Fatal("stale resource reached system opener")
			}
		})
	}
}

func TestFsOpenRejectsUnknownIDsAndInvalidBodies(t *testing.T) {
	root, _, catalog, mgr := fsOpenFixture(t)
	_, safety := middleware.PathSafetyMiddleware([]string{root})
	called := false
	app := fsOpenApp(mgr, catalog, safety, func(string) error { called = true; return nil })
	for _, id := range []string{"f_missing", root, "smart:tag"} {
		status, body := requestFsOpen(t, app, id)
		expectFsCode(t, status, body, http.StatusNotFound, "resource_not_found")
	}
	status, body := requestFsOpen(t, app, "")
	expectFsCode(t, status, body, http.StatusBadRequest, "invalid_resource_id")
	if called {
		t.Fatal("invalid request reached system opener")
	}
}

func TestFsOpenUnavailableDependenciesAndDisabledPermission(t *testing.T) {
	root, picture, catalog, mgr := fsOpenFixture(t)
	_, safety := middleware.PathSafetyMiddleware([]string{root})
	id := catalog.ExternalID(picture, services.ResourceFile)
	opener := func(string) error { return nil }
	for _, app := range []*fiber.App{
		fsOpenApp(mgr, nil, safety, opener), fsOpenApp(mgr, catalog, nil, opener), fsOpenApp(mgr, catalog, safety, nil),
	} {
		status, body := requestFsOpen(t, app, id)
		expectFsCode(t, status, body, http.StatusInternalServerError, "os_open_failed")
	}
	cfg := mgr.Get()
	cfg.AllowOsOpen = false
	disabled := config.NewManagerWith(cfg, "")
	status, body := requestFsOpen(t, fsOpenApp(disabled, catalog, safety, func(string) error { t.Error("disabled opener called"); return nil }), id)
	expectFsCode(t, status, body, http.StatusForbidden, "os_open_disabled")
}

func TestFsOpenSanitizesSystemErrors(t *testing.T) {
	root, picture, catalog, mgr := fsOpenFixture(t)
	_, safety := middleware.PathSafetyMiddleware([]string{root})
	app := fsOpenApp(mgr, catalog, safety, func(string) error { return errors.New("private: " + picture) })
	status, body := requestFsOpen(t, app, catalog.ExternalID(picture, services.ResourceFile))
	expectFsCode(t, status, body, http.StatusInternalServerError, "os_open_failed")
	if strings.Contains(string(body), picture) || strings.Contains(string(body), "private") {
		t.Fatalf("response leaked raw error: %s", body)
	}
}
