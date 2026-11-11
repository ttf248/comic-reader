package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/models"
)

func TestAIJobServiceFullIncrementalAndPersistentResults(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 3)
	catalog := aiJobCatalog(root, files)
	statePath := filepath.Join(t.TempDir(), "state", "ai_jobs.json")
	metadataDir := filepath.Join(t.TempDir(), "derived", "metadata")
	service := newTestAIJobService(t, statePath, metadataDir, catalog, MetadataAnalyzer{})

	full, reused, err := service.Start(AIJobTypeMetadata, AIJobModeFull)
	if err != nil || reused {
		t.Fatalf("Start(full) = (%+v, %v, %v)", full, reused, err)
	}
	full = waitForAIJob(t, service, full.ID, AIJobStatusCompleted)
	if full.Total != 3 || full.Processed != 3 || full.Skipped != 0 || full.Failed != 0 || full.Done != 3 {
		t.Fatalf("full job counts = %+v", full)
	}
	waitForAIJobIdle(t, service)

	incremental, reused, err := service.Start(AIJobTypeMetadata, AIJobModeIncremental)
	if err != nil || reused {
		t.Fatalf("Start(incremental) = (%+v, %v, %v)", incremental, reused, err)
	}
	incremental = waitForAIJob(t, service, incremental.ID, AIJobStatusCompleted)
	if incremental.Total != 3 || incremental.Processed != 0 || incremental.Skipped != 3 || incremental.Done != 3 {
		t.Fatalf("incremental counts = %+v", incremental)
	}
	if records := service.Records(AIJobTypeMetadata); len(records) != 3 {
		t.Fatalf("metadata records = %d, want 3", len(records))
	}
	waitForAIJobIdle(t, service)
	shutdownAIJobService(t, service)

	restarted := newTestAIJobService(t, statePath, metadataDir, catalog, MetadataAnalyzer{})
	if snapshot := restarted.List(); len(snapshot.Jobs) != 2 || !snapshot.Settings.DailyEnabled || snapshot.Settings.DailyTime != "03:00" {
		t.Fatalf("restarted snapshot = %+v", snapshot)
	}
	if records := restarted.Records(AIJobTypeMetadata); len(records) != 3 {
		t.Fatalf("reloaded metadata records = %d, want 3", len(records))
	}
	shutdownAIJobService(t, restarted)
}

func TestAIJobServiceIncrementalDetectsChangedFilesAndModuleVersion(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 3)
	catalog := aiJobCatalog(root, files)
	statePath := filepath.Join(t.TempDir(), "state", "jobs.json")
	metadataDir := filepath.Join(t.TempDir(), "derived")
	service := newTestAIJobService(t, statePath, metadataDir, catalog, MetadataAnalyzer{})
	full, _, err := service.Start(AIJobTypeMetadata, AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	waitForAIJob(t, service, full.ID, AIJobStatusCompleted)
	waitForAIJobIdle(t, service)

	changedTime := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(files[1], changedTime, changedTime); err != nil {
		t.Fatal(err)
	}
	incremental, _, err := service.Start(AIJobTypeMetadata, AIJobModeIncremental)
	if err != nil {
		t.Fatal(err)
	}
	incremental = waitForAIJob(t, service, incremental.ID, AIJobStatusCompleted)
	if incremental.Processed != 1 || incremental.Skipped != 2 {
		t.Fatalf("changed-file incremental counts = %+v", incremental)
	}
	waitForAIJobIdle(t, service)
	shutdownAIJobService(t, service)

	upgraded := newTestAIJobService(t, statePath, metadataDir, catalog, versionedMetadataAnalyzer{version: "metadata-v2"})
	newVersion, _, err := upgraded.Start(AIJobTypeMetadata, AIJobModeIncremental)
	if err != nil {
		t.Fatal(err)
	}
	newVersion = waitForAIJob(t, upgraded, newVersion.ID, AIJobStatusCompleted)
	if newVersion.Processed != 3 || newVersion.Skipped != 0 {
		t.Fatalf("metadata parser version did not invalidate old records: %+v", newVersion)
	}
	shutdownAIJobService(t, upgraded)
}

