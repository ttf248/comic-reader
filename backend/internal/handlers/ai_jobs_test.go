package handlers

import (
	"context"
	"encoding/json"
	"fmt"
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
	var listBody struct {
		Snapshot services.AIJobSnapshot `json:"snapshot"`
	}
	if err := json.NewDecoder(listResponse.Body).Decode(&listBody); err != nil {
		t.Fatal(err)
	}
	if len(listBody.Snapshot.Jobs) != 1 || listBody.Snapshot.Jobs[0].Processed != 1001 {
		t.Fatalf("job list response = %+v", listBody.Snapshot)
	}
}
