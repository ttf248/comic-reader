package handlers

import (
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/services"
)

type AIStorageOptions struct {
	ConfigPath       string
	WorkingDirectory string
	CacheRoot        string
	WorkerDirectory  string
	PythonPath       string
}

type AIStorageFile struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
	Exists    bool   `json:"exists"`
}

type AIStorageUsage struct {
	Path      string `json:"path"`
	Bytes     int64  `json:"bytes"`
	FileCount int    `json:"fileCount"`
	Available bool   `json:"available"`
}

type AIStorageTask struct {
	Type           string          `json:"type"`
	Name           string          `json:"name"`
	ModelDirectory string          `json:"modelDirectory,omitempty"`
	ModelFiles     []AIStorageFile `json:"modelFiles"`
	ModelBytes     int64           `json:"modelBytes"`
	Results        AIStorageUsage  `json:"results"`
}

type AIStoragePaths struct {
	WorkingDirectory  string `json:"workingDirectory"`
	ConfigFile        string `json:"configFile"`
	CacheRoot         string `json:"cacheRoot"`
	StateDirectory    string `json:"stateDirectory"`
	JobsFile          string `json:"jobsFile"`
	MetadataDirectory string `json:"metadataDirectory"`
	ModelDirectory    string `json:"modelDirectory"`
	VectorDirectory   string `json:"vectorDirectory"`
	PythonEnvironment string `json:"pythonEnvironment"`
	PythonExecutable  string `json:"pythonExecutable"`
}

type AIStorageSummary struct {
	ModelBytes        int64 `json:"modelBytes"`
	MetadataBytes     int64 `json:"metadataBytes"`
	MetadataFileCount int   `json:"metadataFileCount"`
	VectorBytes       int64 `json:"vectorBytes"`
	VectorFileCount   int   `json:"vectorFileCount"`
}

type AIStorageSnapshot struct {
	Paths   AIStoragePaths   `json:"paths"`
	Summary AIStorageSummary `json:"summary"`
	Tasks   []AIStorageTask  `json:"tasks"`
	Vectors AIStorageUsage   `json:"vectors"`
}

// AIStorageHandler 返回任务模型与派生数据的位置和占用；完整路径只经回环配置接口提供。
func AIStorageHandler(options AIStorageOptions) fiber.Handler {
	return func(c *fiber.Ctx) error {
		c.Set(fiber.HeaderCacheControl, "no-store")
		workingDirectory := absolutePath(options.WorkingDirectory)
		if workingDirectory == "" {
			workingDirectory, _ = os.Getwd()
		}
		cacheRoot := absolutePath(options.CacheRoot)
		layout := services.ResolveCacheLayout(cacheRoot)
		workerDirectory := absolutePath(options.WorkerDirectory)
		pythonEnvironment := filepath.Join(workerDirectory, ".venv")
		ocrModelDirectory := findRapidOCRModelDirectory(pythonEnvironment)

		tasks := []AIStorageTask{
			{
				Type: services.AIJobTypeMetadata, Name: "照片元数据",
				ModelFiles: []AIStorageFile{},
				Results:    scanAIStorageDirectory(filepath.Join(layout.MetadataDir, services.AIJobTypeMetadata)),
			},
			{
				Type: services.AIJobTypeEmbedding, Name: "向量索引",
				ModelDirectory: layout.AIModelsDir,
				ModelFiles:     []AIStorageFile{modelFile(filepath.Join(layout.AIModelsDir, services.ChineseCLIPModelFile))},
				Results:        scanAIStorageDirectory(filepath.Join(layout.MetadataDir, services.AIJobTypeEmbedding)),
			},
			{
				Type: services.AIJobTypeOCR, Name: "文字识别",
				ModelDirectory: ocrModelDirectory,
				ModelFiles:     scanAIModelFiles(ocrModelDirectory),
				Results:        scanAIStorageDirectory(filepath.Join(layout.MetadataDir, services.AIJobTypeOCR)),
			},
			{
				Type: services.AIJobTypeFace, Name: "人脸识别",
				ModelDirectory: filepath.Join(layout.AIModelsDir, "face"),
				ModelFiles: []AIStorageFile{
					modelFile(filepath.Join(layout.AIModelsDir, "face", "face_detection_yunet_2023mar.onnx")),
					modelFile(filepath.Join(layout.AIModelsDir, "face", "face_recognition_sface_2021dec.onnx")),
				},
				Results: scanAIStorageDirectory(filepath.Join(layout.MetadataDir, services.AIJobTypeFace)),
			},
		}

		modelBytes := int64(0)
		metadataBytes := int64(0)
		metadataFiles := 0
		for index := range tasks {
			for _, model := range tasks[index].ModelFiles {
				tasks[index].ModelBytes += model.SizeBytes
			}
			modelBytes += tasks[index].ModelBytes
			metadataBytes += tasks[index].Results.Bytes
			metadataFiles += tasks[index].Results.FileCount
		}
		vectors := scanAIStorageDirectory(layout.AIVectorsDir)
		return c.JSON(fiber.Map{
			"ok": true,
			"storage": AIStorageSnapshot{
				Paths: AIStoragePaths{
					WorkingDirectory:  workingDirectory,
					ConfigFile:        absolutePath(options.ConfigPath),
					CacheRoot:         cacheRoot,
					StateDirectory:    layout.StateDir,
					JobsFile:          layout.AIJobsPath,
					MetadataDirectory: layout.MetadataDir,
					ModelDirectory:    layout.AIModelsDir,
					VectorDirectory:   layout.AIVectorsDir,
					PythonEnvironment: pythonEnvironment,
					PythonExecutable:  resolveExecutablePath(options.PythonPath),
				},
				Summary: AIStorageSummary{
					ModelBytes: modelBytes, MetadataBytes: metadataBytes,
					MetadataFileCount: metadataFiles,
					VectorBytes:       vectors.Bytes, VectorFileCount: vectors.FileCount,
				},
				Tasks:   tasks,
				Vectors: vectors,
			},
		})
	}
}