func TestAIJobServiceRetriesOnlyFailedAndUncommittedResources(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 2)
	catalog := aiJobCatalog(root, files)
	statePath := filepath.Join(t.TempDir(), "state", "ai_jobs.json")
	metadataDir := filepath.Join(t.TempDir(), "derived", "metadata")
	failing := &failOnceAnalyzer{started: make(chan struct{}), release: make(chan struct{})}
	service := newTestAIJobService(t, statePath, metadataDir, catalog, failing)

	job, _, err := service.Start(AIJobTypeMetadata, AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-failing.started:
	case <-time.After(3 * time.Second):
		t.Fatal("analyzer did not start")
	}
	close(failing.release)
	job = waitForAIJob(t, service, job.ID, AIJobStatusFailed)
	if job.Failed != 1 || len(job.Errors) != 1 || job.Errors[0].ResourceID == "" || filepath.IsAbs(job.Errors[0].Message) {
		t.Fatalf("failed job details = %+v", job)
	}
	waitForAIJobIdle(t, service)

	retry, err := service.Retry(job.ID)
	if err != nil {
		t.Fatal(err)
	}
	retry = waitForAIJob(t, service, retry.ID, AIJobStatusCompleted)
	if retry.RetryOf != job.ID || retry.Processed != 1 || retry.Skipped != 1 || retry.Failed != 0 {
		t.Fatalf("retry job = %+v", retry)
	}
	shutdownAIJobService(t, service)
}

