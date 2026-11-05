package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/store"
)

func TestPrefsAppModeRoundTrip(t *testing.T) {
	prefs := store.NewPrefsStore(filepath.Join(t.TempDir(), "web_settings.json"))
	app := fiber.New()
	app.Get("/api/prefs", PrefsGetHandler(prefs))
	app.Patch("/api/prefs", PrefsPatchHandler(prefs))

	get := func() map[string]any {
		t.Helper()
		resp, err := app.Test(httptest.NewRequest("GET", "/api/prefs", nil))
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != fiber.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("status=%d body=%s", resp.StatusCode, body)
		}
		var payload map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		return payload
	}

	if mode := get()["appMode"]; mode != "photo" {
		t.Fatalf("default appMode=%v, want photo", mode)
	}

	resp, err := app.Test(patchReq(`{"appMode":"comic"}`))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != fiber.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("patch status=%d body=%s", resp.StatusCode, body)
	}
	if mode := get()["appMode"]; mode != "comic" {
		t.Fatalf("appMode=%v, want comic", mode)
	}

	// 非法值必须被拒绝，不能写进偏好。
	resp, err = app.Test(patchReq(`{"appMode":"manga"}`))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("invalid appMode status=%d, want 400", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "invalid_app_mode") {
		t.Fatalf("body=%s", body)
	}
	// 错误文案只列真实存在的取值：「全部」这一档已经不存在了。
	if !strings.Contains(string(body), "appMode must be photo or comic") {
		t.Fatalf("错误文案应只列 photo / comic, body=%s", body)
	}
	if strings.Contains(string(body), "all") {
		t.Fatalf("错误文案不应再提「全部」, body=%s", body)
	}
	if mode := get()["appMode"]; mode != "comic" {
		t.Fatalf("appMode=%v after rejected patch, want comic", mode)
	}
}

// patchReq 构造一个带 JSON 内容类型的 PATCH 请求。
func patchReq(body string) *http.Request {
	req := httptest.NewRequest("PATCH", "/api/prefs", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}
