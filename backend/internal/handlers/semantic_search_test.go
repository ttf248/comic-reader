package handlers

import (
	"context"
	"encoding/json"
	"io"
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
	"github.com/tianlongxiang/local-gallery/internal/store"
)

type handlerSemanticWorker struct{}

type handlerMetadataAnalyzer struct{}

func (handlerMetadataAnalyzer) Type() string    { return services.AIJobTypeMetadata }
func (handlerMetadataAnalyzer) Version() string { return services.MetadataParserVersion }
func (handlerMetadataAnalyzer) Analyze(context.Context, io.ReadSeeker) (services.AIAnalysisOutput, error) {
	data, _ := json.Marshal(services.ImageMetadata{Status: services.MetadataParseNoExif})
	return services.AIAnalysisOutput{Status: services.MetadataParseNoExif, Data: data}, nil
}
func (handlerMetadataAnalyzer) AnalyzeBatch(_ context.Context, inputs []services.AIAnalysisInput) ([]services.AIAnalysisOutput, error) {
	outputs := make([]services.AIAnalysisOutput, len(inputs))
	for index, input := range inputs {
		metadata := services.ImageMetadata{Status: services.MetadataParseParsed, DateTimeOriginal: "2023:06:01 10:00:00"}
		if filepath.Base(input.Path) == "first.jpg" {
			metadata.DateTimeOriginal = "2024:06:01 10:00:00"
			metadata.GPS = &services.GPSMetadata{Latitude: 39.9, Longitude: 116.4}
		}
		data, _ := json.Marshal(metadata)
		outputs[index] = services.AIAnalysisOutput{
			Status: services.MetadataParseParsed, Data: data,
			Fields: []string{services.AIFieldExifTime, services.AIFieldGPS},
		}
	}
	return outputs, nil
}