func TestAIJobServicePauseResumeAndShutdownRecovery(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, aiBatchSize+3)
	catalog := aiJobCatalog(root, files)
	statePath := filepath.Join(t.TempDir(), "state", "ai_jobs.json")
	metadataDir := filepath.Join(t.TempDir(), "derived", "metadata")
	blocking := &blockingAnalyzer{started: make(chan struct{}), release: make(chan struct{})}
	service := newTestAIJobService(t, statePath, metadataDir, catalog, blocking)

	job, _, err := service.Start(AIJobTypeMetadata, AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-blocking.started:
	case <-time.After(3 * time.Second):
		t.Fatal("analyzer did not start")
	}
	if !service.Pause(job.ID) {
		t.Fatal("Pause() returned false")
	}
	close(blocking.release)
	job = waitForAIJob(t, service, job.ID, AIJobStatusPaused)
	if job.Done != aiBatchSize || job.Checkpoint.Offset != aiBatchSize {
		t.Fatalf("paused checkpoint = %+v", job)
	}
	if !service.Resume(job.ID) {
		t.Fatal("Resume() returned false")
	}
	job = waitForAIJob(t, service, job.ID, AIJobStatusCompleted)
	if job.Processed != len(files) || job.Done != len(files) {
		t.Fatalf("resumed job counts = %+v", job)
	}
	waitForAIJobIdle(t, service)
	shutdownAIJobService(t, service)

	secondRoot := t.TempDir()
	secondFiles := writeAIJobImages(t, secondRoot, 2)
	secondCatalog := aiJobCatalog(secondRoot, secondFiles)
	secondState := filepath.Join(t.TempDir(), "state", "ai_jobs.json")
	secondMetadata := filepath.Join(t.TempDir(), "derived", "metadata")
	shutdownAnalyzer := &blockingAnalyzer{started: make(chan struct{}), release: make(chan struct{})}
	first := newTestAIJobService(t, secondState, secondMetadata, secondCatalog, shutdownAnalyzer)
	interrupted, _, err := first.Start(AIJobTypeMetadata, AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-shutdownAnalyzer.started:
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown analyzer did not start")
	}
	shutdownAIJobService(t, first)
	interrupted, ok := first.Get(interrupted.ID)
	if !ok || interrupted.Status != AIJobStatusPending {
		t.Fatalf("shutdown did not preserve pending checkpoint: %+v", interrupted)
	}

	resumed := newTestAIJobService(t, secondState, secondMetadata, secondCatalog, MetadataAnalyzer{})
	resumed.StartPending()
	interrupted = waitForAIJob(t, resumed, interrupted.ID, AIJobStatusCompleted)
	if interrupted.Processed != len(secondFiles) {
		t.Fatalf("recovered job = %+v", interrupted)
	}
	shutdownAIJobService(t, resumed)

	pausedRoot := t.TempDir()
	pausedFiles := writeAIJobImages(t, pausedRoot, aiBatchSize+1)
	pausedCatalog := aiJobCatalog(pausedRoot, pausedFiles)
	pausedState := filepath.Join(t.TempDir(), "state", "ai_jobs.json")
	pausedMetadata := filepath.Join(t.TempDir(), "derived", "metadata")
	pausedAnalyzer := &blockingAnalyzer{started: make(chan struct{}), release: make(chan struct{})}
	pausedService := newTestAIJobService(t, pausedState, pausedMetadata, pausedCatalog, pausedAnalyzer)
	pausedJob, _, err := pausedService.Start(AIJobTypeMetadata, AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-pausedAnalyzer.started:
	case <-time.After(3 * time.Second):
		t.Fatal("paused analyzer did not start")
	}
	if !pausedService.Pause(pausedJob.ID) {
		t.Fatal("Pause() returned false before restart")
	}
	close(pausedAnalyzer.release)
	pausedJob = waitForAIJob(t, pausedService, pausedJob.ID, AIJobStatusPaused)
	shutdownAIJobService(t, pausedService)

	pausedRestart := newTestAIJobService(t, pausedState, pausedMetadata, pausedCatalog, MetadataAnalyzer{})
	if !pausedRestart.Resume(pausedJob.ID) {
		t.Fatal("Resume() failed for a persisted paused job")
	}
	pausedJob = waitForAIJob(t, pausedRestart, pausedJob.ID, AIJobStatusCompleted)
	if pausedJob.Processed != len(pausedFiles) {
		t.Fatalf("restarted paused job = %+v", pausedJob)
	}
	shutdownAIJobService(t, pausedRestart)
}

func TestAIJobServiceCancelsAndRetryCreatesNewHistoryItem(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 2)
	catalog := aiJobCatalog(root, files)
	service := newTestAIJobService(t, filepath.Join(t.TempDir(), "state", "jobs.json"), filepath.Join(t.TempDir(), "derived"), catalog,
		&blockingAnalyzer{started: make(chan struct{}), release: make(chan struct{})})
	job, _, err := service.Start(AIJobTypeMetadata, AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	analyzer := service.analyzers[AIJobTypeMetadata].(*blockingAnalyzer)
	select {
	case <-analyzer.started:
	case <-time.After(3 * time.Second):
		t.Fatal("analyzer did not start")
	}
	if !service.Cancel(job.ID) {
		t.Fatal("Cancel() returned false")
	}
	job = waitForAIJob(t, service, job.ID, AIJobStatusCancelled)
	waitForAIJobIdle(t, service)
	if job.Done != 0 {
		t.Fatalf("cancel committed a partial batch: %+v", job)
	}
	close(analyzer.release)

	retry, err := service.Retry(job.ID)
	if err != nil {
		t.Fatal(err)
	}
	retry = waitForAIJob(t, service, retry.ID, AIJobStatusCompleted)
	if retry.RetryOf != job.ID || retry.Processed != len(files) {
		t.Fatalf("retry after cancel = %+v", retry)
	}
	shutdownAIJobService(t, service)
}

