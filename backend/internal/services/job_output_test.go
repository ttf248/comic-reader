package services

import (
	"os"
	"path/filepath"
	"testing"
)

func TestJobOutputUsageCountsBatchFiles(t *testing.T) {
	root := t.TempDir()
	cacheRoot := filepath.Join(root, "cache")
	directory := filepath.Join(cacheRoot, "derived", "metadata", AIJobTypeOCR, "batches", "job-1")
	writeAIStorageFile(t, filepath.Join(directory, "00000001.json"), "batch-one")
	writeAIStorageFile(t, filepath.Join(directory, "00000002.json"), "batch-two")

	service := NewJobOutputService(cacheRoot, 0)
	usage := service.Usage("job-1", AIJobTypeOCR, directory)
	if !usage.Available {
		t.Fatal("job output should be available")
	}
	if usage.FileCount != 2 {
		t.Fatalf("file count = %d, want 2", usage.FileCount)
	}
	if usage.Bytes != int64(len("batch-one")+len("batch-two")) {
		t.Fatalf("bytes = %d", usage.Bytes)
	}
	if usage.Path != "derived/metadata/ocr/batches/job-1" {
		t.Fatalf("path = %q", usage.Path)
	}
	if usage.BatchSize != AIBatchSize {
		t.Fatalf("batch size = %d", usage.BatchSize)
	}
}

func TestJobOutputUsageReportsMissingDirectory(t *testing.T) {
	root := t.TempDir()
	cacheRoot := filepath.Join(root, "cache")
	directory := filepath.Join(cacheRoot, "derived", "metadata", AIJobTypeFace, "batches", "job-2")

	service := NewJobOutputService(cacheRoot, 0)
	usage := service.Usage("job-2", AIJobTypeFace, directory)
	if usage.Available {
		t.Fatal("missing batch directory should not be available")
	}
	if usage.Bytes != 0 || usage.FileCount != 0 {
		t.Fatalf("usage = %+v", usage)
	}
	// 目录没了，但它本该在哪还是要说出来。
	if usage.Path != "derived/metadata/face/batches/job-2" {
		t.Fatalf("path = %q", usage.Path)
	}
}

func TestJobOutputServiceCachesUntilInvalidated(t *testing.T) {
	root := t.TempDir()
	cacheRoot := filepath.Join(root, "cache")
	directory := filepath.Join(cacheRoot, "derived", "metadata", AIJobTypeMetadata, "batches", "job-3")
	writeAIStorageFile(t, filepath.Join(directory, "00000001.json"), "one")

	service := NewJobOutputService(cacheRoot, 0)
	first := service.Usage("job-3", AIJobTypeMetadata, directory)
	if first.FileCount != 1 {
		t.Fatalf("file count = %d", first.FileCount)
	}

	writeAIStorageFile(t, filepath.Join(directory, "00000002.json"), "two")
	cached := service.Usage("job-3", AIJobTypeMetadata, directory)
	if cached.FileCount != 1 {
		t.Fatalf("cached file count = %d, want 1", cached.FileCount)
	}

	service.Invalidate()
	fresh := service.Usage("job-3", AIJobTypeMetadata, directory)
	if fresh.FileCount != 2 {
		t.Fatalf("fresh file count = %d, want 2", fresh.FileCount)
	}
}

func TestJobOutputDirUsesJobRecord(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 2)
	catalog := aiJobCatalog(root, files)
	cacheRoot := filepath.Join(root, "cache")
	metadataDir := filepath.Join(cacheRoot, "derived", "metadata")
	service := newTestAIJobService(t, filepath.Join(t.TempDir(), "state", "ai_jobs.json"), metadataDir, catalog,
		versionedMetadataAnalyzer{version: "metadata-test"},
		testJSONAnalyzer{module: AIJobTypeOCR, version: "ocr-test"})

	job, _, err := service.Start(AIJobTypeOCR, AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	waitForAIJob(t, service, job.ID, AIJobStatusCompleted)

	directory, moduleType, ok := service.JobOutputDir(job.ID)
	if !ok {
		t.Fatal("job output directory should resolve")
	}
	if moduleType != AIJobTypeOCR {
		t.Fatalf("module type = %q", moduleType)
	}
	if directory != filepath.Join(metadataDir, AIJobTypeOCR, "batches", job.ID) {
		t.Fatalf("directory = %q", directory)
	}

	if _, _, ok := service.JobOutputDir("missing-job"); ok {
		t.Fatal("unknown job should not resolve an output directory")
	}
}

func TestJobOutputUsageIgnoresNonRegularFiles(t *testing.T) {
	root := t.TempDir()
	cacheRoot := filepath.Join(root, "cache")
	directory := filepath.Join(cacheRoot, "derived", "metadata", AIJobTypeMetadata, "batches", "job-4")
	writeAIStorageFile(t, filepath.Join(directory, "00000001.json"), "one")
	if err := os.MkdirAll(filepath.Join(directory, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}

	service := NewJobOutputService(cacheRoot, 0)
	usage := service.Usage("job-4", AIJobTypeMetadata, directory)
	if usage.FileCount != 1 {
		t.Fatalf("file count = %d, want 1", usage.FileCount)
	}
}
