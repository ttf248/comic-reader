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
	api.Get("/locations/china/regions/:adcode/visits", ChinaLocationRegionVisitsHandler(catalog, service, locations, safetyState.Validate))
	api.Get("/locations/china/regions/:adcode/media", ChinaLocationRegionMediaHandler(catalog, service, locations, safetyState.Validate, nil))
	api.Get("/locations/china/geometry/features", ChinaGeometryFeaturesHandler())
	api.Get("/locations/china/geometry/:level", ChinaGeometryHandler())
	api.Get("/locations/china/points", ChinaPointsHandler(catalog, service, locations, safetyState.Validate))
	api.Get("/locations/china/trips/:index/media", ChinaTripMediaHandler(catalog, service, locations, safetyState.Validate, nil))
	return app, catalog, root
}

// TestChinaTripMediaAPIRejectsUnknownTrip 守住行程序号的校验。
//
// 段是切分出来的，序号越界不是空页而是没有这一段。
func TestChinaTripMediaAPIRejectsUnknownTrip(t *testing.T) {
	app, _, _ := chinaLocationTestApp(t)
	response, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/trips/0/media", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.StatusCode)
	}
	invalid, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/trips/-1/media", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer invalid.Body.Close()
	if invalid.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("status = %d, want 400", invalid.StatusCode)
	}
}

