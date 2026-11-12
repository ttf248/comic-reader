package services

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

type fakeImageAnalysisWorker struct {
	modules map[string]AIWorkerModuleStatus
	ocr     []AIWorkerAnalysis
	faces   []AIWorkerAnalysis
}

func (f *fakeImageAnalysisWorker) Status(context.Context) (AIWorkerStatus, error) {
	return AIWorkerStatus{Modules: f.modules}, nil
}
func (f *fakeImageAnalysisWorker) EmbedImages(context.Context, []string) ([]AIWorkerVector, error) {
	return nil, nil
}
func (f *fakeImageAnalysisWorker) EmbedTexts(context.Context, []string) ([]AIWorkerVector, error) {
	return nil, nil
}
func (f *fakeImageAnalysisWorker) AnalyzeOCR(context.Context, []string) ([]AIWorkerAnalysis, error) {
	return f.ocr, nil
}
func (f *fakeImageAnalysisWorker) AnalyzeFaces(context.Context, []string) ([]AIWorkerAnalysis, error) {
	return f.faces, nil
}
func (f *fakeImageAnalysisWorker) ModuleStatus(moduleType string) AIWorkerModuleStatus {
	return f.modules[moduleType]
}
func (f *fakeImageAnalysisWorker) Close() error { return nil }

func TestImageAnalyzersProducePersistentModuleResults(t *testing.T) {
	worker := &fakeImageAnalysisWorker{
		modules: map[string]AIWorkerModuleStatus{
			AIJobTypeOCR:  {Ready: true},
			AIJobTypeFace: {Ready: true},
		},
		ocr:   []AIWorkerAnalysis{{Data: json.RawMessage(`{"text":"入口","lines":[{"text":"入口"}]}`)}},
		faces: []AIWorkerAnalysis{{Data: json.RawMessage(`{"faces":[{"box":[1,2,3,4],"score":0.9,"embedding":[1]}]}`)}},
	}
	inputs := []AIAnalysisInput{{ResourceID: "f_1", Path: "image.jpg", Size: 10, MTimeNs: 20}}
	ocr, err := NewOCRAnalyzer(worker)
	if err != nil {
		t.Fatal(err)
	}
	face, err := NewFaceAnalyzer(worker)
	if err != nil {
		t.Fatal(err)
	}
	ocrResults, err := ocr.AnalyzeBatch(context.Background(), inputs)
	if err != nil || len(ocrResults) != 1 || ocrResults[0].Status != "recognized" || len(ocrResults[0].Fields) != 1 {
		t.Fatalf("OCR results = %+v, error = %v", ocrResults, err)
	}
	faceResults, err := face.AnalyzeBatch(context.Background(), inputs)
	if err != nil || len(faceResults) != 1 || faceResults[0].Status != "faces_found" || len(faceResults[0].Fields) != 1 {
		t.Fatalf("face results = %+v, error = %v", faceResults, err)
	}
	if !ocr.RecordCurrent(AIAnalysisRecord{Type: AIJobTypeOCR, Status: "recognized", ModuleVersion: OCRAnalyzerVersion}) {
		t.Fatal("current OCR record was rejected")
	}
	if !face.RecordCurrent(AIAnalysisRecord{Type: AIJobTypeFace, Status: "faces_found", ModuleVersion: FaceAnalyzerVersion}) {
		t.Fatal("current face record was rejected")
	}
}

func TestImageAnalyzersPreserveGPUFailureCodes(t *testing.T) {
	inputs := []AIAnalysisInput{
		{ResourceID: "f_unavailable", Path: "first.jpg"},
		{ResourceID: "f_inference", Path: "second.jpg"},
	}
	outputs, err := analyzeImageBatch(
		context.Background(),
		inputs,
		func(context.Context, []string, string) ([]AIWorkerAnalysis, error) {
			return []AIWorkerAnalysis{
				{Error: "gpu_unavailable"},
				{Error: "gpu_inference_failed"},
			}, nil
		},
		AIFieldOCRText,
		func(json.RawMessage) bool { return false },
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(outputs) != 2 || outputs[0].ErrorCode != "gpu_unavailable" || outputs[1].ErrorCode != "gpu_inference_failed" {
		t.Fatalf("GPU failure outputs = %+v", outputs)
	}
}

func TestImageAnalyzersReportUnavailableModules(t *testing.T) {
	worker := &fakeImageAnalysisWorker{modules: map[string]AIWorkerModuleStatus{
		AIJobTypeOCR:  {Error: "ocr_dependencies_missing"},
		AIJobTypeFace: {Error: "face_model_missing_or_checksum_invalid"},
	}}
	ocr, _ := NewOCRAnalyzer(worker)
	face, _ := NewFaceAnalyzer(worker)
	if available, reason := ocr.Available(); available || reason != "ocr_dependencies_missing" {
		t.Fatalf("OCR availability = %v, %q", available, reason)
	}
	if available, reason := face.Available(); available || reason != "face_model_missing_or_checksum_invalid" {
		t.Fatalf("face availability = %v, %q", available, reason)
	}
	if err := ocr.Ready(context.Background()); err == nil {
		t.Fatal("OCR readiness accepted a missing runtime")
	}
	if err := face.Ready(context.Background()); err == nil {
		t.Fatal("face readiness accepted missing model weights")
	}
}

func TestAIJobModulesReflectImageRuntimeReadiness(t *testing.T) {
	root := t.TempDir()
	catalog := aiJobCatalog(root, nil)
	worker := &fakeImageAnalysisWorker{modules: map[string]AIWorkerModuleStatus{
		AIJobTypeOCR:  {Error: "ocr_dependencies_missing"},
		AIJobTypeFace: {Error: "face_model_missing_or_checksum_invalid"},
	}}
	ocr, _ := NewOCRAnalyzer(worker)
	face, _ := NewFaceAnalyzer(worker)
	service, err := NewAIJobService(AIJobServiceOptions{
		StatePath:    filepath.Join(t.TempDir(), "state", "ai_jobs.json"),
		MetadataDir:  filepath.Join(t.TempDir(), "derived", "metadata"),
		Catalog:      catalog,
		ValidatePath: aiTestPathValidator(t, root),
		Analyzers:    []AIAnalyzer{MetadataAnalyzer{}, ocr, face},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := service.Shutdown(context.Background()); err != nil {
			t.Errorf("shutdown AI jobs: %v", err)
		}
	}()
	modules := map[string]AIJobModule{}
	for _, module := range service.List().Modules {
		modules[module.Type] = module
	}
	if modules[AIJobTypeOCR].Installed || modules[AIJobTypeOCR].Reason != "ocr_dependencies_missing" {
		t.Fatalf("OCR module readiness = %+v", modules[AIJobTypeOCR])
	}
	if modules[AIJobTypeFace].Installed || modules[AIJobTypeFace].Reason != "face_model_missing_or_checksum_invalid" {
		t.Fatalf("face module readiness = %+v", modules[AIJobTypeFace])
	}
	if _, _, err := service.Start(AIJobTypeOCR, AIJobModeFull); !errors.Is(err, ErrAIAnalyzerUnavailable) {
		t.Fatalf("start unavailable OCR returned %v", err)
	}
}
