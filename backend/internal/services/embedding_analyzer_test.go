package services

import (
	"context"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

type fakeEmbeddingWorker struct {
	imageBatches atomic.Int32
}

func (w *fakeEmbeddingWorker) Status(context.Context) (AIWorkerStatus, error) {
	return AIWorkerStatus{PythonAvailable: true, RuntimeReady: true, ModelAvailable: true, ModelValid: true}, nil
}

func (w *fakeEmbeddingWorker) EmbedImages(_ context.Context, paths []string) ([]AIWorkerVector, error) {
	w.imageBatches.Add(1)
	results := make([]AIWorkerVector, len(paths))
	for index := range results {
		vector := make([]float32, AIEmbeddingDimension)
		vector[index%2] = 1
		results[index].Vector = vector
	}
	return results, nil
}

func (w *fakeEmbeddingWorker) EmbedTexts(_ context.Context, texts []string) ([]AIWorkerVector, error) {
	results := make([]AIWorkerVector, len(texts))
	for index := range results {
		vector := make([]float32, AIEmbeddingDimension)
		vector[0] = 1
		results[index].Vector = vector
	}
	return results, nil
}

func (*fakeEmbeddingWorker) Close() error { return nil }

func TestEmbeddingAnalyzerUsesExistingTaskBatchesAndIncrementalRecords(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 1000)
	catalog := aiJobCatalog(root, files)
	statePath := filepath.Join(t.TempDir(), "state", "ai_jobs.json")
	metadataDir := filepath.Join(t.TempDir(), "derived", "metadata")
	index, err := OpenVectorIndex(filepath.Join(t.TempDir(), "derived", "ai", "vectors"), ChineseCLIPModelVersion)
	if err != nil {
		t.Fatal(err)
	}
	worker := &fakeEmbeddingWorker{}
	analyzer, err := NewEmbeddingAnalyzer(worker, index)
	if err != nil {
		t.Fatal(err)
	}
	service := newTestAIJobService(t, statePath, metadataDir, catalog, MetadataAnalyzer{}, analyzer)
	job, _, err := service.Start(AIJobTypeEmbedding, AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	job = waitForAIJob(t, service, job.ID, AIJobStatusCompleted)
	waitForAIJobIdle(t, service)
	expectedBatches := (len(files) + AIBatchSize - 1) / AIBatchSize
	if job.Processed != 1000 || int(worker.imageBatches.Load()) != expectedBatches || index.Status().Vectors != 1000 {
		t.Fatalf("embedding job=%+v batches=%d index=%+v", job, worker.imageBatches.Load(), index.Status())
	}
	incremental, _, err := service.Start(AIJobTypeEmbedding, AIJobModeIncremental)
	if err != nil {
		t.Fatal(err)
	}
	incremental = waitForAIJob(t, service, incremental.ID, AIJobStatusCompleted)
	waitForAIJobIdle(t, service)
	if incremental.Processed != 0 || incremental.Skipped != 1000 {
		t.Fatalf("unchanged incremental job = %+v", incremental)
	}
	changedAt := time.Now().Add(2 * time.Second)
	if err := os.WriteFile(files[0], append(testExifJPEG(), 1), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(files[0], changedAt, changedAt); err != nil {
		t.Fatal(err)
	}
	changed, _, err := service.Start(AIJobTypeEmbedding, AIJobModeIncremental)
	if err != nil {
		t.Fatal(err)
	}
	changed = waitForAIJob(t, service, changed.ID, AIJobStatusCompleted)
	if changed.Processed != 1 || changed.Skipped != 999 {
		t.Fatalf("changed incremental job = %+v", changed)
	}
}

func TestEmbeddingAnalyzerPreservesGPUFailureCodes(t *testing.T) {
	index, err := OpenVectorIndex(filepath.Join(t.TempDir(), "vectors"), ChineseCLIPModelVersion)
	if err != nil {
		t.Fatal(err)
	}
	defer index.Close()

	worker := &gpuFailureEmbeddingWorker{fakeEmbeddingWorker: &fakeEmbeddingWorker{}}
	analyzer, err := NewEmbeddingAnalyzer(worker, index)
	if err != nil {
		t.Fatal(err)
	}
	outputs, err := analyzer.AnalyzeBatch(context.Background(), []AIAnalysisInput{
		{ResourceID: "f_unavailable", Path: "first.jpg", ComputeDevice: "cpu"},
		{ResourceID: "f_inference", Path: "second.jpg", ComputeDevice: "cpu"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(outputs) != 2 || outputs[0].ErrorCode != "gpu_unavailable" || outputs[1].ErrorCode != "gpu_inference_failed" {
		t.Fatalf("GPU failure outputs = %+v", outputs)
	}
}

type gpuFailureEmbeddingWorker struct {
	*fakeEmbeddingWorker
}

func (*gpuFailureEmbeddingWorker) EmbedImages(context.Context, []string) ([]AIWorkerVector, error) {
	return []AIWorkerVector{
		{Error: "gpu_unavailable"},
		{Error: "gpu_inference_failed"},
	}, nil
}

func TestEmbeddingAnalyzerDoesNotStartWithoutVerifiedModel(t *testing.T) {
	index, err := OpenVectorIndex(filepath.Join(t.TempDir(), "vectors"), ChineseCLIPModelVersion)
	if err != nil {
		t.Fatal(err)
	}
	defer index.Close()
	worker := &missingModelEmbeddingWorker{}
	analyzer, err := NewEmbeddingAnalyzer(worker, index)
	if err != nil {
		t.Fatal(err)
	}
	if err := analyzer.Ready(context.Background()); err != ErrAIModelUnavailable {
		t.Fatalf("Ready() = %v, want model unavailable", err)
	}
}

type missingModelEmbeddingWorker struct{ fakeEmbeddingWorker }

func (*missingModelEmbeddingWorker) Status(context.Context) (AIWorkerStatus, error) {
	return AIWorkerStatus{PythonAvailable: true, RuntimeReady: true, ModelAvailable: false, ModelValid: false}, nil
}
