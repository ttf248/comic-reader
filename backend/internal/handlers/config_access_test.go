package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/config"
)

const handlerTestAccessToken = "0123456789abcdef0123456789abcdef"

func TestConfigGetHandlerDoesNotExposeAccessToken(t *testing.T) {
	cfg := config.Default()
	cfg.MediaRoots = []config.MediaRoot{{Path: t.TempDir(), Kind: config.DefaultMediaRootKind}}
	cfg.AccessMode = config.AccessModeLAN
	cfg.AccessToken = handlerTestAccessToken
	mgr := config.NewManagerWith(cfg, "")
	app := fiber.New()
	app.Get("/api/config", ConfigGetHandler(mgr))

	res, err := app.Test(httptest.NewRequest(http.MethodGet, "http://example.com/api/config", nil))
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), handlerTestAccessToken) {
		t.Fatal("config response leaked access token")
	}
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatal(err)
	}
	if response["accessMode"] != config.AccessModeLAN || response["accessTokenConfigured"] != true {
		t.Fatalf("unexpected access metadata: %v", response)
	}
	if _, exists := response["accessToken"]; exists {
		t.Fatal("config response must not contain accessToken field")
	}
}

func TestConfigUpdateHandlerAcceptsTokenButReturnsOnlyConfiguredFlag(t *testing.T) {
	cfg := config.Default()
	cfg.MediaRoots = []config.MediaRoot{{Path: t.TempDir(), Kind: config.DefaultMediaRootKind}}
	mgr := config.NewManagerWith(cfg, "")
	app := fiber.New()
	app.Put("/api/config", ConfigUpdateHandler(mgr, nil))
	body := `{"accessMode":"lan","accessToken":"` + handlerTestAccessToken + `"}`
	req := httptest.NewRequest(http.MethodPut, "http://example.com/api/config", strings.NewReader(body))
	req.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)

	res, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	responseBody, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != fiber.StatusOK {
		t.Fatalf("status=%d body=%s", res.StatusCode, responseBody)
	}
	if strings.Contains(string(responseBody), handlerTestAccessToken) {
		t.Fatal("config update response leaked access token")
	}
	var response struct {
		Config struct {
			AccessMode            string  `json:"accessMode"`
			AccessTokenConfigured bool    `json:"accessTokenConfigured"`
			AccessToken           *string `json:"accessToken"`
		} `json:"config"`
	}
	if err := json.Unmarshal(responseBody, &response); err != nil {
		t.Fatal(err)
	}
	if response.Config.AccessMode != config.AccessModeLAN || !response.Config.AccessTokenConfigured {
		t.Fatalf("unexpected response config: %+v", response.Config)
	}
	if response.Config.AccessToken != nil {
		t.Fatal("config update response must not contain accessToken field")
	}
	if mgr.Get().AccessToken != handlerTestAccessToken {
		t.Fatal("token was not applied internally")
	}
}
