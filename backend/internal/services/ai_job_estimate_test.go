package services

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// estimateModule 按类型取出估算结果；找不到时测试直接失败。
func estimateModule(t *testing.T, estimate AIJobEstimate, moduleType string) AIJobEstimateModule {
	t.Helper()
	for _, module := range estimate.Modules {
		if module.Type == moduleType {
			return module
		}
	}
	t.Fatalf("estimate has no module %s: %+v", moduleType, estimate.Modules)
	return AIJobEstimateModule{}
}

// writeEstimateHistory 写一份合成的历史任务记录。
//
// elapsedMs 与 speedPerSecond 不落盘，耗时只能用 startedAt / finishedAt 与
// 实际分析张数重算 —— 合成记录要按落盘的字段来写。
func writeEstimateHistory(t *testing.T, statePath string, jobs []AIJob) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(statePath), 0o755); err != nil {
		t.Fatal(err)
	}
	state := aiJobDiskState{
		Version:  aiJobStoreVersion,
		Jobs:     jobs,
		Settings: AIJobSettings{DailyTime: "03:00", DailyModules: []string{AIJobTypeMetadata}},
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// estimateHistoryJob 造一条已结束的历史任务记录。
func estimateHistoryJob(id, moduleType, version string, images int, duration time.Duration, startedAt time.Time) AIJob {
	finished := startedAt.Add(duration)
	return AIJob{
		ID:            id,
		Type:          moduleType,
		Mode:          AIJobModeFull,
		Status:        AIJobStatusCompleted,
		Stage:         "complete",
		ModuleVersion: version,
		Total:         images,
		Processed:     images,
		Done:          images,
		StartedAt:     &startedAt,
		FinishedAt:    &finished,
		CreatedAt:     startedAt,
		UpdatedAt:     finished,
	}
}

func TestAIJobEstimateCountsPendingImagesPerMode(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 3)
	catalog := aiJobCatalog(root, files)
	service := newTestAIJobService(t, filepath.Join(t.TempDir(), "state", "ai_jobs.json"),
		filepath.Join(t.TempDir(), "derived", "metadata"), catalog, MetadataAnalyzer{})

	estimate, err := service.Estimate(context.Background())
	if err != nil {
		t.Fatalf("Estimate() error = %v", err)
	}
	if !estimate.LibraryReady {
		t.Fatalf("estimate reports library not ready: %+v", estimate)
	}
	if estimate.TotalImages != 3 {
		t.Fatalf("total images = %d, want 3", estimate.TotalImages)
	}
	metadata := estimateModule(t, estimate, AIJobTypeMetadata)
	if !metadata.Available {
		t.Fatalf("metadata module is not available: %+v", metadata)
	}
	if metadata.Incremental == nil || metadata.Incremental.Count != 3 {
		t.Fatalf("incremental count = %+v, want 3", metadata.Incremental)
	}
	if metadata.Full == nil || metadata.Full.Count != 3 {
		t.Fatalf("full count = %+v, want 3", metadata.Full)
	}
}

func TestAIJobEstimateMatchesJobPlannedAfterChange(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 3)
	catalog := aiJobCatalog(root, files)
	service := newTestAIJobService(t, filepath.Join(t.TempDir(), "state", "ai_jobs.json"),
		filepath.Join(t.TempDir(), "derived", "metadata"), catalog, MetadataAnalyzer{})

	job, _, err := service.Start(AIJobTypeMetadata, AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	waitForAIJob(t, service, job.ID, AIJobStatusCompleted)
	waitForAIJobIdle(t, service)

	// 改一张图：大小与修改时间都变，它就得被重新处理。
	changed := files[0]
	if err := os.WriteFile(changed, append(testExifJPEG(), 0x00), 0o600); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(changed, later, later); err != nil {
		t.Fatal(err)
	}

	estimate, err := service.Estimate(context.Background())
	if err != nil {
		t.Fatalf("Estimate() error = %v", err)
	}
	metadata := estimateModule(t, estimate, AIJobTypeMetadata)
	if metadata.Incremental == nil || metadata.Incremental.Count != 1 {
		t.Fatalf("incremental count = %+v, want 1 changed image", metadata.Incremental)
	}
	if metadata.Full == nil || metadata.Full.Count != 3 {
		t.Fatalf("full count = %+v, want 3", metadata.Full)
	}

	// 预估出来的张数必须与任务真正会处理的张数一致。
	incremental, _, err := service.Start(AIJobTypeMetadata, AIJobModeIncremental)
	if err != nil {
		t.Fatal(err)
	}
	incremental = waitForAIJob(t, service, incremental.ID, AIJobStatusCompleted)
	if incremental.Planned != 1 {
		t.Fatalf("job planned = %d, want the estimated 1", incremental.Planned)
	}
	waitForAIJobIdle(t, service)
}

