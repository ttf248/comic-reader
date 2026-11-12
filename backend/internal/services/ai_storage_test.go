package services

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeAIStorageFile 造一个带内容的文件，返回内容长度。
func writeAIStorageFile(t *testing.T, path string, content string) int64 {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return int64(len(content))
}

func TestAIStorageUsageReportsRelativePathsAndSizes(t *testing.T) {
	root := t.TempDir()
	cacheRoot := filepath.Join(root, "cache")
	workerDir := filepath.Join(root, "backend", "aiworker")
	ocrModels := filepath.Join(workerDir, ".venv", "Lib", "site-packages", "rapidocr", "models")

	clipBytes := writeAIStorageFile(t, filepath.Join(cacheRoot, "derived", "ai", "models", ChineseCLIPModelFile), "clip-model")
	yunetBytes := writeAIStorageFile(t, filepath.Join(cacheRoot, "derived", "ai", "models", "face", "face_detection_yunet_2023mar.onnx"), "yunet")
	sfaceBytes := writeAIStorageFile(t, filepath.Join(cacheRoot, "derived", "ai", "models", "face", "face_recognition_sface_2021dec.onnx"), "sface-model")
	ocrBytes := writeAIStorageFile(t, filepath.Join(ocrModels, "detector.onnx"), "ocr-detector")
	_ = writeAIStorageFile(t, filepath.Join(ocrModels, "readme.txt"), "ignored")

	metadataBytes := int64(0)
	for _, module := range []string{AIJobTypeMetadata, AIJobTypeEmbedding, AIJobTypeOCR, AIJobTypeFace} {
		metadataBytes += writeAIStorageFile(t, filepath.Join(cacheRoot, "derived", "metadata", module, "batches", "job", "00000001.json"), "batch")
	}
	vectorBytes := writeAIStorageFile(t, filepath.Join(cacheRoot, "derived", "ai", "vectors", "shards", "00000001.bin"), "vector")
	ocrIndexBytes := writeAIStorageFile(t, filepath.Join(cacheRoot, "derived", "ai", "ocr-search-index.json"), "ocr-index")
	peopleIndexBytes := writeAIStorageFile(t, filepath.Join(cacheRoot, "derived", "ai", "people-index.json"), "people-index")

	service := NewAIStorageService(0)
	usage, _, err := service.Usage(cacheRoot, workerDir)
	if err != nil {
		t.Fatal(err)
	}
	if !usage.Available {
		t.Fatal("storage usage should be available")
	}
	if len(usage.Modules) != 4 {
		t.Fatalf("module count = %d, want 4", len(usage.Modules))
	}
	wantTypes := []string{AIJobTypeMetadata, AIJobTypeEmbedding, AIJobTypeOCR, AIJobTypeFace}
	wantNames := []string{"照片元数据", "向量索引", "文字识别", "人脸识别"}
	for index, module := range usage.Modules {
		if module.Type != wantTypes[index] || module.Name != wantNames[index] {
			t.Fatalf("module %d = %s/%s", index, module.Type, module.Name)
		}
	}

	metadataModule := usage.Modules[0]
	if metadataModule.ModelLocation != AIStorageModelNone || len(metadataModule.ModelFiles) != 0 || metadataModule.ModelBytes != 0 {
		t.Fatalf("metadata module = %+v", metadataModule)
	}

	embedding := usage.Modules[1]
	if embedding.ModelLocation != AIStorageModelCache {
		t.Fatalf("embedding model location = %q", embedding.ModelLocation)
	}
	if len(embedding.ModelFiles) != 1 || embedding.ModelFiles[0].Path != "derived/ai/models/"+ChineseCLIPModelFile {
		t.Fatalf("embedding model files = %+v", embedding.ModelFiles)
	}
	if embedding.ModelBytes != clipBytes {
		t.Fatalf("embedding model bytes = %d, want %d", embedding.ModelBytes, clipBytes)
	}

	ocr := usage.Modules[2]
	if ocr.ModelLocation != AIStorageModelPython {
		t.Fatalf("ocr model location = %q", ocr.ModelLocation)
	}
	if len(ocr.ModelFiles) != 1 || ocr.ModelFiles[0].Name != "detector.onnx" {
		t.Fatalf("ocr model files = %+v", ocr.ModelFiles)
	}
	if !strings.Contains(ocr.ModelFiles[0].Path, "rapidocr/models/detector.onnx") {
		t.Fatalf("ocr model path = %q", ocr.ModelFiles[0].Path)
	}
	if ocr.ModelBytes != ocrBytes {
		t.Fatalf("ocr model bytes = %d, want %d", ocr.ModelBytes, ocrBytes)
	}

	face := usage.Modules[3]
	if face.ModelBytes != yunetBytes+sfaceBytes {
		t.Fatalf("face model bytes = %d", face.ModelBytes)
	}

	if usage.Summary.ModelBytes != clipBytes+yunetBytes+sfaceBytes+ocrBytes {
		t.Fatalf("summary model bytes = %d", usage.Summary.ModelBytes)
	}
	if usage.Summary.OutputBytes != metadataBytes+vectorBytes+ocrIndexBytes+peopleIndexBytes {
		t.Fatalf("summary output bytes = %d", usage.Summary.OutputBytes)
	}
	if usage.Summary.OutputFileCount != 7 {
		t.Fatalf("summary output file count = %d, want 7", usage.Summary.OutputFileCount)
	}

	if usage.Paths.JobsFile != "state/ai_jobs.json" {
		t.Fatalf("jobs file = %q", usage.Paths.JobsFile)
	}
	if usage.Paths.MetadataDirectory != "derived/metadata" || usage.Paths.VectorDirectory != "derived/ai/vectors" {
		t.Fatalf("relative paths = %+v", usage.Paths)
	}

	// 绝对路径不能从对外的占用快照里漏出去。
	encoded, err := json.Marshal(usage)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), cacheRoot) || strings.Contains(string(encoded), workerDir) {
		t.Fatalf("usage payload leaked an absolute path: %s", encoded)
	}
}