func TestChinaLocationsAPIProvidesOfflineProvinceStatistics(t *testing.T) {
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
	if body.Locations.GPSPhotoCount != 0 {
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
	// 统计与几何是两份数据：统计响应里不能再有坐标，
	// 否则全国那一次请求就会拖走 18MB。
	if strings.Contains(string(encoded), `"coordinates"`) {
		t.Fatal("statistics response still carries boundary geometry")
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

	countyResponse, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/regions/330100", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer countyResponse.Body.Close()
	if countyResponse.StatusCode != fiber.StatusOK {
		t.Fatalf("city region status = %d", countyResponse.StatusCode)
	}
	var cityBody struct {
		Regions services.ChinaLocationRegions `json:"regions"`
	}
	if err := json.NewDecoder(countyResponse.Body).Decode(&cityBody); err != nil {
		t.Fatal(err)
	}
	if cityBody.Regions.Region.Name != "杭州市" || len(cityBody.Regions.Region.Ancestors) != 1 || cityBody.Regions.Region.Ancestors[0].Adcode != 330000 {
		t.Fatalf("city region ancestors are wrong: %+v", cityBody.Regions.Region)
	}
	foundCounty := false
	for _, region := range cityBody.Regions.Regions {
		if region.Adcode == 330106 && region.Name == "西湖区" && region.Level == "district" {
			foundCounty = true
		}
	}
	if !foundCounty {
		t.Fatal("city region response is missing the West Lake district boundary")
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

func TestChinaLocationAPIReturnsVisits(t *testing.T) {
	app, _, _ := chinaLocationTestApp(t)
	response, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/regions/330000/visits", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	var body struct {
		Visits services.ChinaLocationVisits `json:"visits"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Visits.Region.Name != "浙江省" {
		t.Fatalf("visit region = %+v", body.Visits.Region)
	}
	if body.Visits.Visits == nil {
		t.Fatal("visits list must not be null")
	}
}

func TestChinaLocationAPIRejectsInvalidTimeRange(t *testing.T) {
	app, _, _ := chinaLocationTestApp(t)
	response, err := app.Test(httptest.NewRequest("GET", "/api/locations/china?from=2019", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.StatusCode)
	}
	reversed, err := app.Test(httptest.NewRequest("GET", "/api/locations/china?from=2020-01&to=2019-01", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer reversed.Body.Close()
	if reversed.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("status = %d, want 400", reversed.StatusCode)
	}
}

func TestChinaLocationETagVariesWithTimeRange(t *testing.T) {
	app, _, _ := chinaLocationTestApp(t)
	first, err := app.Test(httptest.NewRequest("GET", "/api/locations/china", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Body.Close()
	etag := first.Header.Get("ETag")
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
	// 换了时间区间，响应内容不同，不能继续命中同一个标识。
	scoped := httptest.NewRequest("GET", "/api/locations/china?from=2019-01&to=2019-12", nil)
	scoped.Header.Set("If-None-Match", etag)
	response, err := app.Test(scoped, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d, want 200 for a different time range", response.StatusCode)
	}
}

func TestChinaGeometryAPIServesSimplifiedOutlines(t *testing.T) {
	app, _, _ := chinaLocationTestApp(t)
	response, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/geometry/province", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	var body struct {
		BoundaryVersion string `json:"boundaryVersion"`
		Hash            string `json:"hash"`
		Level           string `json:"level"`
		Features        []struct {
			Adcode   int             `json:"adcode"`
			Name     string          `json:"name"`
			Level    string          `json:"level"`
			Geometry json.RawMessage `json:"geometry"`
		} `json:"features"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.BoundaryVersion == "" || body.Hash == "" {
		t.Fatalf("outline response is missing its version or hash: %+v", body)
	}
	if body.Level != "province" {
		t.Fatalf("level = %q", body.Level)
	}
	if len(body.Features) != 34 {
		t.Fatalf("outline features = %d, want 34 provinces", len(body.Features))
	}
	for _, feature := range body.Features {
		if len(feature.Geometry) == 0 {
			t.Fatalf("province %d is missing its geometry", feature.Adcode)
		}
		if !strings.Contains(string(feature.Geometry), "coordinates") {
			t.Fatalf("province %d has an unexpected geometry payload", feature.Adcode)
		}
	}
	if response.Header.Get("ETag") == "" {
		t.Fatal("outline response is missing the ETag")
	}
	if cache := response.Header.Get("Cache-Control"); !strings.Contains(cache, "max-age") {
		t.Fatalf("outline response is not cacheable: %q", cache)
	}
}

func TestChinaGeometryAPIServesSubLevelOutlines(t *testing.T) {
	app, _, _ := chinaLocationTestApp(t)
	response, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/geometry/city?parent=330000", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	var body struct {
		Features []struct {
			Adcode int    `json:"adcode"`
			Level  string `json:"level"`
		} `json:"features"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Features) == 0 {
		t.Fatal("province outline is empty")
	}
	for _, feature := range body.Features {
		if feature.Level != "city" {
			t.Fatalf("feature %d has level %q", feature.Adcode, feature.Level)
		}
	}
}

func TestChinaGeometryAPIRejectsUnknownLevelAndParent(t *testing.T) {
	app, _, _ := chinaLocationTestApp(t)
	invalid, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/geometry/township", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer invalid.Body.Close()
	if invalid.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("status = %d, want 400", invalid.StatusCode)
	}
	missing, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/geometry/city?parent=999999", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer missing.Body.Close()
	if missing.StatusCode != fiber.StatusNotFound {
		t.Fatalf("status = %d, want 404", missing.StatusCode)
	}
}

func TestChinaGeometryAPIHonorsIfNoneMatch(t *testing.T) {
	app, _, _ := chinaLocationTestApp(t)
	first, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/geometry/province", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Body.Close()
	etag := first.Header.Get("ETag")
	if etag == "" {
		t.Fatal("outline response is missing the ETag")
	}
	request := httptest.NewRequest("GET", "/api/locations/china/geometry/province", nil)
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

func TestChinaGeometryAPIServesMixedLevelChildren(t *testing.T) {
	app, _, _ := chinaLocationTestApp(t)
	// 河南下面同时挂着地级市与省直辖县级区域，两种层级都要画出来。
	response, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/geometry/children?parent=410000", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	var body struct {
		Features []struct {
			Adcode int    `json:"adcode"`
			Level  string `json:"level"`
		} `json:"features"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	levels := map[string]bool{}
	for _, feature := range body.Features {
		levels[feature.Level] = true
	}
	if !levels["city"] || !levels["district"] {
		t.Fatalf("mixed-level children are incomplete: %v", levels)
	}
}

// TestChinaPointsAPIRejectsUnknownCell 守住格边长的白名单。
//
// 格边长是「画多细」的档位：只认几档，最细的一档是多少有确定的答案。
func TestChinaPointsAPIRejectsUnknownCell(t *testing.T) {
	app, _, _ := chinaLocationTestApp(t)
	response, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/points?cell=0.03", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.StatusCode)
	}
	invalid, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/points?cell=abc", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer invalid.Body.Close()
	if invalid.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("status = %d, want 400", invalid.StatusCode)
	}
}

// TestChinaPointsAPIChangesETagWithCell 守住 ETag 里带着格边长。
//
// 换了格边长，响应的内容就变了；ETag 不跟着变，客户端会拿到上一粒度的
// 304，地图上画出来的点就会比请求的粗。
func TestChinaPointsAPIChangesETagWithCell(t *testing.T) {
	app, _, _ := chinaLocationTestApp(t)
	coarse, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/points?cell=0.5", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer coarse.Body.Close()
	if coarse.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d", coarse.StatusCode)
	}
	coarseETag := coarse.Header.Get("ETag")
	if coarseETag == "" {
		t.Fatal("points response has no ETag")
	}
	fine, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/points?cell=0.01", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer fine.Body.Close()
	if fine.Header.Get("ETag") == coarseETag {
		t.Fatalf("ETag %q did not change with the cell size", coarseETag)
	}
	// 同一个格边长再要一次：命中缓存。
	cached, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/points?cell=0.5", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer cached.Body.Close()
	if cached.Header.Get("ETag") != coarseETag {
		t.Fatalf("ETag changed for the same request: %q vs %q", cached.Header.Get("ETag"), coarseETag)
	}
}

// TestChinaGeometryFeaturesAPIServesByAdcode 守住按区划码取轮廓的端点。
//
// 地图要画的是「去过的那些地方自己的形状」；直辖市的区县没有市一级，
// 前端推不出父级，只能按区划码取。
func TestChinaGeometryFeaturesAPIServesByAdcode(t *testing.T) {
	app, _, _ := chinaLocationTestApp(t)
	response, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/geometry/features?adcodes=330100,310104", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	var body struct {
		BoundaryVersion string `json:"boundaryVersion"`
		Features        []struct {
			Adcode   int             `json:"adcode"`
			Name     string          `json:"name"`
			Geometry json.RawMessage `json:"geometry"`
		} `json:"features"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.BoundaryVersion == "" {
		t.Fatal("outline response is missing its version")
	}
	if len(body.Features) != 2 {
		t.Fatalf("features = %d, want 2: %+v", len(body.Features), body.Features)
	}
	for _, feature := range body.Features {
		if feature.Name == "" || len(feature.Geometry) == 0 {
			t.Fatalf("feature %d is incomplete: %+v", feature.Adcode, feature)
		}
	}
	invalid, err := app.Test(httptest.NewRequest("GET", "/api/locations/china/geometry/features?adcodes=abc", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer invalid.Body.Close()
	if invalid.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("status = %d, want 400", invalid.StatusCode)
	}
}
