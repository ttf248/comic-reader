package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sync"
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

func TestAIJobServiceStartAllQueuesModulesInOrder(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 1)
	catalog := aiJobCatalog(root, files)
	metadata := &blockingAnalyzer{started: make(chan struct{}), release: make(chan struct{})}
	service := newTestAIJobService(t, filepath.Join(t.TempDir(), "state", "jobs.json"), filepath.Join(t.TempDir(), "derived"), catalog,
		metadata,
		testJSONAnalyzer{module: AIJobTypeEmbedding, version: "embedding-v1"},
		testJSONAnalyzer{module: AIJobTypeOCR, version: "ocr-v1"},
		testJSONAnalyzer{module: AIJobTypeFace, version: "face-v1"},
	)
	if _, err := service.SetPeopleEnabled(true); err != nil {
		t.Fatal(err)
	}

	jobs, skipped, err := service.StartAll(AIJobModeIncremental)
	if err != nil || len(skipped) != 0 {
		t.Fatalf("StartAll() = (%+v, skipped=%+v, err=%v)", jobs, skipped, err)
	}
	wantOrder := []string{AIJobTypeMetadata, AIJobTypeEmbedding, AIJobTypeOCR, AIJobTypeFace}
	if len(jobs) != len(wantOrder) {
		t.Fatalf("queued %d jobs, want %d", len(jobs), len(wantOrder))
	}
	for index, want := range wantOrder {
		if jobs[index].Type != want || jobs[index].Mode != AIJobModeIncremental {
			t.Fatalf("job[%d] = %+v, want type %s in incremental mode", index, jobs[index], want)
		}
	}
	select {
	case <-metadata.started:
	case <-time.After(3 * time.Second):
		t.Fatal("first queued module did not start")
	}
	if _, _, err := service.StartAll(AIJobModeIncremental); !errors.Is(err, ErrAIJobActive) {
		t.Fatalf("StartAll() while queue is active returned %v", err)
	}
	close(metadata.release)
	for _, job := range jobs {
		waitForAIJob(t, service, job.ID, AIJobStatusCompleted)
	}
	waitForAIJobIdle(t, service)
	shutdownAIJobService(t, service)
}

