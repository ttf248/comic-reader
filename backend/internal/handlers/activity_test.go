package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/store"
)

const testActivityAlbumID = "a_0000000000000000000001"

func newActivityHandlerApp(t *testing.T) *fiber.App {
	t.Helper()
	activities := store.NewActivityStore(filepath.Join(t.TempDir(), "activity.json"))
	app := fiber.New()
	app.Get("/api/activity", ActivityGetHandler(activities))
	app.Put("/api/activity", ActivityPutHandler(activities))
	return app
}

func TestActivityPutResponseKeepsZeroPageIndex(t *testing.T) {
	app := newActivityHandlerApp(t)
	body := []byte(`{"albumId":"a_0000000000000000000001","mediaKind":"image","pageIndex":0,"pageCount":3}`)
	req := httptest.NewRequest(http.MethodPut, "/api/activity", bytes.NewReader(body))
	req.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	res, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status=%d", res.StatusCode)
	}
	var got map[string]any
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if pageIndex, exists := got["pageIndex"]; !exists || pageIndex != float64(0) {
		t.Fatalf("pageIndex=0 missing from response: %#v", got)
	}
}

func TestActivityGetReturnsStableNotFoundCode(t *testing.T) {
	app := newActivityHandlerApp(t)
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/activity?albumId="+testActivityAlbumID+"&mediaKind=image",
		nil,
	)
	res, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("status=%d", res.StatusCode)
	}
	var got map[string]any
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got["code"] != "activity_not_found" {
		t.Fatalf("unexpected error response: %#v", got)
	}
}

func TestActivityRepeatedPutReturnsPersistedTimestamp(t *testing.T) {
	app := newActivityHandlerApp(t)
	put := func() string {
		t.Helper()
		req := httptest.NewRequest(http.MethodPut, "/api/activity", bytes.NewBufferString(`{"albumId":"a_0000000000000000000001","mediaKind":"image","pageIndex":1,"pageCount":3}`))
		req.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
		res, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("status=%d", res.StatusCode)
		}
		var got struct {
			Updated string `json:"updated"`
		}
		if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		return got.Updated
	}
	first := put()
	second := put()
	if first == "" || first != second {
		t.Fatalf("timestamps %q != %q", first, second)
	}
}
