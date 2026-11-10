package handlers

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/services"
	"github.com/tianlongxiang/local-gallery/internal/store"
)

func TestStateBackupHTTPValidationAndPreferencesWithoutMedia(t *testing.T) {
	dir := t.TempDir()
	service := &services.StateBackupService{Prefs: store.NewPrefsStore(filepath.Join(dir, "prefs.json")), Activities: store.NewActivityStore(filepath.Join(dir, "activity.json")), Covers: services.NewCoverOverrideStore(filepath.Join(dir, "covers.json")), Picks: store.NewPickStore(filepath.Join(dir, "picks.json")), Catalog: services.NewResourceCatalog(), BackupDir: filepath.Join(dir, "backups")}
	app := fiber.New()
	app.Get("/export", middleware.LoopbackOnly(), StateExportHandler(service))
	app.Post("/preview", middleware.LoopbackOnly(), StatePreviewHandler(service))
	app.Post("/import", middleware.LoopbackOnly(), StateImportHandler(service))
	request := func(method, path string, body []byte) (int, []byte) {
		t.Helper()
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		res, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		data, _ := io.ReadAll(res.Body)
		return res.StatusCode, data
	}
	status, data := request(http.MethodGet, "/export", nil)
	if status != 200 || bytes.Contains(data, []byte(dir)) {
		t.Fatalf("export: %d %s", status, data)
	}
	var backup services.StateBackup
	if err := json.Unmarshal(data, &backup); err != nil {
		t.Fatal(err)
	}
	for _, body := range [][]byte{[]byte(`{"backup":`), append([]byte(`{"backup":`), append(data, []byte(`,"unknown":true}`)...)...), []byte(`{"backup":{"version":2}}`)} {
		status, data = request(http.MethodPost, "/preview", body)
		if status != 400 || !bytes.Contains(data, []byte("invalid_state_backup")) {
			t.Fatalf("invalid accepted: %d %s", status, data)
		}
	}
	body, _ := json.Marshal(map[string]interface{}{"backup": backup})
	status, data = request(http.MethodPost, "/preview", body)
	if status != 200 {
		t.Fatalf("preview without library: %d %s", status, data)
	}
	var preview services.BackupPreview
	_ = json.Unmarshal(data, &preview)
	body, _ = json.Marshal(map[string]interface{}{"backup": backup, "categories": []string{"preferences"}, "versions": preview.Versions, "libraryRevision": preview.LibraryRevision})
	status, data = request(http.MethodPost, "/import", body)
	if status != 200 {
		t.Fatalf("preferences need no media: %d %s", status, data)
	}
}
