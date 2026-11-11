package handlers

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func TestAIStorageHandlerListsLocalModelAndResultSizes(t *testing.T) {
	root := t.TempDir()
	cacheRoot := filepath.Join(root, "cache")
	workerDir := filepath.Join(root, "backend", "aiworker")
	ocrModels := filepath.Join(workerDir, ".venv", "Lib", "site-packages", "rapidocr", "models")
	modelPaths := map[string]string{
		filepath.Join(cacheRoot, "derived", "ai", "models", services.ChineseCLIPModelFile):                              "clip-model",
		filepath.Join(cacheRoot, "derived", "ai", "models", "face", "face_detection_yunet_2023mar.onnx"):                "yunet",
		filepath.Join(cacheRoot, "derived", "ai", "models", "face", "face_recognition_sface_2021dec.onnx"):              "sface-model",
		filepath.Join(ocrModels, "detector.onnx"):                                                                       "ocr-detector",
		filepath.Join(ocrModels, "recognizer.onnx"):                                                                     "ocr-recognizer",
		filepath.Join(ocrModels, "readme.txt"):                                                                          "ignored",
		filepath.Join(cacheRoot, "derived", "metadata", services.AIJobTypeMetadata, "batches", "job", "00000001.json"):  "met",
		filepath.Join(cacheRoot, "derived", "metadata", services.AIJobTypeEmbedding, "batches", "job", "00000001.json"): "embed",
		filepath.Join(cacheRoot, "derived", "metadata", services.AIJobTypeOCR, "batches", "job", "00000001.json"):       "ocr",
		filepath.Join(cacheRoot, "derived", "metadata", services.AIJobTypeFace, "batches", "job", "00000001.json"):      "face",
		filepath.Join(cacheRoot, "derived", "ai", "vectors", "shards", "00000001.bin"):                                  "vector",
	}
	for path, content := range modelPaths {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	app := fiber.New()
	app.Get("/api/config/storage", AIStorageHandler(AIStorageOptions{
		ConfigPath: filepath.Join(root, "backend", "config.yaml"), WorkingDirectory: root,
		CacheRoot: cacheRoot, WorkerDirectory: workerDir, PythonPath: filepath.Join(workerDir, ".venv", "Scripts", "python.exe"),
	}))
	response, err := app.Test(httptest.NewRequest("GET", "/api/config/storage", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("storage status = %d", response.StatusCode)
	}
	var body struct {
		Storage AIStorageSnapshot `json:"storage"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	storage := body.Storage
	if storage.Paths.CacheRoot != cacheRoot || storage.Paths.ConfigFile != filepath.Join(root, "backend", "config.yaml") || storage.Paths.JobsFile != filepath.Join(cacheRoot, "state", "ai_jobs.json") || storage.Paths.PythonExecutable != filepath.Join(workerDir, ".venv", "Scripts", "python.exe") {
		t.Fatalf("storage paths = %+v", storage.Paths)
	}
	if response.Header.Get(fiber.HeaderCacheControl) != "no-store" {
		t.Fatalf("cache control = %q, want no-store", response.Header.Get(fiber.HeaderCacheControl))
	}
	if storage.Summary.ModelBytes != int64(len("clip-model")+len("yunet")+len("sface-model")+len("ocr-detector")+len("ocr-recognizer")) {
		t.Fatalf("model size = %d", storage.Summary.ModelBytes)
	}
	if storage.Summary.MetadataBytes != int64(len("met")+len("embed")+len("ocr")+len("face")) || storage.Summary.MetadataFileCount != 4 {
		t.Fatalf("metadata usage = %+v", storage.Summary)
	}
	if storage.Summary.VectorBytes != int64(len("vector")) || storage.Summary.VectorFileCount != 1 {
		t.Fatalf("vector usage = %+v", storage.Summary)
	}
	if len(storage.Tasks) != 4 || storage.Tasks[2].Type != services.AIJobTypeOCR || len(storage.Tasks[2].ModelFiles) != 2 {
		t.Fatalf("task model list = %+v", storage.Tasks)
	}
	if storage.Tasks[0].ModelBytes != 0 || storage.Tasks[0].Results.Bytes != int64(len("met")) {
		t.Fatalf("metadata task storage = %+v", storage.Tasks[0])
	}
}