func (handlerSemanticWorker) Status(context.Context) (services.AIWorkerStatus, error) {
	return services.AIWorkerStatus{
		PythonAvailable: true, RuntimeReady: true, CUDAAvailable: true,
		Device: "cuda", ModelAvailable: true, ModelValid: true,
		ModelVersion: services.ChineseCLIPModelVersion,
		Modules: map[string]services.AIWorkerModuleStatus{
			services.AIJobTypeOCR:  {Ready: true, Version: services.OCRAnalyzerVersion},
			services.AIJobTypeFace: {Ready: true, Version: services.FaceAnalyzerVersion},
		},
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

func (handlerSemanticWorker) AnalyzeOCR(_ context.Context, paths []string) ([]services.AIWorkerAnalysis, error) {
	results := make([]services.AIWorkerAnalysis, len(paths))
	for index, path := range paths {
		text := "海边 漫步"
		if filepath.Base(path) == "first.jpg" {
			text = "入口 大门"
		}
		data, _ := json.Marshal(map[string]string{"text": text})
		results[index].Data = data
	}
	return results, nil
}

func (handlerSemanticWorker) AnalyzeFaces(_ context.Context, paths []string) ([]services.AIWorkerAnalysis, error) {
	results := make([]services.AIWorkerAnalysis, len(paths))
	for index := range results {
		vector := make([]float32, 128)
		vector[0] = 1
		data, _ := json.Marshal(struct {
			Faces []struct {
				Box       []float32 `json:"box"`
				Score     float32   `json:"score"`
				Embedding []float32 `json:"embedding"`
			} `json:"faces"`
		}{Faces: []struct {
			Box       []float32 `json:"box"`
			Score     float32   `json:"score"`
			Embedding []float32 `json:"embedding"`
		}{{Box: []float32{0.1, 0.1, 0.5, 0.5}, Score: 0.99, Embedding: vector}}})
		results[index].Data = data
	}
	return results, nil
}

func (handlerSemanticWorker) ModuleStatus(moduleType string) services.AIWorkerModuleStatus {
	return services.AIWorkerModuleStatus{Ready: true, Version: moduleType + "-test"}
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
	ocrIndex, err := services.OpenOCRSearchIndex(filepath.Join(t.TempDir(), "ocr-index.json"))
	if err != nil {
		t.Fatal(err)
	}
	ocrAnalyzer, err := services.NewOCRAnalyzer(handlerSemanticWorker{})
	if err != nil {
		t.Fatal(err)
	}
	faceAnalyzer, err := services.NewFaceAnalyzer(handlerSemanticWorker{})
	if err != nil {
		t.Fatal(err)
	}
	peopleService, err := services.OpenPeopleService(filepath.Join(t.TempDir(), "state", "people.json"), filepath.Join(t.TempDir(), "derived", "people-index.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := peopleService.Sync(nil); err != nil {
		t.Fatal(err)
	}
	jobs, err := services.NewAIJobService(services.AIJobServiceOptions{
		StatePath:   filepath.Join(t.TempDir(), "state", "ai_jobs.json"),
		MetadataDir: filepath.Join(t.TempDir(), "metadata"),
		Catalog:     catalog, ValidatePath: safetyState.Validate,
		Analyzers: []services.AIAnalyzer{handlerMetadataAnalyzer{}, analyzer, ocrAnalyzer, faceAnalyzer},
		OnRecordsCommitted: func(records []services.AIAnalysisRecord) {
			if err := ocrIndex.ApplyRecords(records); err != nil {
				t.Errorf("update OCR index: %v", err)
			}
			if err := peopleService.ApplyRecords(records); err != nil {
				t.Errorf("update people index: %v", err)
			}
		},
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
	ocrJob, _, err := jobs.Start(services.AIJobTypeOCR, services.AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		current, exists := jobs.Get(ocrJob.ID)
		if exists && (current.Status == services.AIJobStatusCompleted || current.Status == services.AIJobStatusFailed) {
			if current.Status != services.AIJobStatusCompleted {
				t.Fatalf("OCR job failed: %+v", current)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if current, _ := jobs.Get(ocrJob.ID); current.Status != services.AIJobStatusCompleted {
		t.Fatalf("OCR job did not complete: %+v", current)
	}
	metadataJob, _, err := jobs.Start(services.AIJobTypeMetadata, services.AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		current, exists := jobs.Get(metadataJob.ID)
		if exists && (current.Status == services.AIJobStatusCompleted || current.Status == services.AIJobStatusFailed) {
			if current.Status != services.AIJobStatusCompleted {
				t.Fatalf("metadata job failed: %+v", current)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if current, _ := jobs.Get(metadataJob.ID); current.Status != services.AIJobStatusCompleted {
		t.Fatalf("metadata job did not complete: %+v", current)
	}
	if _, err := jobs.SetPeopleEnabled(true); err != nil {
		t.Fatal(err)
	}
	faceJob, _, err := jobs.Start(services.AIJobTypeFace, services.AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		current, exists := jobs.Get(faceJob.ID)
		if exists && (current.Status == services.AIJobStatusCompleted || current.Status == services.AIJobStatusFailed) {
			if current.Status != services.AIJobStatusCompleted {
				t.Fatalf("face job failed: %+v", current)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if current, _ := jobs.Get(faceJob.ID); current.Status != services.AIJobStatusCompleted {
		t.Fatalf("face job did not complete: %+v", current)
	}

	app := fiber.New()
	api := app.Group("/api")
	api.Use(safety)
	prefs := store.NewPrefsStore(filepath.Join(t.TempDir(), "prefs.json"))
	picks := store.NewPickStore(filepath.Join(t.TempDir(), "picks.json"))
	api.Post("/ai/search", SemanticSearchHandler(analyzer, jobs, ocrIndex, catalog, safetyState.Validate, t.TempDir(), prefs, picks, peopleService))
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

	ocrRequest := httptest.NewRequest("POST", "/api/ai/search", strings.NewReader(`{"ocrText":"入口","kind":"photo","limit":10}`))
	ocrRequest.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	ocrResponse, err := app.Test(ocrRequest, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer ocrResponse.Body.Close()
	if ocrResponse.StatusCode != fiber.StatusOK {
		t.Fatalf("OCR search status = %d", ocrResponse.StatusCode)
	}
	var ocrBody struct {
		Results []struct {
			Item struct {
				ID string `json:"id"`
			} `json:"item"`
			Similarity *float64 `json:"similarity"`
		} `json:"results"`
		Total int `json:"total"`
	}
	if err := json.NewDecoder(ocrResponse.Body).Decode(&ocrBody); err != nil {
		t.Fatal(err)
	}
	if ocrBody.Total != 1 || len(ocrBody.Results) != 1 || ocrBody.Results[0].Item.ID != firstID || ocrBody.Results[0].Similarity != nil {
		t.Fatalf("OCR search response = %+v", ocrBody)
	}
	albumID := catalog.ExternalID(albumPath, services.ResourceAlbum)
	if _, err := prefs.AddFavorite(albumID); err != nil {
		t.Fatal(err)
	}
	if _, err := picks.Batch([]string{firstID}, true); err != nil {
		t.Fatal(err)
	}
	peopleGroups := peopleService.Groups(false)
	if len(peopleGroups) != 1 {
		t.Fatalf("test faces should form one candidate group: %+v", peopleGroups)
	}
	combinedBody, _ := json.Marshal(map[string]any{
		"ocrText": "入口", "albumId": albumID, "personId": peopleGroups[0].ID,
		"favoriteOnly": true, "pickedOnly": true, "year": "2024",
		"locationId": services.GPSLocationID(39.9, 116.4), "kind": "photo", "limit": 10,
	})
	combinedRequest := httptest.NewRequest("POST", "/api/ai/search", strings.NewReader(string(combinedBody)))
	combinedRequest.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	combinedResponse, err := app.Test(combinedRequest, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer combinedResponse.Body.Close()
	var combinedResult struct {
		Results []struct {
			Item struct {
				ID string `json:"id"`
			} `json:"item"`
		} `json:"results"`
		Total int `json:"total"`
	}
	if combinedResponse.StatusCode != fiber.StatusOK {
		t.Fatalf("combined search status = %d", combinedResponse.StatusCode)
	}
	if err := json.NewDecoder(combinedResponse.Body).Decode(&combinedResult); err != nil {
		t.Fatal(err)
	}
	if combinedResult.Total != 1 || len(combinedResult.Results) != 1 || combinedResult.Results[0].Item.ID != firstID {
		t.Fatalf("combined structured filters response = %+v", combinedResult)
	}

	imageRequest := httptest.NewRequest("POST", "/api/ai/search", strings.NewReader(`{"resourceId":"`+firstID+`","kind":"photo","limit":10}`))
	imageRequest.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	imageResponse, err := app.Test(imageRequest, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer imageResponse.Body.Close()
	if imageResponse.StatusCode != fiber.StatusOK {
		t.Fatalf("image search status = %d", imageResponse.StatusCode)
	}
	if err := json.NewDecoder(imageResponse.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || body.Total != 2 || len(body.Results) != 2 || body.Results[0].Item.ID != firstID || body.Results[0].Similarity < 0.99 {
		t.Fatalf("image similarity response = %+v", body)
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), root) {
		t.Fatalf("semantic response exposed the local media path: %s", encoded)
	}
}
