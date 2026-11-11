package handlers

import (
	"context"
	"encoding/json"
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

func TestNormalizedFaceCosineValidatesDimensionsAndZeroVectors(t *testing.T) {
	unit := oneHotFaceEmbedding()
	if score := normalizedCosine(unit, unit); score != 1 {
		t.Fatalf("same face similarity = %v, want 1", score)
	}
	if score := normalizedCosine(unit, []float32{1}); score >= 0 {
		t.Fatalf("invalid vector similarity = %v, want a negative sentinel", score)
	}
	if score := normalizedCosine(make([]float32, 128), unit); score >= 0 {
		t.Fatalf("zero vector similarity = %v, want a negative sentinel", score)
	}
}

func TestImageAnalysisHidesFaceEmbeddingsAndFindsSimilarPhoto(t *testing.T) {
	root := t.TempDir()
	albumPath := filepath.Join(root, "photos")
	if err := os.MkdirAll(albumPath, 0o755); err != nil {
		t.Fatal(err)
	}
	paths := []string{filepath.Join(albumPath, "source.jpg"), filepath.Join(albumPath, "match.jpg")}
	for _, path := range paths {
		if err := os.WriteFile(path, []byte("test image bytes"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	catalog := services.NewResourceCatalog()
	catalog.Publish(&models.ScanResult{Roots: []string{root}, Albums: []models.Album{{
		Type: "album", Name: "聚会照片", Path: albumPath, SourceRoot: root,
		ContentKind: string(models.ContentKindPhoto), ImageFiles: paths, CoverImage: paths[0],
	}}}, []string{root})
	ids := []string{catalog.ExternalID(paths[0], services.ResourceFile), catalog.ExternalID(paths[1], services.ResourceFile)}
	metadataDir := filepath.Join(t.TempDir(), "derived", "ai", "metadata")
	if err := os.MkdirAll(metadataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	faceData, _ := json.Marshal(map[string]any{"faces": []map[string]any{{
		"box": []float32{10, 12, 40, 42}, "score": 0.95, "embedding": oneHotFaceEmbedding(),
	}}})
	ocrData := json.RawMessage(`{"text":"家庭聚会","lines":[{"text":"家庭聚会","confidence":0.99,"box":[[1,2],[3,2],[3,4],[1,4]]}]}`)
	var records []services.AIAnalysisRecord
	for index, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		faceRecord := services.AIAnalysisRecord{
			Type: services.AIJobTypeFace, ResourceID: ids[index], Size: info.Size(), MTimeNs: info.ModTime().UnixNano(),
			ModuleVersion: services.FaceAnalyzerVersion, Status: "faces_found", Data: faceData, UpdatedAt: time.Now(),
		}
		records = append(records, faceRecord)
		if index == 0 {
			records = append(records, services.AIAnalysisRecord{
				Type: services.AIJobTypeOCR, ResourceID: ids[index], Size: info.Size(), MTimeNs: info.ModTime().UnixNano(),
				ModuleVersion: services.OCRAnalyzerVersion, Status: "recognized", Data: ocrData, UpdatedAt: time.Now(),
			})
		}
	}
	batch, _ := json.Marshal(map[string]any{"jobId": "fixture", "number": 1, "records": records})
	if err := os.WriteFile(filepath.Join(metadataDir, "fixture-0001.json"), batch, 0o600); err != nil {
		t.Fatal(err)
	}
	_, safetyState := middleware.PathSafetyMiddleware([]string{root}, catalog)
	worker := handlerImageAnalysisWorker{modules: map[string]services.AIWorkerModuleStatus{
		services.AIJobTypeOCR: {Ready: true}, services.AIJobTypeFace: {Ready: true},
	}}
	ocrAnalyzer, _ := services.NewOCRAnalyzer(worker)
	faceAnalyzer, _ := services.NewFaceAnalyzer(worker)
	jobs, err := services.NewAIJobService(services.AIJobServiceOptions{
		StatePath: filepath.Join(t.TempDir(), "state", "ai_jobs.json"), MetadataDir: metadataDir,
		Catalog: catalog, ValidatePath: safetyState.Validate,
		Analyzers: []services.AIAnalyzer{services.MetadataAnalyzer{}, ocrAnalyzer, faceAnalyzer},
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
	app := fiber.New()
	app.Get("/api/images/:id/analysis", middleware.ResourceParam(catalog, safetyState), ImageAnalysisHandler(jobs))
	app.Post("/api/ai/faces/search", FaceSimilaritySearchHandler(jobs, catalog, safetyState.Validate))

	analysisResponse, err := app.Test(httptest.NewRequest(http.MethodGet, "/api/images/"+ids[0]+"/analysis", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	analysisBytes, _ := io.ReadAll(analysisResponse.Body)
	_ = analysisResponse.Body.Close()
	if analysisResponse.StatusCode != http.StatusOK {
		t.Fatalf("image analysis status = %d: %s", analysisResponse.StatusCode, analysisBytes)
	}
	if !strings.Contains(string(analysisBytes), "家庭聚会") || !strings.Contains(string(analysisBytes), "faces_found") {
		t.Fatalf("image analysis missing OCR or face results: %s", analysisBytes)
	}
	if strings.Contains(string(analysisBytes), "embedding") {
		t.Fatalf("image analysis exposed a private face embedding: %s", analysisBytes)
	}

	searchRequest := httptest.NewRequest(http.MethodPost, "/api/ai/faces/search", strings.NewReader(`{"resourceId":"`+ids[0]+`","faceIndex":0}`))
	searchRequest.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	searchResponse, err := app.Test(searchRequest, -1)
	if err != nil {
		t.Fatal(err)
	}
	searchBytes, _ := io.ReadAll(searchResponse.Body)
	_ = searchResponse.Body.Close()
	if searchResponse.StatusCode != http.StatusOK {
		t.Fatalf("face search status = %d: %s", searchResponse.StatusCode, searchBytes)
	}
	if !strings.Contains(string(searchBytes), ids[1]) || !strings.Contains(string(searchBytes), `"similarity":1`) {
		t.Fatalf("face search did not return the matching photo: %s", searchBytes)
	}
	if strings.Contains(string(searchBytes), "embedding") {
		t.Fatalf("face search exposed a private face embedding: %s", searchBytes)
	}
}

type handlerImageAnalysisWorker struct {
	modules map[string]services.AIWorkerModuleStatus
}

func (w handlerImageAnalysisWorker) Status(context.Context) (services.AIWorkerStatus, error) {
	return services.AIWorkerStatus{Modules: w.modules}, nil
}
func (handlerImageAnalysisWorker) EmbedImages(context.Context, []string) ([]services.AIWorkerVector, error) {
	return nil, nil
}
func (handlerImageAnalysisWorker) EmbedTexts(context.Context, []string) ([]services.AIWorkerVector, error) {
	return nil, nil
}
func (handlerImageAnalysisWorker) AnalyzeOCR(context.Context, []string) ([]services.AIWorkerAnalysis, error) {
	return nil, nil
}
func (handlerImageAnalysisWorker) AnalyzeFaces(context.Context, []string) ([]services.AIWorkerAnalysis, error) {
	return nil, nil
}
func (w handlerImageAnalysisWorker) ModuleStatus(moduleType string) services.AIWorkerModuleStatus {
	return w.modules[moduleType]
}
func (handlerImageAnalysisWorker) Close() error { return nil }

func oneHotFaceEmbedding() []float32 {
	result := make([]float32, 128)
	result[0] = 1
	return result
}
