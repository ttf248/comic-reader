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

func writeStorageTestFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestStorageUsageHandlerReturnsRelativePathsOnly(t *testing.T) {
	root := t.TempDir()
	cacheRoot := filepath.Join(root, "cache")
	workerDir := filepath.Join(root, "backend", "aiworker")
	writeStorageTestFile(t, filepath.Join(cacheRoot, "derived", "ai", "models", services.ChineseCLIPModelFile), "clip-model")
	writeStorageTestFile(t, filepath.Join(cacheRoot, "derived", "metadata", "ocr", "batches", "job", "00000001.json"), "batch")

	service := services.NewAIStorageService(0)
	app := fiber.New()
	api := app.Group("/api")
	api.Get("/storage/usage", StorageUsageHandler(service, StorageHandlerOptions{
		CacheRoot:       cacheRoot,
		WorkerDirectory: workerDir,
	}))

	response, err := app.Test(httptest.NewRequest("GET", "/api/storage/usage", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if response.Header.Get(fiber.HeaderCacheControl) != "no-store" {
		t.Fatalf("cache control = %q", response.Header.Get(fiber.HeaderCacheControl))
	}
	var body struct {
		Usage services.AIStorageUsage `json:"usage"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Usage.Modules) != 4 {
		t.Fatalf("module count = %d", len(body.Usage.Modules))
	}
	if body.Usage.Paths.JobsFile != "state/ai_jobs.json" {
		t.Fatalf("jobs file = %q", body.Usage.Paths.JobsFile)
	}

	// 占用快照是给所有设备看的，里面不能出现本机绝对路径。
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), cacheRoot) || strings.Contains(string(encoded), workerDir) {
		t.Fatalf("usage payload leaked an absolute path: %s", encoded)
	}
}

func TestStoragePathsHandlerReturnsAbsolutePaths(t *testing.T) {
	root := t.TempDir()
	cacheRoot := filepath.Join(root, "cache")
	workerDir := filepath.Join(root, "backend", "aiworker")
	writeStorageTestFile(t, filepath.Join(cacheRoot, "derived", "ai", "models", services.ChineseCLIPModelFile), "clip-model")

	service := services.NewAIStorageService(0)
	app := fiber.New()
	api := app.Group("/api")
	api.Get("/storage/paths", StoragePathsHandler(service, services.AIStoragePathOptions{
		ConfigPath:       filepath.Join(root, "backend", "config.yaml"),
		WorkingDirectory: root,
		CacheRoot:        cacheRoot,
		WorkerDirectory:  workerDir,
		PythonPath:       filepath.Join(workerDir, ".venv", "Scripts", "python.exe"),
	}))

	response, err := app.Test(httptest.NewRequest("GET", "/api/storage/paths", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	var body struct {
		Paths services.AIStorageAbsolutePaths `json:"paths"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Paths.CacheRoot != cacheRoot {
		t.Fatalf("cache root = %q", body.Paths.CacheRoot)
	}
	if body.Paths.ConfigFile != filepath.Join(root, "backend", "config.yaml") {
		t.Fatalf("config file = %q", body.Paths.ConfigFile)
	}
	if body.Paths.JobsFile != filepath.Join(cacheRoot, "state", "ai_jobs.json") {
		t.Fatalf("jobs file = %q", body.Paths.JobsFile)
	}
	if len(body.Paths.Modules) != 4 {
		t.Fatalf("module count = %d", len(body.Paths.Modules))
	}
}

func TestAIJobOutputHandlerReturnsJobOutput(t *testing.T) {
	root := t.TempDir()
	albumPath := filepath.Join(root, "album")
	if err := os.MkdirAll(albumPath, 0o755); err != nil {
		t.Fatal(err)
	}
	imagePath := filepath.Join(albumPath, "photo.jpg")
	if err := os.WriteFile(imagePath, []byte("not-a-real-jpeg"), 0o600); err != nil {
		t.Fatal(err)
	}
	catalog := services.NewResourceCatalog()
	catalog.Publish(&models.ScanResult{
		Roots: []string{root},
		Albums: []models.Album{{
			Type: "album", Name: "album", Path: albumPath, SourceRoot: root,
			ImageFiles: []string{imagePath}, CoverImage: imagePath,
		}},
	}, []string{root})
	safety, safetyState := middleware.PathSafetyMiddleware([]string{root}, catalog)

	cacheRoot := filepath.Join(root, "cache")
	metadataDir := filepath.Join(cacheRoot, "derived", "metadata")
	jobs, err := services.NewAIJobService(services.AIJobServiceOptions{
		StatePath:    filepath.Join(root, "state", "ai_jobs.json"),
		MetadataDir:  metadataDir,
		Catalog:      catalog,
		ValidatePath: safetyState.Validate,
		Analyzers:    []services.AIAnalyzer{services.MetadataAnalyzer{}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := jobs.Shutdown(ctx); err != nil {
			t.Errorf("AI job shutdown: %v", err)
		}
	})
	job, _, err := jobs.Start(services.AIJobTypeMetadata, services.AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		current, exists := jobs.Get(job.ID)
		if exists && (current.Status == services.AIJobStatusCompleted || current.Status == services.AIJobStatusFailed) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	outputs := services.NewJobOutputService(cacheRoot, 0)
	app := fiber.New()
	api := app.Group("/api")
	api.Use(safety)
	api.Get("/ai/jobs/:jobId/output", AIJobOutputHandler(jobs, outputs))

	response, err := app.Test(httptest.NewRequest("GET", "/api/ai/jobs/"+job.ID+"/output", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	var body struct {
		Output services.AIJobOutputUsage `json:"output"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Output.JobID != job.ID || body.Output.Type != services.AIJobTypeMetadata {
		t.Fatalf("output = %+v", body.Output)
	}
	if body.Output.Path != "derived/metadata/metadata/batches/"+job.ID {
		t.Fatalf("output path = %q", body.Output.Path)
	}
	if !body.Output.Available || body.Output.FileCount == 0 {
		t.Fatalf("output usage = %+v", body.Output)
	}

	missing, err := app.Test(httptest.NewRequest("GET", "/api/ai/jobs/missing/output", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer missing.Body.Close()
	if missing.StatusCode != fiber.StatusNotFound {
		t.Fatalf("missing job status = %d", missing.StatusCode)
	}
	var errorBody struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(missing.Body).Decode(&errorBody); err != nil {
		t.Fatal(err)
	}
	if errorBody.Code != "analysis_job_not_found" {
		t.Fatalf("error code = %q", errorBody.Code)
	}
}
