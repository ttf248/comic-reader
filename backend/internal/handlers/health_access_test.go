package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/config"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

const testHandlerAccessToken = "0123456789abcdef0123456789abcdef"

func TestHealthLANHidesDiagnosticsUntilAuthenticated(t *testing.T) {
	cfg := config.Default()
	cfg.AccessMode = config.AccessModeLAN
	cfg.AccessToken = testHandlerAccessToken
	mgr := config.NewManagerWith(cfg, "")
	gate := middleware.NewAccessGate(mgr.Get)
	app := fiber.New()
	api := app.Group("/api")
	api.Use(gate.Middleware())
	api.Get("/health", HealthHandler(mgr, services.NewResourceCatalog()))

	publicRequest := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/health", nil)
	publicResponse, err := app.Test(publicRequest)
	if err != nil {
		t.Fatal(err)
	}
	var public map[string]any
	if err := json.NewDecoder(publicResponse.Body).Decode(&public); err != nil {
		t.Fatal(err)
	}
	if public["status"] != "ok" || public["accessMode"] != config.AccessModeLAN {
		t.Fatalf("unexpected public health: %#v", public)
	}
	for _, secret := range []string{"mediaRoots", "version", "goVersion", "goroutines", "allowOsOpen"} {
		if _, exists := public[secret]; exists {
			t.Fatalf("public health leaked %s: %#v", secret, public)
		}
	}

	authenticatedRequest := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/health", nil)
	authenticatedRequest.Header.Set(fiber.HeaderAuthorization, "Bearer "+testHandlerAccessToken)
	authenticatedResponse, err := app.Test(authenticatedRequest)
	if err != nil {
		t.Fatal(err)
	}
	var authenticated map[string]any
	if err := json.NewDecoder(authenticatedResponse.Body).Decode(&authenticated); err != nil {
		t.Fatal(err)
	}
	if _, exists := authenticated["version"]; !exists {
		t.Fatalf("authenticated health omitted diagnostics: %#v", authenticated)
	}
}