func TestAIJobSchedulerUsesLocalTimeAndRunsMissedDayOnce(t *testing.T) {
	root := t.TempDir()
	catalog := aiJobCatalog(root, nil)
	var now atomic.Value
	current := time.Date(2026, time.November, 11, 2, 59, 0, 0, time.Local)
	now.Store(current)
	service, err := NewAIJobService(AIJobServiceOptions{
		StatePath:    filepath.Join(t.TempDir(), "state", "jobs.json"),
		MetadataDir:  filepath.Join(t.TempDir(), "derived"),
		Catalog:      catalog,
		ValidatePath: aiTestPathValidator(t, root),
		Analyzers:    []AIAnalyzer{MetadataAnalyzer{}},
		Now:          func() time.Time { return now.Load().(time.Time) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ConfigureDaily(true, "03:00"); err != nil {
		t.Fatal(err)
	}
	service.scheduleTick(current)
	if len(service.List().Jobs) != 0 {
		t.Fatal("scheduler ran before the configured local time")
	}

	current = time.Date(2026, time.November, 11, 3, 0, 0, 0, time.Local)
	now.Store(current)
	service.scheduleTick(current)
	waitForAIJobCount(t, service, 1)
	waitForJobHistoryCount(t, service, 1)
	waitForAIJobStatusAtIndex(t, service, 0, AIJobStatusCompleted)
	waitForAIJobIdle(t, service)
	service.scheduleTick(current.Add(time.Minute))
	if len(service.List().Jobs) != 1 {
		t.Fatal("scheduler ran twice on the same local date")
	}

	current = time.Date(2026, time.November, 12, 2, 0, 0, 0, time.Local)
	now.Store(current)
	service.scheduleTick(current)
	if len(service.List().Jobs) != 1 {
		t.Fatal("scheduler ran before the next day's configured time")
	}
	current = time.Date(2026, time.November, 12, 3, 0, 0, 0, time.Local)
	now.Store(current)
	service.scheduleTick(current)
	waitForJobHistoryCount(t, service, 2)
	waitForAIJobStatusAtIndex(t, service, 0, AIJobStatusCompleted)
	waitForAIJobIdle(t, service)

	current = time.Date(2026, time.November, 15, 2, 0, 0, 0, time.Local)
	now.Store(current)
	service.scheduleTick(current)
	waitForJobHistoryCount(t, service, 3)
	waitForAIJobStatusAtIndex(t, service, 0, AIJobStatusCompleted)
	job := service.List().Jobs[0]
	if !job.Scheduled || job.CreatedAt.Local().Format("2006-01-02") != "2026-11-15" {
		t.Fatalf("missed run = %+v", job)
	}
	waitForAIJobIdle(t, service)
	shutdownAIJobService(t, service)
}

func TestAIJobModuleVersionsAreIndependent(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 1)
	catalog := aiJobCatalog(root, files)
	statePath := filepath.Join(t.TempDir(), "state", "jobs.json")
	metadataDir := filepath.Join(t.TempDir(), "derived")
	service := newTestAIJobService(t, statePath, metadataDir, catalog,
		MetadataAnalyzer{}, testJSONAnalyzer{module: AIJobTypeEmbedding, version: "embed-v1"})
	metadataJob, _, err := service.Start(AIJobTypeMetadata, AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	waitForAIJob(t, service, metadataJob.ID, AIJobStatusCompleted)
	waitForAIJobIdle(t, service)
	embeddingJob, _, err := service.Start(AIJobTypeEmbedding, AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	waitForAIJob(t, service, embeddingJob.ID, AIJobStatusCompleted)
	waitForAIJobIdle(t, service)
	shutdownAIJobService(t, service)

	upgraded := newTestAIJobService(t, statePath, metadataDir, catalog,
		MetadataAnalyzer{}, testJSONAnalyzer{module: AIJobTypeEmbedding, version: "embed-v2"})
	job, _, err := upgraded.Start(AIJobTypeEmbedding, AIJobModeIncremental)
	if err != nil {
		t.Fatal(err)
	}
	job = waitForAIJob(t, upgraded, job.ID, AIJobStatusCompleted)
	if job.Processed != 1 || job.Skipped != 0 {
		t.Fatalf("new embedding version did not reprocess its own module: %+v", job)
	}
	if metadataRecords := upgraded.Records(AIJobTypeMetadata); len(metadataRecords) != 1 || metadataRecords[0].ModuleVersion != MetadataParserVersion {
		t.Fatalf("metadata module changed with embedding upgrade: %+v", metadataRecords)
	}
	shutdownAIJobService(t, upgraded)
}

func TestAIJobServiceProcessesAtLeastOneThousandImagesWithinBoundedMemory(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 1001)
	catalog := aiJobCatalog(root, files)
	service := newTestAIJobService(t, filepath.Join(t.TempDir(), "state", "jobs.json"), filepath.Join(t.TempDir(), "derived"), catalog, MetadataAnalyzer{})
	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	job, _, err := service.Start(AIJobTypeMetadata, AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	job = waitForAIJob(t, service, job.ID, AIJobStatusCompleted)
	if job.Processed != 1001 || job.Failed != 0 || len(service.Records(AIJobTypeMetadata)) != 1001 {
		t.Fatalf("1001 image job = %+v", job)
	}
	runtime.GC()
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	if after.Alloc > before.Alloc && after.Alloc-before.Alloc > 64<<20 {
		t.Fatalf("retained heap grew by %d bytes for 1001 images", after.Alloc-before.Alloc)
	}
	shutdownAIJobService(t, service)
}

func newTestAIJobService(t *testing.T, statePath, metadataDir string, catalog *ResourceCatalog, analyzers ...AIAnalyzer) *AIJobService {
	t.Helper()
	root := ""
	if result := catalog.Acquire().Result(); result != nil && len(result.Roots) > 0 {
		root = result.Roots[0]
	}
	service, err := NewAIJobService(AIJobServiceOptions{
		StatePath:    statePath,
		MetadataDir:  metadataDir,
		Catalog:      catalog,
		ValidatePath: aiTestPathValidator(t, root),
		Analyzers:    analyzers,
		WorkerCount:  2,
	})
	if err != nil {
		t.Fatalf("NewAIJobService() error = %v", err)
	}
	t.Cleanup(func() { shutdownAIJobService(t, service) })
	return service
}

func aiJobCatalog(root string, files []string) *ResourceCatalog {
	albumPath := filepath.Join(root, "album")
	_ = os.MkdirAll(albumPath, 0o755)
	result := &models.ScanResult{Roots: []string{root}}
	if len(files) > 0 {
		result.Albums = []models.Album{{
			Type:       "album",
			Name:       "album",
			Path:       albumPath,
			SourceRoot: root,
			ImageFiles: files,
			CoverImage: files[0],
		}}
	}
	catalog := NewResourceCatalog()
	catalog.Publish(result, []string{root})
	return catalog
}

func writeAIJobImages(t *testing.T, root string, count int) []string {
	t.Helper()
	albumPath := filepath.Join(root, "album")
	if err := os.MkdirAll(albumPath, 0o755); err != nil {
		t.Fatal(err)
	}
	files := make([]string, 0, count)
	for index := 0; index < count; index++ {
		path := filepath.Join(albumPath, fmt.Sprintf("%04d.jpg", index))
		if err := os.WriteFile(path, testExifJPEG(), 0o600); err != nil {
			t.Fatal(err)
		}
		files = append(files, path)
	}
	return files
}

func aiTestPathValidator(t *testing.T, root string) func(string) (string, error) {
	t.Helper()
	_, state := middleware.PathSafetyMiddleware([]string{root})
	return state.Validate
}

func waitForAIJob(t *testing.T, service *AIJobService, id, status string) AIJob {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if job, ok := service.Get(id); ok && job.Status == status {
			return job
		}
		time.Sleep(10 * time.Millisecond)
	}
	job, _ := service.Get(id)
	t.Fatalf("job %s did not reach %s; current=%+v", id, status, job)
	return AIJob{}
}

func waitForAIJobIdle(t *testing.T, service *AIJobService) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		service.mu.Lock()
		idle := service.activeID == ""
		service.mu.Unlock()
		if idle {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("analysis service remained active after terminal state")
}

func waitForJobHistoryCount(t *testing.T, service *AIJobService, count int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if len(service.List().Jobs) >= count {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("job history length = %d, want at least %d", len(service.List().Jobs), count)
}

func waitForAIJobCount(t *testing.T, service *AIJobService, count int) {
	t.Helper()
	waitForJobHistoryCount(t, service, count)
}

func waitForAIJobStatusAtIndex(t *testing.T, service *AIJobService, index int, status string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		jobs := service.List().Jobs
		if len(jobs) > index && jobs[index].Status == status {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("job %d did not reach %s: %+v", index, status, service.List().Jobs)
}

func shutdownAIJobService(t *testing.T, service *AIJobService) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := service.Shutdown(ctx); err != nil && !errors.Is(err, context.Canceled) {
		t.Errorf("AIJobService.Shutdown() error = %v", err)
	}
}

type testJSONAnalyzer struct {
	module  string
	version string
}

type versionedMetadataAnalyzer struct {
	version string
}

func (a versionedMetadataAnalyzer) Type() string    { return AIJobTypeMetadata }
func (a versionedMetadataAnalyzer) Version() string { return a.version }
func (a versionedMetadataAnalyzer) Analyze(ctx context.Context, reader io.ReadSeeker) (AIAnalysisOutput, error) {
	return (MetadataAnalyzer{}).Analyze(ctx, reader)
}

func (a testJSONAnalyzer) Type() string    { return a.module }
func (a testJSONAnalyzer) Version() string { return a.version }
func (a testJSONAnalyzer) Analyze(ctx context.Context, _ io.ReadSeeker) (AIAnalysisOutput, error) {
	if err := ctx.Err(); err != nil {
		return AIAnalysisOutput{}, err
	}
	return AIAnalysisOutput{Status: "processed", Data: json.RawMessage(`{"value":1}`)}, nil
}

type failOnceAnalyzer struct {
	started chan struct{}
	release chan struct{}
	failed  atomic.Bool
}

func (a *failOnceAnalyzer) Type() string    { return AIJobTypeMetadata }
func (a *failOnceAnalyzer) Version() string { return MetadataParserVersion }
func (a *failOnceAnalyzer) Analyze(ctx context.Context, _ io.ReadSeeker) (AIAnalysisOutput, error) {
	if a.failed.CompareAndSwap(false, true) {
		close(a.started)
		select {
		case <-ctx.Done():
			return AIAnalysisOutput{}, ctx.Err()
		case <-a.release:
			return AIAnalysisOutput{}, errors.New("synthetic parser failure")
		}
	}
	return AIAnalysisOutput{Status: "parsed", Data: json.RawMessage(`{"ok":true}`)}, nil
}

type blockingAnalyzer struct {
	started chan struct{}
	release chan struct{}
	blocked atomic.Bool
}

func (a *blockingAnalyzer) Type() string    { return AIJobTypeMetadata }
func (a *blockingAnalyzer) Version() string { return MetadataParserVersion }
func (a *blockingAnalyzer) Analyze(ctx context.Context, reader io.ReadSeeker) (AIAnalysisOutput, error) {
	if a.blocked.CompareAndSwap(false, true) {
		close(a.started)
		select {
		case <-ctx.Done():
			return AIAnalysisOutput{}, ctx.Err()
		case <-a.release:
		}
	}
	return (MetadataAnalyzer{}).Analyze(ctx, reader)
}
