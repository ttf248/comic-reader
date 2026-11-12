package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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

func TestAIJobAPIFullAnalysisOverThousandImages(t *testing.T) {
	root := t.TempDir()
	albumPath := filepath.Join(root, "photos")
	if err := os.MkdirAll(albumPath, 0o755); err != nil {
		t.Fatal(err)
	}
	imageBytes := []byte{0xff, 0xd8, 0xff, 0xd9}
	files := make([]string, 0, 1001)
	for index := 0; index < 1001; index++ {
		path := filepath.Join(albumPath, fmt.Sprintf("%04d.jpg", index))
		if err := os.WriteFile(path, imageBytes, 0o600); err != nil {
			t.Fatal(err)
		}
		files = append(files, path)
	}

	catalog := services.NewResourceCatalog()
	catalog.Publish(&models.ScanResult{
		Roots: []string{root},
		Albums: []models.Album{{
			Type: "album", Name: "照片", Path: albumPath, SourceRoot: root,
			ImageFiles: files, CoverImage: files[0],
		}},
	}, []string{root})
	safety, safetyState := middleware.PathSafetyMiddleware([]string{root}, catalog)
	service, err := services.NewAIJobService(services.AIJobServiceOptions{
		StatePath:    filepath.Join(t.TempDir(), "state", "ai_jobs.json"),
		MetadataDir:  filepath.Join(t.TempDir(), "derived", "metadata"),
		Catalog:      catalog,
		ValidatePath: safetyState.Validate,
		Analyzers:    []services.AIAnalyzer{services.MetadataAnalyzer{}},
		WorkerCount:  4,
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
	api.Get("/ai/jobs", AIJobsHandler(service))
	api.Post("/ai/jobs", AIJobStartHandler(service))
	api.Get("/images/:id/metadata", middleware.ResourceParam(catalog, safetyState), ImageMetadataHandler(service))
	api.Get("/locations", GPSLocationsHandler(catalog, service, safetyState.Validate, nil))

	startRequest := httptest.NewRequest("POST", "/api/ai/jobs", strings.NewReader(`{"type":"metadata","mode":"full"}`))
	startRequest.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	startResponse, err := app.Test(startRequest, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer startResponse.Body.Close()
	if startResponse.StatusCode != fiber.StatusOK {
		t.Fatalf("start status = %d", startResponse.StatusCode)
	}
	var startBody struct {
		Job services.AIJob `json:"job"`
	}
	if err := json.NewDecoder(startResponse.Body).Decode(&startBody); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(30 * time.Second)
	var finished services.AIJob
	for time.Now().Before(deadline) {
		if job, ok := service.Get(startBody.Job.ID); ok {
			finished = job
			if job.Status == services.AIJobStatusCompleted || job.Status == services.AIJobStatusFailed {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if finished.Status != services.AIJobStatusCompleted || finished.Processed != len(files) || finished.Failed != 0 {
		t.Fatalf("1001-image job result = %+v", finished)
	}

	resourceID := catalog.ExternalID(files[0], services.ResourceFile)
	metadataResponse, err := app.Test(httptest.NewRequest("GET", "/api/images/"+resourceID+"/metadata", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer metadataResponse.Body.Close()
	if metadataResponse.StatusCode != fiber.StatusOK {
		t.Fatalf("metadata status = %d", metadataResponse.StatusCode)
	}
	var metadataBody map[string]any
	if err := json.NewDecoder(metadataResponse.Body).Decode(&metadataBody); err != nil {
		t.Fatal(err)
	}
	if metadataBody["status"] != services.MetadataParseNoExif || metadataBody["resourceId"] != resourceID {
		t.Fatalf("metadata response = %+v", metadataBody)
	}
	encodedMetadata, _ := json.Marshal(metadataBody)
	if strings.Contains(string(encodedMetadata), root) {
		t.Fatal("metadata API exposed an absolute media path")
	}

	listResponse, err := app.Test(httptest.NewRequest("GET", "/api/ai/jobs", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer listResponse.Body.Close()
	listBytes, err := io.ReadAll(listResponse.Body)
	if err != nil {
		t.Fatal(err)
	}
	var listBody struct {
		Snapshot services.AIJobSnapshot `json:"snapshot"`
	}
	if err := json.Unmarshal(listBytes, &listBody); err != nil {
		t.Fatal(err)
	}
	if len(listBody.Snapshot.Jobs) != 1 || listBody.Snapshot.Jobs[0].Processed != 1001 {
		t.Fatalf("job list response = %+v", listBody.Snapshot)
	}
	job := listBody.Snapshot.Jobs[0]
	if job.Planned != 1001 || job.Completed != 1001 {
		t.Fatalf("job progress = planned %d, completed %d", job.Planned, job.Completed)
	}
	if job.Results[services.MetadataParseNoExif] != 1001 {
		t.Fatalf("job results = %+v", job.Results)
	}
	if len(listBody.Snapshot.Modules) != 4 {
		t.Fatalf("modules = %+v", listBody.Snapshot.Modules)
	}

	var rawList map[string]any
	if err := json.Unmarshal(listBytes, &rawList); err != nil {
		t.Fatal(err)
	}
	rawSnapshot, _ := rawList["snapshot"].(map[string]any)
	if _, ok := rawSnapshot["modules"]; !ok {
		t.Fatalf("snapshot is missing modules: %+v", rawSnapshot)
	}
	rawJobs, _ := rawSnapshot["jobs"].([]any)
	if len(rawJobs) == 0 {
		t.Fatalf("snapshot has no jobs: %+v", rawSnapshot)
	}
	rawJob, _ := rawJobs[0].(map[string]any)
	for _, key := range []string{"planned", "completed", "estimatedRemainingMs", "results"} {
		if _, ok := rawJob[key]; !ok {
			t.Fatalf("job payload is missing %q: %+v", key, rawJob)
		}
	}
}

func TestAIJobQueueAndHistoryManagementAPI(t *testing.T) {
	root := t.TempDir()
	catalog := services.NewResourceCatalog()
	catalog.Publish(&models.ScanResult{Roots: []string{root}}, []string{root})
	_, safetyState := middleware.PathSafetyMiddleware([]string{root}, catalog)
	statePath := filepath.Join(t.TempDir(), "state", "ai_jobs.json")
	if err := os.MkdirAll(filepath.Dir(statePath), 0o755); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	makeJob := func(id string) services.AIJob {
		return services.AIJob{
			ID: id, Type: services.AIJobTypeMetadata, Mode: services.AIJobModeFull,
			Status: services.AIJobStatusPending, Stage: services.AIJobStatusPending,
			ModuleVersion: "metadata-v1", CreatedAt: now, UpdatedAt: now,
			Checkpoint: services.AIJobCheckpoint{ModuleVersion: "metadata-v1"},
		}
	}
	state := map[string]any{
		"version": 1,
		"jobs":    []services.AIJob{makeJob("job-first"), makeJob("job-second")},
		"queue":   []string{"job-first", "job-second"},
		"settings": services.AIJobSettings{
			DailyTime: "03:00", DailyModules: []string{services.AIJobTypeMetadata},
		},
	}
	stateBytes, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, stateBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	service, err := services.NewAIJobService(services.AIJobServiceOptions{
		StatePath: statePath, MetadataDir: filepath.Join(t.TempDir(), "derived"),
		Catalog: catalog, ValidatePath: safetyState.Validate,
		Analyzers: []services.AIAnalyzer{services.MetadataAnalyzer{}},
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
	api.Get("/ai/jobs", AIJobsHandler(service))
	api.Post("/ai/jobs/:id/move", AIJobQueueMoveHandler(service))
	api.Delete("/ai/jobs/queue", AIJobQueueHandler(service))
	api.Delete("/ai/jobs/history", AIJobHistoryHandler(service))
	api.Delete("/ai/jobs/:id", AIJobHistoryItemHandler(service))
	call := func(method, path, body string) *http.Response {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
		}
		response, err := app.Test(request, -1)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}

	moveResponse := call("POST", "/api/ai/jobs/job-second/move", `{"direction":"up"}`)
	if moveResponse.StatusCode != fiber.StatusOK {
		t.Fatalf("queue move status = %d", moveResponse.StatusCode)
	}
	moveResponse.Body.Close()
	if got := service.List().Queue; len(got) != 2 || got[0] != "job-second" || got[1] != "job-first" {
		t.Fatalf("queue after API move = %v", got)
	}
	blockedDelete := call("DELETE", "/api/ai/jobs/job-first", "")
	if blockedDelete.StatusCode != fiber.StatusConflict {
		t.Fatalf("pending history delete status = %d, want conflict", blockedDelete.StatusCode)
	}
	blockedDelete.Body.Close()

	clearResponse := call("DELETE", "/api/ai/jobs/queue", "")
	var clearBody struct {
		CancelledCount int `json:"cancelledCount"`
	}
	if clearResponse.StatusCode != fiber.StatusOK || json.NewDecoder(clearResponse.Body).Decode(&clearBody) != nil || clearBody.CancelledCount != 2 {
		t.Fatalf("queue clear response = status %d, body %+v", clearResponse.StatusCode, clearBody)
	}
	clearResponse.Body.Close()
	if got := service.List().Queue; len(got) != 0 {
		t.Fatalf("queue after clear API = %v", got)
	}

	deleteResponse := call("DELETE", "/api/ai/jobs/job-first", "")
	if deleteResponse.StatusCode != fiber.StatusOK {
		t.Fatalf("single history delete status = %d", deleteResponse.StatusCode)
	}
	deleteResponse.Body.Close()
	historyResponse := call("DELETE", "/api/ai/jobs/history", "")
	var historyBody struct {
		DeletedCount int `json:"deletedCount"`
	}
	if historyResponse.StatusCode != fiber.StatusOK || json.NewDecoder(historyResponse.Body).Decode(&historyBody) != nil || historyBody.DeletedCount != 1 {
		t.Fatalf("history clear response = status %d, body %+v", historyResponse.StatusCode, historyBody)
	}
	historyResponse.Body.Close()
	if got := service.List().Jobs; len(got) != 0 {
		t.Fatalf("jobs after history API = %v", got)
	}
}

func TestAIJobSequenceAPIQueuesAllModulesInOrder(t *testing.T) {
	root := t.TempDir()
	albumPath := filepath.Join(root, "photos")
	if err := os.MkdirAll(albumPath, 0o755); err != nil {
		t.Fatal(err)
	}
	photoPath := filepath.Join(albumPath, "sample.jpg")
	if err := os.WriteFile(photoPath, []byte{0xff, 0xd8, 0xff, 0xd9}, 0o600); err != nil {
		t.Fatal(err)
	}
	catalog := services.NewResourceCatalog()
	catalog.Publish(&models.ScanResult{
		Roots: []string{root},
		Albums: []models.Album{{
			Type: "album", Name: "照片", Path: albumPath, SourceRoot: root,
			ImageFiles: []string{photoPath}, CoverImage: photoPath,
		}},
	}, []string{root})
	safety, safetyState := middleware.PathSafetyMiddleware([]string{root}, catalog)
	callOrder := []string{}
	analyzers := make([]services.AIAnalyzer, 0, 4)
	for _, moduleType := range []string{services.AIJobTypeMetadata, services.AIJobTypeEmbedding, services.AIJobTypeOCR, services.AIJobTypeFace} {
		analyzers = append(analyzers, &sequenceAPIAnalyzer{module: moduleType, calls: &callOrder})
	}
	service, err := services.NewAIJobService(services.AIJobServiceOptions{
		StatePath:    filepath.Join(t.TempDir(), "state", "ai_jobs.json"),
		MetadataDir:  filepath.Join(t.TempDir(), "derived", "metadata"),
		Catalog:      catalog,
		ValidatePath: safetyState.Validate,
		Analyzers:    analyzers,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetPeopleEnabled(true); err != nil {
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
	api.Post("/ai/jobs/sequence", AIJobSequenceStartHandler(service))
	request := httptest.NewRequest(fiber.MethodPost, "/api/ai/jobs/sequence", strings.NewReader(`{"mode":"full"}`))
	request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	response, err := app.Test(request, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("sequence start status = %d", response.StatusCode)
	}
	var body struct {
		Jobs    []services.AIJob       `json:"jobs"`
		Skipped []services.AIJobModule `json:"skippedModules"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	wantOrder := []string{services.AIJobTypeMetadata, services.AIJobTypeEmbedding, services.AIJobTypeOCR, services.AIJobTypeFace}
	if len(body.Jobs) != len(wantOrder) || len(body.Skipped) != 0 {
		t.Fatalf("sequence response = %+v", body)
	}
	for index, want := range wantOrder {
		if body.Jobs[index].Type != want {
			t.Fatalf("queued job[%d] type = %q, want %q", index, body.Jobs[index].Type, want)
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		finished := true
		for _, job := range body.Jobs {
			current, ok := service.Get(job.ID)
			if !ok || current.Status != services.AIJobStatusCompleted {
				finished = false
				break
			}
		}
		if finished {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(callOrder) != len(wantOrder) {
		t.Fatalf("analyzer calls = %v", callOrder)
	}
	for index, want := range wantOrder {
		if callOrder[index] != want {
			t.Fatalf("analyzer calls = %v, want order %v", callOrder, wantOrder)
		}
	}
}

type sequenceAPIAnalyzer struct {
	module string
	calls  *[]string
}

func (a *sequenceAPIAnalyzer) Type() string    { return a.module }
func (a *sequenceAPIAnalyzer) Version() string { return a.module + "-v1" }
func (a *sequenceAPIAnalyzer) Analyze(context.Context, io.ReadSeeker) (services.AIAnalysisOutput, error) {
	*a.calls = append(*a.calls, a.module)
	return services.AIAnalysisOutput{Status: "processed", Data: json.RawMessage(`{"ok":true}`)}, nil
}

func TestAIJobSettingsHandlerExplainsInvalidModules(t *testing.T) {
	service, err := services.NewAIJobService(services.AIJobServiceOptions{
		StatePath:    filepath.Join(t.TempDir(), "state", "jobs.json"),
		MetadataDir:  filepath.Join(t.TempDir(), "derived"),
		Catalog:      services.NewResourceCatalog(),
		ValidatePath: func(path string) (string, error) { return path, nil },
		Analyzers:    []services.AIAnalyzer{services.MetadataAnalyzer{}},
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
	app.Put("/api/ai/jobs/settings", AIJobSettingsHandler(service, nil))
	request := httptest.NewRequest(fiber.MethodPut, "/api/ai/jobs/settings", strings.NewReader(`{"dailyEnabled":true,"dailyTime":"03:00","dailyModules":[]}`))
	request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	response, err := app.Test(request, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("settings status = %d", response.StatusCode)
	}
	var body struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Code != "invalid_analysis_settings" || !strings.Contains(body.Message, "dailyModules") {
		t.Fatalf("settings error = %+v", body)
	}
}

func TestAIJobStartAPIRequiresPeopleOptIn(t *testing.T) {
	service, err := services.NewAIJobService(services.AIJobServiceOptions{
		StatePath:    filepath.Join(t.TempDir(), "state", "jobs.json"),
		MetadataDir:  filepath.Join(t.TempDir(), "derived"),
		Catalog:      services.NewResourceCatalog(),
		Analyzers:    []services.AIAnalyzer{services.MetadataAnalyzer{}},
		ValidatePath: func(path string) (string, error) { return path, nil },
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
	app.Post("/api/ai/jobs", AIJobStartHandler(service))
	request := httptest.NewRequest(fiber.MethodPost, "/api/ai/jobs", strings.NewReader(`{"type":"face","mode":"full"}`))
	request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	response, err := app.Test(request, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusForbidden {
		t.Fatalf("face start without opt-in status = %d", response.StatusCode)
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Code != "people_analysis_disabled" {
		t.Fatalf("face start error = %+v", body)
	}
}

func TestAIJobEstimateAPIReturnsModuleCounts(t *testing.T) {
	root := t.TempDir()
	albumPath := filepath.Join(root, "photos")
	if err := os.MkdirAll(albumPath, 0o755); err != nil {
		t.Fatal(err)
	}
	imageBytes := []byte{0xff, 0xd8, 0xff, 0xd9}
	files := make([]string, 0, 3)
	for index := 0; index < 3; index++ {
		path := filepath.Join(albumPath, fmt.Sprintf("%04d.jpg", index))
		if err := os.WriteFile(path, imageBytes, 0o600); err != nil {
			t.Fatal(err)
		}
		files = append(files, path)
	}

	catalog := services.NewResourceCatalog()
	catalog.Publish(&models.ScanResult{
		Roots: []string{root},
		Albums: []models.Album{{
			Type: "album", Name: "照片", Path: albumPath, SourceRoot: root,
			ImageFiles: files, CoverImage: files[0],
		}},
	}, []string{root})
	safety, safetyState := middleware.PathSafetyMiddleware([]string{root}, catalog)
	service, err := services.NewAIJobService(services.AIJobServiceOptions{
		StatePath:    filepath.Join(t.TempDir(), "state", "ai_jobs.json"),
		MetadataDir:  filepath.Join(t.TempDir(), "derived", "metadata"),
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
		if err := service.Shutdown(ctx); err != nil {
			t.Errorf("AI job shutdown: %v", err)
		}
	})

	app := fiber.New()
	api := app.Group("/api")
	api.Use(safety)
	// 核算必须排在带参数的路由之前，否则会被 /ai/jobs/:id 吃掉。
	api.Get("/ai/jobs/estimate", AIJobEstimateHandler(service))
	api.Get("/ai/jobs/:id", AIJobStatusHandler(service))

	response, err := app.Test(httptest.NewRequest(fiber.MethodGet, "/api/ai/jobs/estimate", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("estimate status = %d", response.StatusCode)
	}
	var body struct {
		OK       bool `json:"ok"`
		Estimate struct {
			LibraryReady bool `json:"libraryReady"`
			TotalImages  int  `json:"totalImages"`
			Modules      []struct {
				Type        string `json:"type"`
				Name        string `json:"name"`
				Installed   bool   `json:"installed"`
				Available   bool   `json:"available"`
				Incremental *struct {
					Count               int    `json:"count"`
					EstimatedDurationMs *int64 `json:"estimatedDurationMs"`
					SampleCount         int    `json:"sampleCount"`
				} `json:"incremental"`
				Full *struct {
					Count int `json:"count"`
				} `json:"full"`
			} `json:"modules"`
			Sequence struct {
				Incremental struct {
					Count int `json:"count"`
				} `json:"incremental"`
			} `json:"sequence"`
		} `json:"estimate"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || !body.Estimate.LibraryReady {
		t.Fatalf("estimate body = %+v", body)
	}
	if body.Estimate.TotalImages != 3 {
		t.Fatalf("total images = %d, want 3", body.Estimate.TotalImages)
	}
	if len(body.Estimate.Modules) != 4 {
		t.Fatalf("modules = %+v, want 4", body.Estimate.Modules)
	}
	metadata := body.Estimate.Modules[0]
	if metadata.Type != "metadata" || !metadata.Installed || !metadata.Available {
		t.Fatalf("metadata module = %+v", metadata)
	}
	if metadata.Incremental == nil || metadata.Incremental.Count != 3 {
		t.Fatalf("metadata incremental = %+v, want 3", metadata.Incremental)
	}
	if metadata.Full == nil || metadata.Full.Count != 3 {
		t.Fatalf("metadata full = %+v, want 3", metadata.Full)
	}
	if body.Estimate.Sequence.Incremental.Count != 3 {
		t.Fatalf("sequence count = %d, want 3", body.Estimate.Sequence.Incremental.Count)
	}
}

func TestAIJobEstimateAPIFailsWithoutService(t *testing.T) {
	app := fiber.New()
	app.Get("/api/ai/jobs/estimate", AIJobEstimateHandler(nil))
	response, err := app.Test(httptest.NewRequest(fiber.MethodGet, "/api/ai/jobs/estimate", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusServiceUnavailable {
		t.Fatalf("estimate status = %d, want 503", response.StatusCode)
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Code != "analysis_unavailable" {
		t.Fatalf("estimate error = %+v", body)
	}
}
