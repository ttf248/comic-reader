package handlers

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func TestChinaLocationsAPIProvidesOfflineProvinceGeometry(t *testing.T) {
	root := t.TempDir()
	catalog := services.NewResourceCatalog()
	catalog.Publish(&models.ScanResult{Roots: []string{root}}, []string{root})
	safety, safetyState := middleware.PathSafetyMiddleware([]string{root}, catalog)
	stateDir := t.TempDir()
	service, err := services.NewAIJobService(services.AIJobServiceOptions{
		StatePath:   filepath.Join(stateDir, "state", "ai_jobs.json"),
		MetadataDir: filepath.Join(stateDir, "derived", "metadata"),
		Catalog:     catalog, ValidatePath: safetyState.Validate,
		Analyzers: []services.AIAnalyzer{services.MetadataAnalyzer{}}, WorkerCount: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := service.Shutdown(ctx); err != nil {
			t.Errorf("AI job shutdown: %v", err)
		}
	})

	app := fiber.New()
	api := app.Group("/api")
	api.Use(safety)
	api.Get("/locations/china", ChinaLocationsHandler(catalog, service, safetyState.Validate))
	response, err := app.Test(httptest.NewRequest("GET", "/api/locations/china", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	var body struct {
		Locations services.ChinaLocationSummary `json:"locations"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Locations.Provinces) != 34 || len(body.Locations.Areas) < 400 {
		t.Fatalf("offline locations = %d provinces, %d areas", len(body.Locations.Provinces), len(body.Locations.Areas))
	}
	if len(body.Locations.Provinces[0].Geometry) == 0 || body.Locations.GPSPhotoCount != 0 {
		t.Fatalf("map response is incomplete: %+v", body.Locations)
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), root) || strings.Contains(string(encoded), "latitude") || strings.Contains(string(encoded), "longitude") {
		t.Fatal("public map response exposed a filesystem path or raw GPS coordinates")
	}
	if _, err := os.Stat(root); err != nil {
		t.Fatalf("test media root disappeared: %v", err)
	}
}
