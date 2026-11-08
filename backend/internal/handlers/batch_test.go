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
	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/store"
)

func TestBatchHTTPValidationAndAtomicUpdates(t *testing.T) {
	dir := t.TempDir()
	prefs := store.NewPrefsStore(filepath.Join(dir, "prefs.json"))
	activities := store.NewActivityStore(filepath.Join(dir, "activity.json"))
	app := fiber.New()
	app.Post("/favorites", FavoritesBatchHandler(prefs))
	app.Delete("/activity", ActivityBatchDeleteHandler(activities))
	call := func(method, path string, body interface{}) (int, []byte) {
		t.Helper()
		data, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, bytes.NewReader(data))
		req.Header.Set("Content-Type", "application/json")
		res, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		out, _ := io.ReadAll(res.Body)
		return res.StatusCode, out
	}
	id := "a_AAAAAAAAAAAAAAAAAAAAAA"
	status, data := call(http.MethodPost, "/favorites", map[string]interface{}{"resourceIds": []string{id, "smart:C++ 字面%2F"}, "action": "add"})
	if status != 200 {
		t.Fatalf("add: %d %s", status, data)
	}
	status, _ = call(http.MethodPost, "/favorites", map[string]interface{}{"resourceIds": []string{id, "bad"}, "action": "remove"})
	if status != 400 {
		t.Fatalf("invalid batch status=%d", status)
	}
	p, _ := prefs.Get()
	if len(p.Favorites) != 2 {
		t.Fatal("invalid remove committed")
	}
	_ = activities.Set(models.Activity{AlbumID: id, MediaKind: models.MediaKindImage, PageCount: 1})
	status, data = call(http.MethodDelete, "/activity", map[string]interface{}{"albumIds": []string{id, id}})
	if status != 200 || !bytes.Contains(data, []byte(`"deleted":1`)) {
		t.Fatalf("reset: %d %s", status, data)
	}
	status, _ = call(http.MethodPost, "/favorites", map[string]interface{}{"resourceIds": make([]string, 1001), "action": "add"})
	if status != 400 {
		t.Fatal("unbounded batch accepted")
	}
}