func absolutePath(path string) string {
	if path == "" {
		return ""
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	return filepath.Clean(abs)
}

func resolveExecutablePath(path string) string {
	if path == "" {
		return ""
	}
	if resolved, err := exec.LookPath(path); err == nil {
		if !filepath.IsAbs(resolved) {
			return absolutePath(resolved)
		}
		return filepath.Clean(resolved)
	}
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	if strings.ContainsAny(path, `/\\`) {
		return absolutePath(path)
	}
	return path
}

func modelFile(path string) AIStorageFile {
	path = absolutePath(path)
	file := AIStorageFile{Name: filepath.Base(path), Path: path}
	info, err := os.Stat(path)
	if err == nil && info.Mode().IsRegular() {
		file.Exists = true
		file.SizeBytes = info.Size()
	}
	return file
}

func scanAIModelFiles(directory string) []AIStorageFile {
	directory = absolutePath(directory)
	entries, err := os.ReadDir(directory)
	if err != nil {
		return []AIStorageFile{}
	}
	files := make([]AIStorageFile, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || strings.ToLower(filepath.Ext(entry.Name())) != ".onnx" {
			continue
		}
		files = append(files, modelFile(filepath.Join(directory, entry.Name())))
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	return files
}

func findRapidOCRModelDirectory(pythonEnvironment string) string {
	candidates := []string{filepath.Join(pythonEnvironment, "Lib", "site-packages", "rapidocr", "models")}
	if matches, err := filepath.Glob(filepath.Join(pythonEnvironment, "lib", "python*", "site-packages", "rapidocr", "models")); err == nil {
		candidates = append(candidates, matches...)
	}
	if runtime.GOOS != "windows" {
		candidates = append(candidates, filepath.Join(pythonEnvironment, "lib", "python3.11", "site-packages", "rapidocr", "models"))
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return absolutePath(candidate)
		}
	}
	return absolutePath(candidates[0])
}

func scanAIStorageDirectory(path string) AIStorageUsage {
	path = absolutePath(path)
	usage := AIStorageUsage{Path: path}
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return usage
	}
	usage.Available = true
	_ = filepath.WalkDir(path, func(_ string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		fileInfo, err := entry.Info()
		if err != nil || !fileInfo.Mode().IsRegular() {
			return nil
		}
		usage.Bytes += fileInfo.Size()
		usage.FileCount++
		return nil
	})
	return usage
}