func TestAIJobEstimateWithoutHistoryReportsNoDuration(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 2)
	catalog := aiJobCatalog(root, files)
	service := newTestAIJobService(t, filepath.Join(t.TempDir(), "state", "ai_jobs.json"),
		filepath.Join(t.TempDir(), "derived", "metadata"), catalog, MetadataAnalyzer{})

	estimate, err := service.Estimate(context.Background())
	if err != nil {
		t.Fatalf("Estimate() error = %v", err)
	}
	metadata := estimateModule(t, estimate, AIJobTypeMetadata)
	if metadata.Incremental == nil {
		t.Fatal("incremental estimate is missing")
	}
	if metadata.Incremental.EstimatedDurationMs != nil {
		t.Fatalf("duration without history = %d, want null", *metadata.Incremental.EstimatedDurationMs)
	}
	if metadata.Incremental.SampleCount != 0 {
		t.Fatalf("sample count without history = %d, want 0", metadata.Incremental.SampleCount)
	}
	// 没有历史不影响张数。
	if metadata.Incremental.Count != 2 {
		t.Fatalf("incremental count = %d, want 2", metadata.Incremental.Count)
	}
}

func TestAIJobEstimateUsesHistoricalThroughput(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 4)
	catalog := aiJobCatalog(root, files)
	statePath := filepath.Join(t.TempDir(), "state", "ai_jobs.json")
	started := time.Now().Add(-time.Hour)
	writeEstimateHistory(t, statePath, []AIJob{
		estimateHistoryJob("history-1", AIJobTypeMetadata, MetadataParserVersion, 100, 10*time.Second, started),
	})
	service := newTestAIJobService(t, statePath, filepath.Join(t.TempDir(), "derived", "metadata"),
		catalog, MetadataAnalyzer{})

	estimate, err := service.Estimate(context.Background())
	if err != nil {
		t.Fatalf("Estimate() error = %v", err)
	}
	metadata := estimateModule(t, estimate, AIJobTypeMetadata)
	incremental := metadata.Incremental
	if incremental == nil {
		t.Fatal("incremental estimate is missing")
	}
	if incremental.SampleCount != 1 || incremental.SampleImages != 100 {
		t.Fatalf("sample = %d runs / %d images, want 1 / 100", incremental.SampleCount, incremental.SampleImages)
	}
	// 每张 100 毫秒，四张约 400 毫秒。
	if incremental.EstimatedDurationMs == nil {
		t.Fatal("duration from history is missing")
	}
	if got := *incremental.EstimatedDurationMs; got < 350 || got > 450 {
		t.Fatalf("duration = %d ms, want about 400", got)
	}
}

func TestAIJobEstimateMediansOutlierRuns(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 2)
	catalog := aiJobCatalog(root, files)
	statePath := filepath.Join(t.TempDir(), "state", "ai_jobs.json")
	started := time.Now().Add(-time.Hour)
	writeEstimateHistory(t, statePath, []AIJob{
		estimateHistoryJob("history-1", AIJobTypeMetadata, MetadataParserVersion, 100, 10*time.Second, started),
		estimateHistoryJob("history-2", AIJobTypeMetadata, MetadataParserVersion, 100, 10*time.Second, started.Add(time.Minute)),
		// 一次卡了两小时的任务不该把整体带偏。
		estimateHistoryJob("history-3", AIJobTypeMetadata, MetadataParserVersion, 100, 2*time.Hour, started.Add(2*time.Minute)),
	})
	service := newTestAIJobService(t, statePath, filepath.Join(t.TempDir(), "derived", "metadata"),
		catalog, MetadataAnalyzer{})

	estimate, err := service.Estimate(context.Background())
	if err != nil {
		t.Fatalf("Estimate() error = %v", err)
	}
	incremental := estimateModule(t, estimate, AIJobTypeMetadata).Incremental
	if incremental == nil || incremental.EstimatedDurationMs == nil {
		t.Fatalf("incremental estimate = %+v", incremental)
	}
	// 中位数仍是每张 100 毫秒，两张约 200 毫秒；被离群值拉到两小时是错的。
	if got := *incremental.EstimatedDurationMs; got < 150 || got > 250 {
		t.Fatalf("duration = %d ms, want about 200 (median, not mean)", got)
	}
}

