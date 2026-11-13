package handlers

import (
	"context"
	"fmt"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func BenchmarkPeopleListWith1000Faces(b *testing.B) {
	const photoCount = 1000
	root := b.TempDir()
	photoRoot := filepath.Join(root, "photos")
	if err := os.MkdirAll(photoRoot, 0o755); err != nil {
		b.Fatal(err)
	}
	files := make([]string, photoCount)
	for index := range files {
		path := filepath.Join(photoRoot, fmt.Sprintf("photo-%05d.jpg", index))
		if err := os.WriteFile(path, []byte("test"), 0o600); err != nil {
			b.Fatal(err)
		}
		files[index] = path
	}

	catalog := services.NewResourceCatalog()
	catalog.Publish(&models.ScanResult{
		Roots: []string{root},
		Albums: []models.Album{{
			Type: "album", Name: "性能测试", Path: photoRoot, SourceRoot: root,
			ContentKind: string(models.ContentKindPhoto), ImageFiles: files, CoverImage: files[0],
		}},
	}, []string{root})
	safety, safetyState := middleware.PathSafetyMiddleware([]string{root}, catalog)
	people, err := services.OpenPeopleService(filepath.Join(root, "state", "people.json"), filepath.Join(root, "derived", "people-index.json"))
	if err != nil {
		b.Fatal(err)
	}
	if err := people.Sync(nil); err != nil {
		b.Fatal(err)
	}
	jobs, err := services.NewAIJobService(services.AIJobServiceOptions{
		StatePath:    filepath.Join(root, "state", "ai_jobs.json"),
		MetadataDir:  filepath.Join(root, "derived", "ai"),
		Catalog:      catalog,
		ValidatePath: safetyState.Validate,
		Analyzers:    []services.AIAnalyzer{services.MetadataAnalyzer{}, peopleHandlerAnalyzer{}},
		OnRecordsCommitted: func(records []services.AIAnalysisRecord) {
			if err := people.ApplyRecords(records); err != nil {
				b.Errorf("apply face records: %v", err)
			}
		},
	})
	if err != nil {
		b.Fatal(err)
	}
	if _, err := jobs.SetGPUEnabled(false); err != nil {
		b.Fatal(err)
	}
	if _, err := jobs.SetPeopleEnabled(true); err != nil {
		b.Fatal(err)
	}
	job, _, err := jobs.Start(services.AIJobTypeFace, services.AIJobModeFull)
	if err != nil {
		b.Fatal(err)
	}
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		current, exists := jobs.Get(job.ID)
		if exists && (current.Status == services.AIJobStatusCompleted || current.Status == services.AIJobStatusFailed) {
			if current.Status != services.AIJobStatusCompleted {
				b.Fatalf("synthetic face analysis failed: %+v", current)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if current, _ := jobs.Get(job.ID); current.Status != services.AIJobStatusCompleted {
		b.Fatalf("synthetic face analysis timed out: %+v", current)
	}

	app := fiber.New()
	app.Use(safety)
	app.Get("/api/people", PeopleHandler(people, jobs, catalog, safetyState.Validate))
	b.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := jobs.Shutdown(ctx); err != nil {
			b.Errorf("shut down AI jobs: %v", err)
		}
	})

	request := httptest.NewRequest(fiber.MethodGet, "/api/people", nil)
	b.ReportMetric(photoCount, "faces/op")
	b.ResetTimer()
	for range b.N {
		response, err := app.Test(request, -1)
		if err != nil {
			b.Fatal(err)
		}
		if _, err := io.Copy(io.Discard, response.Body); err != nil {
			response.Body.Close()
			b.Fatal(err)
		}
		response.Body.Close()
	}
	b.StopTimer()
}
