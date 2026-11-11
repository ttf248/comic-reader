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

type handlerSemanticWorker struct{}

func (handlerSemanticWorker) Status(context.Context) (services.AIWorkerStatus, error) {
	return services.AIWorkerStatus{
		PythonAvailable: true, RuntimeReady: true, CUDAAvailable: true,
		Device: "cuda", ModelAvailable: true, ModelValid: true,
		ModelVersion: services.ChineseCLIPModelVersion,
	}, nil
}

func (handlerSemanticWorker) EmbedImages(_ context.Context, paths []string) ([]services.AIWorkerVector, error) {
	results := make([]services.AIWorkerVector, len(paths))
	for index, path := range paths {
		vector := make([]float32, services.AIEmbeddingDimension)
		if filepath.Base(path) == "first.jpg" {
			vector[0] = 1
		} else {
			vector[1] = 1
		}
		results[index].Vector = vector
	}
	return results, nil
}

func (handlerSemanticWorker) EmbedTexts(_ context.Context, texts []string) ([]services.AIWorkerVector, error) {
	results := make([]services.AIWorkerVector, len(texts))
	for index := range results {
		vector := make([]float32, services.AIEmbeddingDimension)
		vector[0] = 1
		results[index].Vector = vector
	}
	return results, nil
}

func (handlerSemanticWorker) Close() error { return nil }

func TestSemanticSearchAPIUsesCurrentIndexedResources(t *testing.T) {
	root := t.TempDir()
	albumPath := filepath.Join(root, "photos")
	if err := os.MkdirAll(albumPath, 0o755); err != nil {
		t.Fatal(err)
	}
	files := []string{filepath.Join(albumPath, "first.jpg"), filepath.Join(albumPath, "second.jpg")}
	for _, path := range files {
		if err := os.WriteFile(path, []byte("test image bytes"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	catalog := services.NewResourceCatalog()
	catalog.Publish(&models.ScanResult{
		Roots: []string{root},
		Albums: []models.Album{{
			Type: "album", Name: "风景", Path: albumPath, SourceRoot: root,
			ContentKind: string(models.ContentKindPhoto), ImageFiles: files, CoverImage: files[0],
		}},
	}, []string{root})
	safety, safetyState := middleware.PathSafetyMiddleware([]string{root}, catalog)
	vectorIndex, err := services.OpenVectorIndex(filepath.Join(t.TempDir(), "vectors"), services.ChineseCLIPModelVersion)
	if err != nil {
		t.Fatal(err)
	}
	analyzer, err := services.NewEmbeddingAnalyzer(handlerSemanticWorker{}, vectorIndex)
	if err != nil {
		t.Fatal(err)
	}
	jobs, err := services.NewAIJobService(services.AIJobServiceOptions{
		StatePath:   filepath.Join(t.TempDir(), "state", "ai_jobs.json"),
		MetadataDir: filepath.Join(t.TempDir(), "metadata"),
		Catalog:     catalog, ValidatePath: safetyState.Validate,
		Analyzers: []services.AIAnalyzer{services.MetadataAnalyzer{}, analyzer},
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
	job, _, err := jobs.Start(services.AIJobTypeEmbedding, services.AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		current, exists := jobs.Get(job.ID)
		if exists && (current.Status == services.AIJobStatusCompleted || current.Status == services.AIJobStatusFailed) {
			if current.Status != services.AIJobStatusCompleted {
				t.Fatalf("index job failed: %+v", current)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if current, _ := jobs.Get(job.ID); current.Status != services.AIJobStatusCompleted {
		t.Fatalf("index job did not complete: %+v", current)
	}

	app := fiber.New()
	api := app.Group("/api")
	api.Use(safety)
	api.Post("/ai/search", SemanticSearchHandler(analyzer, jobs, catalog, safetyState.Validate, t.TempDir()))
	request := httptest.NewRequest("POST", "/api/ai/search", strings.NewReader(`{"text":"蓝色山景","kind":"photo","limit":10}`))
	request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	response, err := app.Test(request, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("search status = %d", response.StatusCode)
	}
	var body struct {
		OK      bool `json:"ok"`
		Results []struct {
			Item struct {
				ID        string `json:"id"`
				AlbumName string `json:"albumName"`
			} `json:"item"`
			Similarity float64 `json:"similarity"`
		} `json:"results"`
		Total int `json:"total"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	firstID := catalog.ExternalID(files[0], services.ResourceFile)
	if !body.OK || body.Total != 2 || len(body.Results) != 2 || body.Results[0].Item.ID != firstID || body.Results[0].Item.AlbumName != "风景" || body.Results[0].Similarity < 0.99 {
		t.Fatalf("semantic search response = %+v", body)
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), root) {
		t.Fatalf("semantic response exposed the local media path: %s", encoded)
	}
}