func TestAIStorageUsageCachesUntilInvalidated(t *testing.T) {
	root := t.TempDir()
	cacheRoot := filepath.Join(root, "cache")
	batch := filepath.Join(cacheRoot, "derived", "metadata", AIJobTypeOCR, "batches", "job", "00000001.json")
	writeAIStorageFile(t, batch, "batch")

	service := NewAIStorageService(0)
	usage, _, err := service.Usage(cacheRoot, filepath.Join(root, "aiworker"))
	if err != nil {
		t.Fatal(err)
	}
	if usage.Summary.OutputBytes != int64(len("batch")) {
		t.Fatalf("output bytes = %d", usage.Summary.OutputBytes)
	}

	// TTL 内的第二次读取走缓存：文件变大也不立刻反映。
	writeAIStorageFile(t, batch, "batch-and-more")
	cached, _, err := service.Usage(cacheRoot, filepath.Join(root, "aiworker"))
	if err != nil {
		t.Fatal(err)
	}
	if cached.Summary.OutputBytes != usage.Summary.OutputBytes {
		t.Fatalf("cached output bytes = %d, want %d", cached.Summary.OutputBytes, usage.Summary.OutputBytes)
	}

	service.Invalidate()
	fresh, _, err := service.Usage(cacheRoot, filepath.Join(root, "aiworker"))
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Summary.OutputBytes != int64(len("batch-and-more")) {
		t.Fatalf("fresh output bytes = %d", fresh.Summary.OutputBytes)
	}
}

func TestAIStorageAbsolutePathsExposeLocalLocations(t *testing.T) {
	root := t.TempDir()
	cacheRoot := filepath.Join(root, "cache")
	workerDir := filepath.Join(root, "backend", "aiworker")
	writeAIStorageFile(t, filepath.Join(cacheRoot, "derived", "ai", "models", ChineseCLIPModelFile), "clip-model")

	service := NewAIStorageService(0)
	paths := service.AbsolutePaths(AIStoragePathOptions{
		ConfigPath:       filepath.Join(root, "backend", "config.yaml"),
		WorkingDirectory: root,
		CacheRoot:        cacheRoot,
		WorkerDirectory:  workerDir,
		PythonPath:       filepath.Join(workerDir, ".venv", "Scripts", "python.exe"),
	})
	if paths.CacheRoot != cacheRoot {
		t.Fatalf("cache root = %q", paths.CacheRoot)
	}
	if paths.ConfigFile != filepath.Join(root, "backend", "config.yaml") {
		t.Fatalf("config file = %q", paths.ConfigFile)
	}
	if paths.JobsFile != filepath.Join(cacheRoot, "state", "ai_jobs.json") {
		t.Fatalf("jobs file = %q", paths.JobsFile)
	}
	if paths.PythonExecutable != filepath.Join(workerDir, ".venv", "Scripts", "python.exe") {
		t.Fatalf("python executable = %q", paths.PythonExecutable)
	}
	if len(paths.Modules) != 4 {
		t.Fatalf("module count = %d", len(paths.Modules))
	}
	var clip *AIStorageAbsoluteFile
	for index := range paths.Modules[1].ModelFiles {
		file := paths.Modules[1].ModelFiles[index]
		if file.Name == ChineseCLIPModelFile {
			clip = &file
		}
	}
	if clip == nil || !clip.Exists || clip.SizeBytes != int64(len("clip-model")) {
		t.Fatalf("clip model file = %+v", clip)
	}
}
