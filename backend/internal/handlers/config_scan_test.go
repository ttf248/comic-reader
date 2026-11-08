package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/tianlongxiang/local-gallery/internal/config"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func TestConfigSaveStartsLatestScanAndReportsFailureSeparately(t *testing.T) {
	oldRoot, newRoot := t.TempDir(), t.TempDir()
	cfg := config.Default()
	cfg.MediaRoots = []config.MediaRoot{{Path: oldRoot, Kind: "photo"}}
	mgr := config.NewManagerWith(cfg, "")
	runner := services.NewAsyncScanRunner()
	defer runner.Shutdown(context.Background())
	catalog := services.NewResourceCatalog()
	cache := services.NewScanResultCache(filepath.Join(t.TempDir(), "scan.json"))
	runner.SetCatalog(catalog)
	runner.SetCache(cache)
	app := fiber.New()
	app.Put("/api/config", ConfigUpdateHandler(mgr, ConfigScanApply(mgr, runner, catalog, cache)))
	update := func(roots []config.MediaRoot) ConfigUpdateResponse {
		t.Helper()
		data, _ := json.Marshal(map[string]interface{}{"mediaRoots": roots})
		req := httptest.NewRequest(http.MethodPut, "/api/config", strings.NewReader(string(data)))
		req.Header.Set("Content-Type", "application/json")
		res, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out ConfigUpdateResponse
		if err := json.NewDecoder(res.Body).Decode(&out); err != nil || res.StatusCode != http.StatusOK {
			t.Fatalf("save: status=%d %+v %v", res.StatusCode, out, err)
		}
		return out
	}
	response := update([]config.MediaRoot{{Path: newRoot, Kind: "photo"}})
	if !response.MediaRootsChanged || response.ScanID == "" || response.ScanStartError != "" {
		t.Fatalf("missing auto scan: %+v", response)
	}
	first := response.ScanID
	response = update([]config.MediaRoot{{Path: filepath.Join(newRoot, "."), Kind: "photo"}})
	if response.MediaRootsChanged || response.ScanID != "" {
		t.Fatalf("equivalent roots scanned again: %+v", response)
	}
	response = update([]config.MediaRoot{{Path: newRoot, Kind: "comic"}})
	if !response.MediaRootsChanged || response.ScanID == "" || response.ScanID == first {
		t.Fatalf("kind change reused old task: %+v", response)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		state := runner.Get(response.ScanID)
		if state.Status == services.ScanStatusComplete {
			break
		}
		if state.Status == services.ScanStatusError || time.Now().After(deadline) {
			t.Fatalf("scan failed: %+v", state)
		}
		time.Sleep(10 * time.Millisecond)
	}
	response = update([]config.MediaRoot{})
	if !response.MediaRootsChanged || response.ScanID != "" || catalog.Acquire().Ready() {
		t.Fatalf("empty roots: %+v", response)
	}
	if err := runner.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	response = update([]config.MediaRoot{{Path: oldRoot, Kind: "photo"}})
	if !response.OK || response.ScanStartError != "scan_start_failed" || mgr.Roots()[0] != oldRoot {
		t.Fatalf("saved config lost on start failure: %+v", response)
	}
}
