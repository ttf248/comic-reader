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

// chinaLocationTestApp 起一个带离线地点图谱路由的应用。
func chinaLocationTestApp(t *testing.T) (*fiber.App, *services.ResourceCatalog, string) {
	t.Helper()
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

	locations := services.NewChinaLocationService()
	app := fiber.New()
	api := app.Group("/api")
	api.Use(safety)
	api.Get("/locations/china", ChinaLocationsHandler(catalog, service, locations, safetyState.Validate))
	api.Get("/locations/china/regions/:adcode", ChinaLocationRegionsHandler(catalog, service, locations, safetyState.Validate))
	api.Get("/locations/china/regions/:adcode/media", ChinaLocationRegionMediaHandler(catalog, service, locations, safetyState.Validate, nil))
	return app, catalog, root
}

func TestChinaLocationsAPIProvidesOfflineProvinceGeometry(t *testing.T) {
	app, _, root := chinaLocationTestApp(t)
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
	if len(body.Locations.Provinces) != 34 {
		t.Fatalf("offline locations = %d provinces", len(body.Locations.Provinces))
	}
	if len(body.Locations.Provinces[0].Geometry) == 0 || body.Locations.GPSPhotoCount != 0 {
		t.Fatalf("map response is incomplete: %+v", body.Locations)
	}
	if body.Locations.BoundaryVersion == "" {
		t.Fatal("map response is missing the boundary version")
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), root) || strings.Contains(string(encoded), "latitude") || strings.Contains(string(encoded), "longitude") {
		t.Fatal("public map response exposed a filesystem path or raw GPS coordinates")
	}
	if strings.Contains(string(encoded), `"areas"`) {
		t.Fatal("national summary still carries the retired area list")
	}
	if _, err := os.Stat(root); err != nil {
		t.Fatalf("test media root disappeared: %v", err)
	}
}

func TestChinaLocationsAPIHonorsIfNoneMatch(t *testing.T) {
	app, _, _ := chinaLocationTestApp(t)
	response, err := app.Test(httptest.NewRequest("GET", "/api/locations/china", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	etag := response.Header.Get("ETag")
	if etag == "" {
		t.Fatal("map response is missing the ETag")
	}
	request := httptest.NewRequest("GET", "/api/locations/china", nil)
	request.Header.Set("If-None-Match", etag)
	again, err := app.Test(request, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Body.Close()
	if again.StatusCode != fiber.StatusNotModified {
		t.Fatalf("status = %d, want 304", again.StatusCode)
	}
}

func TestChinaLocationRegionsAPIReturnsSubRegions(t *testing.T) {
	app, _, root := chinaLocationTestApp(t)
	response, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/regions/330000", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	var body struct {
		Regions services.ChinaLocationRegions `json:"regions"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Regions.Region.Name != "浙江省" || body.Regions.Region.ParentAdcode != nil {
		t.Fatalf("region info is wrong: %+v", body.Regions.Region)
	}
	if len(body.Regions.Regions) == 0 {
		t.Fatal("province response has no sub regions")
	}
	found := false
	for _, region := range body.Regions.Regions {
		if len(region.Geometry) == 0 {
			t.Fatalf("sub region %d is missing its geometry", region.Adcode)
		}
		if region.Name == "杭州市" {
			found = true
		}
	}
	if !found {
		t.Fatal("province response is missing 杭州市")
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), root) || strings.Contains(string(encoded), "latitude") || strings.Contains(string(encoded), "longitude") {
		t.Fatal("region response exposed a filesystem path or raw GPS coordinates")
	}
}

func TestChinaLocationRegionsAPIRejectsUnknownRegion(t *testing.T) {
	app, _, _ := chinaLocationTestApp(t)
	response, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/regions/999999", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.StatusCode)
	}
	invalid, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/regions/abc", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer invalid.Body.Close()
	if invalid.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("status = %d, want 400", invalid.StatusCode)
	}
}

func TestChinaLocationRegionMediaAPIRejectsUnknownRegion(t *testing.T) {
	app, _, _ := chinaLocationTestApp(t)
	response, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/regions/999999/media", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.StatusCode)
	}
}