func TestAIJobQueueAndHistoryManagementPreservesAnalysisResults(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 1)
	catalog := aiJobCatalog(root, files)
	statePath := filepath.Join(t.TempDir(), "state", "jobs.json")
	metadata := &blockingAnalyzer{started: make(chan struct{}), release: make(chan struct{})}
	metadataDir := filepath.Join(t.TempDir(), "derived")
	service := newTestAIJobService(t, statePath, metadataDir, catalog,
		metadata,
		testJSONAnalyzer{module: AIJobTypeEmbedding, version: "embedding-v1"},
		testJSONAnalyzer{module: AIJobTypeOCR, version: "ocr-v1"},
		testJSONAnalyzer{module: AIJobTypeFace, version: "face-v1"},
	)
	defer shutdownAIJobService(t, service)
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(metadata.release) })
	if _, err := service.SetPeopleEnabled(true); err != nil {
		t.Fatal(err)
	}

	jobs, _, err := service.StartAll(AIJobModeFull)
	if err != nil {
		t.Fatalf("StartAll() = %v", err)
	}
	select {
	case <-metadata.started:
	case <-time.After(3 * time.Second):
		t.Fatal("first task did not start")
	}
	if got := service.List().Queue; !reflect.DeepEqual(got, []string{jobs[1].ID, jobs[2].ID, jobs[3].ID}) {
		t.Fatalf("initial queue = %v", got)
	}
	if err := service.MovePending(jobs[3].ID, "up"); err != nil {
		t.Fatalf("MovePending(face, up) = %v", err)
	}
	wantQueue := []string{jobs[1].ID, jobs[3].ID, jobs[2].ID}
	if got := service.List().Queue; !reflect.DeepEqual(got, wantQueue) {
		t.Fatalf("reordered queue = %v, want %v", got, wantQueue)
	}
	var persisted aiJobDiskState
	stateBytes, err := os.ReadFile(statePath)
	if err != nil || json.Unmarshal(stateBytes, &persisted) != nil || !reflect.DeepEqual(persisted.Queue, wantQueue) {
		t.Fatalf("persisted queue = %v, read error = %v", persisted.Queue, err)
	}
	recoveredStatePath := filepath.Join(t.TempDir(), "state", "jobs.json")
	if err := os.MkdirAll(filepath.Dir(recoveredStatePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(recoveredStatePath, stateBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	recovered := newTestAIJobService(t, recoveredStatePath, filepath.Join(t.TempDir(), "recovered-derived"), catalog,
		MetadataAnalyzer{},
		testJSONAnalyzer{module: AIJobTypeEmbedding, version: "embedding-v1"},
		testJSONAnalyzer{module: AIJobTypeOCR, version: "ocr-v1"},
		testJSONAnalyzer{module: AIJobTypeFace, version: "face-v1"},
	)
	if got, want := recovered.List().Queue, append([]string{jobs[0].ID}, wantQueue...); !reflect.DeepEqual(got, want) {
		t.Fatalf("queue restored after restart = %v, want %v", got, want)
	}
	shutdownAIJobService(t, recovered)
	if err := service.MovePending(jobs[1].ID, "up"); !errors.Is(err, ErrAIJobNotManageable) {
		t.Fatalf("moving first task up returned %v", err)
	}
	if err := service.DeleteHistory(jobs[2].ID); !errors.Is(err, ErrAIJobNotManageable) {
		t.Fatalf("deleting a pending task returned %v", err)
	}
	if !service.Cancel(jobs[1].ID) {
		t.Fatal("queued task could not be cancelled")
	}
	if got := service.List().Queue; !reflect.DeepEqual(got, []string{jobs[3].ID, jobs[2].ID}) {
		t.Fatalf("queue after cancel = %v", got)
	}
	cancelled, err := service.ClearPending()
	if err != nil || cancelled != 2 {
		t.Fatalf("ClearPending() = (%d, %v), want (2, nil)", cancelled, err)
	}
	if got := service.List().Queue; len(got) != 0 {
		t.Fatalf("queue after clear = %v", got)
	}
	for _, queued := range jobs[1:] {
		if got, ok := service.Get(queued.ID); !ok || got.Status != AIJobStatusCancelled {
			t.Fatalf("queued task %s after clear = %+v, exists=%v", queued.ID, got, ok)
		}
	}
	releaseOnce.Do(func() { close(metadata.release) })
	waitForAIJob(t, service, jobs[0].ID, AIJobStatusCompleted)
	waitForAIJobIdle(t, service)
	if err := service.DeleteHistory(jobs[3].ID); err != nil {
		t.Fatalf("DeleteHistory(cancelled) = %v", err)
	}
	deleted, err := service.ClearHistory()
	if err != nil || deleted != 3 {
		t.Fatalf("ClearHistory() = (%d, %v), want (3, nil)", deleted, err)
	}
	if got := service.List(); len(got.Jobs) != 0 || len(got.Queue) != 0 {
		t.Fatalf("snapshot after history cleanup = %+v", got)
	}
	if records := service.Records(AIJobTypeMetadata); len(records) != 1 {
		t.Fatalf("history cleanup removed analysis results: %d metadata records", len(records))
	}
	restarted := newTestAIJobService(t, statePath, metadataDir, catalog, MetadataAnalyzer{})
	defer shutdownAIJobService(t, restarted)
	if snapshot := restarted.List(); len(snapshot.Jobs) != 0 || len(snapshot.Queue) != 0 {
		t.Fatalf("cleaned history reappeared after restart: %+v", snapshot)
	}
	if records := restarted.Records(AIJobTypeMetadata); len(records) != 1 {
		t.Fatalf("analysis results were not retained after restart: %d metadata records", len(records))
	}
}

func TestFaceAnalysisRequiresExplicitPeopleOptIn(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 1)
	catalog := aiJobCatalog(root, files)
	service := newTestAIJobService(t, filepath.Join(t.TempDir(), "state", "jobs.json"), filepath.Join(t.TempDir(), "derived"), catalog,
		MetadataAnalyzer{},
		testJSONAnalyzer{module: AIJobTypeFace, version: "face-v1"},
	)
	defer shutdownAIJobService(t, service)

	if service.List().Settings.PeopleEnabled {
		t.Fatal("people analysis must be disabled by default")
	}
	if _, _, err := service.Start(AIJobTypeFace, AIJobModeFull); !errors.Is(err, ErrPeopleAnalysisDisabled) {
		t.Fatalf("face task started without opt-in: %v", err)
	}
	queued, skipped, err := service.StartAll(AIJobModeIncremental)
	faceSkipped := false
	for _, module := range skipped {
		if module.Type == AIJobTypeFace && module.Reason == "people_analysis_disabled" {
			faceSkipped = true
		}
	}
	if err != nil || len(queued) != 1 || !faceSkipped {
		t.Fatalf("StartAll without opt-in = jobs %v, skipped %v, error %v", queued, skipped, err)
	}
	waitForAIJob(t, service, queued[0].ID, AIJobStatusCompleted)
	waitForAIJobIdle(t, service)
	if _, err := service.SetPeopleEnabled(true); err != nil {
		t.Fatal(err)
	}
	faceJob, _, err := service.Start(AIJobTypeFace, AIJobModeFull)
	if err != nil {
		t.Fatalf("face task did not start after opt-in: %v", err)
	}
	waitForAIJob(t, service, faceJob.ID, AIJobStatusCompleted)
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
	failedName := ""
	for _, path := range files {
		if catalog.ExternalID(path, ResourceFile) == job.Errors[0].ResourceID {
			failedName = filepath.Base(path)
			break
		}
	}
	if job.Errors[0].Path == "" || filepath.IsAbs(job.Errors[0].Path) || filepath.Base(job.Errors[0].Path) != failedName {
		t.Fatalf("failed image path = %q, want relative path ending in %q", job.Errors[0].Path, failedName)
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

func TestAIJobServiceCanCancelPausedJobAfterRestart(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, aiBatchSize+1)
	catalog := aiJobCatalog(root, files)
	statePath := filepath.Join(t.TempDir(), "state", "jobs.json")
	metadataDir := filepath.Join(t.TempDir(), "derived")
	analyzer := &blockingAnalyzer{started: make(chan struct{}), release: make(chan struct{})}
	service := newTestAIJobService(t, statePath, metadataDir, catalog, analyzer)
	job, _, err := service.Start(AIJobTypeMetadata, AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-analyzer.started:
	case <-time.After(3 * time.Second):
		t.Fatal("analyzer did not start")
	}
	if !service.Pause(job.ID) {
		t.Fatal("Pause() returned false")
	}
	close(analyzer.release)
	waitForAIJob(t, service, job.ID, AIJobStatusPaused)
	shutdownAIJobService(t, service)

	restarted := newTestAIJobService(t, statePath, metadataDir, catalog, MetadataAnalyzer{})
	defer shutdownAIJobService(t, restarted)
	if active := restarted.List().Active; active == nil || active.Status != AIJobStatusPaused {
		t.Fatalf("restored active job = %+v", active)
	}
	if !restarted.Cancel(job.ID) {
		t.Fatal("paused job could not be cancelled after restart")
	}
	if got, ok := restarted.Get(job.ID); !ok || got.Status != AIJobStatusCancelled {
		t.Fatalf("cancelled paused job = %+v, exists=%v", got, ok)
	}
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
	if _, err := service.ConfigureDaily(true, "03:00", []string{AIJobTypeMetadata}, false); err != nil {
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

func TestAIJobSchedulerQueuesConfiguredModules(t *testing.T) {
	root := t.TempDir()
	catalog := aiJobCatalog(root, nil)
	var now atomic.Value
	current := time.Date(2026, time.November, 11, 3, 0, 0, 0, time.Local)
	now.Store(current)
	service, err := NewAIJobService(AIJobServiceOptions{
		StatePath:    filepath.Join(t.TempDir(), "state", "jobs.json"),
		MetadataDir:  filepath.Join(t.TempDir(), "derived"),
		Catalog:      catalog,
		ValidatePath: aiTestPathValidator(t, root),
		Analyzers: []AIAnalyzer{
			MetadataAnalyzer{},
			testJSONAnalyzer{module: AIJobTypeEmbedding, version: "embed-v1"},
		},
		Now: func() time.Time { return now.Load().(time.Time) },
	})
	if err != nil {
		t.Fatal(err)
	}
	settings, err := service.ConfigureDaily(true, "03:00", []string{AIJobTypeEmbedding, AIJobTypeMetadata, AIJobTypeEmbedding}, false)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(settings.DailyModules, []string{AIJobTypeMetadata, AIJobTypeEmbedding}) {
		t.Fatalf("daily modules = %v", settings.DailyModules)
	}

	service.scheduleTick(current)
	waitForJobHistoryCount(t, service, 2)
	for _, job := range service.List().Jobs {
		waitForAIJob(t, service, job.ID, AIJobStatusCompleted)
	}
	waitForAIJobIdle(t, service)
	jobs := service.List().Jobs
	if len(jobs) != 2 {
		t.Fatalf("scheduled jobs = %+v", jobs)
	}
	seen := make(map[string]bool, len(jobs))
	for _, job := range jobs {
		if !job.Scheduled || job.Mode != AIJobModeIncremental || job.Status != AIJobStatusCompleted {
			t.Fatalf("scheduled job = %+v", job)
		}
		seen[job.Type] = true
	}
	if !seen[AIJobTypeMetadata] || !seen[AIJobTypeEmbedding] {
		t.Fatalf("scheduled modules = %v", seen)
	}
	if service.List().Settings.LastScheduledDate != "2026-11-11" {
		t.Fatalf("scheduled date = %q", service.List().Settings.LastScheduledDate)
	}
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

func TestAIJobServiceReportsPlannedProgressAndOutputBreakdown(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 3)
	catalog := aiJobCatalog(root, files)
	statePath := filepath.Join(t.TempDir(), "state", "ai_jobs.json")
	metadataDir := filepath.Join(t.TempDir(), "derived", "metadata")
	service := newTestAIJobService(t, statePath, metadataDir, catalog, MetadataAnalyzer{})

	full, _, err := service.Start(AIJobTypeMetadata, AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	full = waitForAIJob(t, service, full.ID, AIJobStatusCompleted)
	if full.Planned != 3 || full.Completed != 3 {
		t.Fatalf("full job progress = planned %d, completed %d", full.Planned, full.Completed)
	}
	if full.Results[MetadataParseParsed] != 3 {
		t.Fatalf("full job results = %+v", full.Results)
	}
	if full.Fields[AIFieldExifTime] != 3 || full.Fields[AIFieldCamera] != 3 || full.Fields[AIFieldGPS] != 3 {
		t.Fatalf("full job fields = %+v", full.Fields)
	}
	if full.EstimatedRemainingMs != 0 {
		t.Fatalf("finished job still reports remaining time: %d", full.EstimatedRemainingMs)
	}
	waitForAIJobIdle(t, service)

	incremental, _, err := service.Start(AIJobTypeMetadata, AIJobModeIncremental)
	if err != nil {
		t.Fatal(err)
	}
	incremental = waitForAIJob(t, service, incremental.ID, AIJobStatusCompleted)
	if incremental.Planned != 0 || incremental.Completed != 0 {
		t.Fatalf("incremental job progress = planned %d, completed %d", incremental.Planned, incremental.Completed)
	}
	waitForAIJobIdle(t, service)
	shutdownAIJobService(t, service)

	modules := service.List().Modules
	if len(modules) != 4 {
		t.Fatalf("modules = %+v, want 4 entries", modules)
	}
	installed := map[string]AIJobModule{}
	for _, module := range modules {
		installed[module.Type] = module
	}
	if !installed[AIJobTypeMetadata].Installed || installed[AIJobTypeMetadata].Version != MetadataParserVersion {
		t.Fatalf("metadata module = %+v", installed[AIJobTypeMetadata])
	}
	if installed[AIJobTypeEmbedding].Installed || installed[AIJobTypeOCR].Installed || installed[AIJobTypeFace].Installed {
		t.Fatalf("uninstalled modules reported as installed: %+v", modules)
	}
	if installed[AIJobTypeEmbedding].Name != "向量索引" {
		t.Fatalf("module display name = %+v", installed[AIJobTypeEmbedding])
	}
}

func TestAIJobServiceEstimatesRemainingTimeWhileRunning(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, aiBatchSize+8)
	catalog := aiJobCatalog(root, files)
	gate := &gateAnalyzer{gate: int32(aiBatchSize + 1), blocked: make(chan struct{}), release: make(chan struct{})}
	var clock atomic.Int64
	clock.Store(time.Now().UnixMilli())
	service, err := NewAIJobService(AIJobServiceOptions{
		StatePath:    filepath.Join(t.TempDir(), "state", "ai_jobs.json"),
		MetadataDir:  filepath.Join(t.TempDir(), "derived", "metadata"),
		Catalog:      catalog,
		ValidatePath: aiTestPathValidator(t, root),
		Analyzers:    []AIAnalyzer{gate},
		WorkerCount:  2,
		Now:          func() time.Time { return time.UnixMilli(clock.Load()) },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { shutdownAIJobService(t, service) })

	job, _, err := service.Start(AIJobTypeMetadata, AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-gate.blocked:
	case <-time.After(10 * time.Second):
		t.Fatal("analyzer did not reach the gate")
	}
	clock.Store(clock.Load() + 5000)

	running, ok := service.Get(job.ID)
	if !ok {
		t.Fatal("running job not found")
	}
	if running.Status != AIJobStatusRunning {
		t.Fatalf("job status = %s", running.Status)
	}
	if running.Completed != aiBatchSize || running.Planned != aiBatchSize+8 {
		t.Fatalf("running job progress = planned %d, completed %d", running.Planned, running.Completed)
	}
	wantRemaining := int64(8) * 5000 / int64(aiBatchSize)
	if running.EstimatedRemainingMs != wantRemaining {
		t.Fatalf("estimated remaining = %d, want %d", running.EstimatedRemainingMs, wantRemaining)
	}
	if running.SpeedPerSecond != float64(aiBatchSize)*1000/5000 {
		t.Fatalf("speed per second = %v", running.SpeedPerSecond)
	}

	close(gate.release)
	finished := waitForAIJob(t, service, job.ID, AIJobStatusCompleted)
	if finished.EstimatedRemainingMs != 0 {
		t.Fatalf("finished job still reports remaining time: %d", finished.EstimatedRemainingMs)
	}
	if finished.Completed != aiBatchSize+8 {
		t.Fatalf("finished job completed = %d", finished.Completed)
	}
}

func TestAIJobServiceReplaysOutputBreakdownAfterRestart(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 3)
	catalog := aiJobCatalog(root, files)
	statePath := filepath.Join(t.TempDir(), "state", "ai_jobs.json")
	metadataDir := filepath.Join(t.TempDir(), "derived", "metadata")
	service := newTestAIJobService(t, statePath, metadataDir, catalog, MetadataAnalyzer{})

	job, _, err := service.Start(AIJobTypeMetadata, AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	waitForAIJob(t, service, job.ID, AIJobStatusCompleted)
	waitForAIJobIdle(t, service)
	shutdownAIJobService(t, service)

	// 模拟崩溃窗口：批次结果已落盘，检查点与计数还没写进状态文件。
	data, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	var state aiJobDiskState
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	for index := range state.Jobs {
		state.Jobs[index].Processed = 0
		state.Jobs[index].Failed = 0
		state.Jobs[index].Done = 0
		state.Jobs[index].Errors = nil
		state.Jobs[index].Results = nil
		state.Jobs[index].Fields = nil
		state.Jobs[index].Checkpoint.Batch = 0
	}
	rewritten, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, rewritten, 0o600); err != nil {
		t.Fatal(err)
	}

	restarted := newTestAIJobService(t, statePath, metadataDir, catalog, MetadataAnalyzer{})
	jobs := restarted.List().Jobs
	if len(jobs) != 1 {
		t.Fatalf("restarted jobs = %d, want 1", len(jobs))
	}
	replayed := jobs[0]
	if replayed.Processed != 3 || replayed.Done != 3 {
		t.Fatalf("replayed counters = %+v", replayed)
	}
	if replayed.Results[MetadataParseParsed] != 3 {
		t.Fatalf("replayed results = %+v", replayed.Results)
	}
	if replayed.Fields[AIFieldCamera] != 3 || replayed.Fields[AIFieldGPS] != 3 {
		t.Fatalf("replayed fields = %+v", replayed.Fields)
	}
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

// gateAnalyzer 从第 gate 次调用开始挂起，用来观察运行中任务的进度与预计剩余。
type gateAnalyzer struct {
	gate    int32
	calls   atomic.Int32
	blocked chan struct{}
	release chan struct{}
	once    sync.Once
}

func (a *gateAnalyzer) Type() string    { return AIJobTypeMetadata }
func (a *gateAnalyzer) Version() string { return MetadataParserVersion }
func (a *gateAnalyzer) Analyze(ctx context.Context, reader io.ReadSeeker) (AIAnalysisOutput, error) {
	if a.calls.Add(1) >= a.gate {
		a.once.Do(func() { close(a.blocked) })
		select {
		case <-ctx.Done():
			return AIAnalysisOutput{}, ctx.Err()
		case <-a.release:
		}
	}
	return (MetadataAnalyzer{}).Analyze(ctx, reader)
}