func TestAIJobEstimateLocksFaceUntilPeopleEnabled(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 2)
	catalog := aiJobCatalog(root, files)
	service := newTestAIJobService(t, filepath.Join(t.TempDir(), "state", "ai_jobs.json"),
		filepath.Join(t.TempDir(), "derived", "metadata"), catalog,
		MetadataAnalyzer{}, testJSONAnalyzer{module: AIJobTypeFace, version: "face-v1"})

	estimate, err := service.Estimate(context.Background())
	if err != nil {
		t.Fatalf("Estimate() error = %v", err)
	}
	face := estimateModule(t, estimate, AIJobTypeFace)
	if face.Available {
		t.Fatalf("face module is available while people analysis is off: %+v", face)
	}
	if face.Reason != "people_analysis_disabled" {
		t.Fatalf("face reason = %q, want people_analysis_disabled", face.Reason)
	}
	if face.Incremental != nil || face.Full != nil {
		t.Fatalf("locked module still reports counts: %+v", face)
	}

	if _, err := service.ConfigureDaily(false, "03:00", []string{AIJobTypeMetadata}, true); err != nil {
		t.Fatal(err)
	}
	estimate, err = service.Estimate(context.Background())
	if err != nil {
		t.Fatalf("Estimate() error = %v", err)
	}
	face = estimateModule(t, estimate, AIJobTypeFace)
	if !face.Available {
		t.Fatalf("face module is still locked: %+v", face)
	}
	if face.Incremental == nil || face.Full == nil {
		t.Fatalf("unlocked face module has no counts: %+v", face)
	}
}

func TestAIJobEstimateSequenceSumsAvailableModules(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 2)
	catalog := aiJobCatalog(root, files)
	service := newTestAIJobService(t, filepath.Join(t.TempDir(), "state", "ai_jobs.json"),
		filepath.Join(t.TempDir(), "derived", "metadata"), catalog,
		MetadataAnalyzer{}, testJSONAnalyzer{module: AIJobTypeOCR, version: "ocr-v1"})

	estimate, err := service.Estimate(context.Background())
	if err != nil {
		t.Fatalf("Estimate() error = %v", err)
	}
	sequence := estimate.Sequence
	if len(sequence.Incremental.Modules) != 2 {
		t.Fatalf("sequence modules = %v, want metadata and ocr", sequence.Incremental.Modules)
	}
	if sequence.Incremental.Count != 4 {
		t.Fatalf("incremental sequence count = %d, want 4", sequence.Incremental.Count)
	}
	if sequence.Full.Count != 4 {
		t.Fatalf("full sequence count = %d, want 4", sequence.Full.Count)
	}
	// 没有历史就不给合计耗时，不能拿 0 假装算得出来。
	if sequence.Incremental.EstimatedDurationMs != nil {
		t.Fatalf("sequence duration without history = %d, want null", *sequence.Incremental.EstimatedDurationMs)
	}
}

func TestAIJobEstimateListsModulesInFixedOrder(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 1)
	catalog := aiJobCatalog(root, files)
	service := newTestAIJobService(t, filepath.Join(t.TempDir(), "state", "ai_jobs.json"),
		filepath.Join(t.TempDir(), "derived", "metadata"), catalog, MetadataAnalyzer{})

	estimate, err := service.Estimate(context.Background())
	if err != nil {
		t.Fatalf("Estimate() error = %v", err)
	}
	want := []string{AIJobTypeMetadata, AIJobTypeEmbedding, AIJobTypeOCR, AIJobTypeFace}
	if len(estimate.Modules) != len(want) {
		t.Fatalf("modules = %+v, want %v", estimate.Modules, want)
	}
	for index, moduleType := range want {
		if estimate.Modules[index].Type != moduleType {
			t.Fatalf("module %d = %s, want %s", index, estimate.Modules[index].Type, moduleType)
		}
	}
}

func TestAIJobEstimateReportsLibraryNotReady(t *testing.T) {
	catalog := NewResourceCatalog()
	service := newTestAIJobService(t, filepath.Join(t.TempDir(), "state", "ai_jobs.json"),
		filepath.Join(t.TempDir(), "derived", "metadata"), catalog, MetadataAnalyzer{})

	estimate, err := service.Estimate(context.Background())
	if err != nil {
		t.Fatalf("Estimate() error = %v", err)
	}
	if estimate.LibraryReady {
		t.Fatalf("estimate reports a ready library: %+v", estimate)
	}
	if estimate.TotalImages != 0 {
		t.Fatalf("total images = %d, want 0", estimate.TotalImages)
	}
	if estimate.Sequence.Incremental.Modules == nil || estimate.Sequence.Full.Modules == nil {
		t.Fatalf("sequence module lists must be empty arrays while the library is unavailable: %+v", estimate.Sequence)
	}
	if len(estimate.Sequence.Incremental.Modules) != 0 || len(estimate.Sequence.Full.Modules) != 0 {
		t.Fatalf("sequence module lists must be empty while the library is unavailable: %+v", estimate.Sequence)
	}
}
