package services

import (
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// 模型权重的位置类别。
//
// 缓存根目录内的权重用相对缓存根的路径表示；Python 环境内的权重不在
// 缓存根目录里，只能用相对 Python 环境的路径表示。绝对路径只由回环
// 保护的本机接口给出。
const (
	AIStorageModelNone   = "none"
	AIStorageModelCache  = "cache"
	AIStorageModelPython = "python"
)

// 产物目录的种类：批次结果随每次任务新增，索引是所有任务共享的。
const (
	AIStorageOutputBatches = "batches"
	AIStorageOutputVectors = "vectors"
	AIStorageOutputIndex   = "index"
)

// AIStorageFile 一个模型权重文件。
//
// Path 是相对路径：location 为 cache 时相对缓存根目录，为 python 时相对
// Python 环境目录。相对基准写在 location 里，不另设字段。
type AIStorageFile struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Location  string `json:"location"`
	SizeBytes int64  `json:"sizeBytes"`
	Exists    bool   `json:"exists"`
}

// AIStorageOutput 一个产物目录（或单个索引文件）的占用。
type AIStorageOutput struct {
	Kind      string `json:"kind"`
	Label     string `json:"label"`
	Path      string `json:"path"`
	Bytes     int64  `json:"bytes"`
	FileCount int    `json:"fileCount"`
	Available bool   `json:"available"`
}

// AIStorageModule 一个分析模块的模型与产物。
type AIStorageModule struct {
	Type            string            `json:"type"`
	Name            string            `json:"name"`
	ModelDirectory  string            `json:"modelDirectory"`
	ModelLocation   string            `json:"modelLocation"`
	ModelFiles      []AIStorageFile   `json:"modelFiles"`
	ModelBytes      int64             `json:"modelBytes"`
	OutputBytes     int64             `json:"outputBytes"`
	OutputFileCount int               `json:"outputFileCount"`
	Outputs         []AIStorageOutput `json:"outputs"`
}

// AIStorageSummary 模型与产物的总量。
type AIStorageSummary struct {
	ModelBytes      int64 `json:"modelBytes"`
	ModelFileCount  int   `json:"modelFileCount"`
	OutputBytes     int64 `json:"outputBytes"`
	OutputFileCount int   `json:"outputFileCount"`
}

// AIStorageRelativePaths 相对缓存根目录的关键路径，各设备都可见。
type AIStorageRelativePaths struct {
	RelativeTo         string `json:"relativeTo"`
	StateDirectory     string `json:"stateDirectory"`
	JobsFile           string `json:"jobsFile"`
	MetadataDirectory  string `json:"metadataDirectory"`
	AIDerivedDirectory string `json:"aiDerivedDirectory"`
	VectorDirectory    string `json:"vectorDirectory"`
	ModelDirectory     string `json:"modelDirectory"`
}

// AIStorageUsage 本机分析存储的占用快照。
type AIStorageUsage struct {
	ScannedAt       time.Time              `json:"scannedAt"`
	DurationMs      int64                  `json:"durationMs"`
	Available       bool                   `json:"available"`
	CacheTTLSeconds int                    `json:"cacheTtlSeconds"`
	Summary         AIStorageSummary       `json:"summary"`
	Modules         []AIStorageModule      `json:"modules"`
	Paths           AIStorageRelativePaths `json:"paths"`
}

// AIStorageAbsoluteFile 一个模型权重文件的本机绝对位置。
type AIStorageAbsoluteFile struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
	Exists    bool   `json:"exists"`
}

// AIStorageAbsoluteModule 一个分析模块的本机绝对位置。
type AIStorageAbsoluteModule struct {
	Type           string                 `json:"type"`
	Name           string                 `json:"name"`
	ModelDirectory string                 `json:"modelDirectory"`
	ModelFiles     []AIStorageAbsoluteFile `json:"modelFiles"`
}

// AIStorageAbsolutePaths 本机绝对路径。只由回环保护的本机接口给出。
type AIStorageAbsolutePaths struct {
	WorkingDirectory  string                   `json:"workingDirectory"`
	ConfigFile        string                   `json:"configFile"`
	CacheRoot         string                   `json:"cacheRoot"`
	StateDirectory    string                   `json:"stateDirectory"`
	JobsFile          string                   `json:"jobsFile"`
	PythonEnvironment string                   `json:"pythonEnvironment"`
	PythonExecutable  string                   `json:"pythonExecutable"`
	Modules           []AIStorageAbsoluteModule `json:"modules"`
}

// AIStoragePathOptions 本机路径接口需要的外部位置。
type AIStoragePathOptions struct {
	ConfigPath       string
	WorkingDirectory string
	CacheRoot        string
	WorkerDirectory  string
	PythonPath       string
}

// AIStorageService 汇总本机分析任务的模型权重与产物占用。
//
// 产物目录按批次分文件，大库下每次都走一遍磁盘代价很高，因此带 30 秒
// TTL 内存缓存。批次提交与人物清理后调用 Invalidate 让数字尽快跟上。
type AIStorageService struct {
	mu     sync.Mutex
	cache  *AIStorageUsage
	expiry time.Time
	ttl    time.Duration
}

// NewAIStorageService 构造；ttl 通常 30s。
func NewAIStorageService(ttl time.Duration) *AIStorageService {
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	return &AIStorageService{ttl: ttl}
}

// Invalidate 让下一次读取重新扫描磁盘。
func (s *AIStorageService) Invalidate() {
	s.mu.Lock()
	s.cache = nil
	s.expiry = time.Time{}
	s.mu.Unlock()
}

// Usage 返回本机分析存储的占用快照。路径一律相对缓存根目录。
func (s *AIStorageService) Usage(cacheRoot string, workerDirectory string) (*AIStorageUsage, *time.Time, error) {
	s.mu.Lock()
	if s.cache != nil && time.Now().Before(s.expiry) {
		cached := *s.cache
		expiry := s.expiry
		s.mu.Unlock()
		return &cached, &expiry, nil
	}
	s.mu.Unlock()

	start := time.Now()
	usage := scanAIStorage(cacheRoot, workerDirectory)
	usage.DurationMs = time.Since(start).Milliseconds()
	s.mu.Lock()
	s.cache = &usage
	s.expiry = time.Now().Add(s.ttl)
	expiry := s.expiry
	s.mu.Unlock()
	return &usage, &expiry, nil
}

// AbsolutePaths 返回本机绝对路径。只给回环请求。
func (s *AIStorageService) AbsolutePaths(options AIStoragePathOptions) AIStorageAbsolutePaths {
	workingDirectory := absolutePath(options.WorkingDirectory)
	if workingDirectory == "" {
		workingDirectory, _ = os.Getwd()
	}
	cacheRoot := absolutePath(options.CacheRoot)
	layout := ResolveCacheLayout(cacheRoot)
	workerDirectory := absolutePath(options.WorkerDirectory)
	pythonEnvironment := filepath.Join(workerDirectory, ".venv")

	paths := AIStorageAbsolutePaths{
		WorkingDirectory:  workingDirectory,
		ConfigFile:        absolutePath(options.ConfigPath),
		CacheRoot:         cacheRoot,
		StateDirectory:    layout.StateDir,
		JobsFile:          layout.AIJobsPath,
		PythonEnvironment: pythonEnvironment,
		PythonExecutable:  resolveExecutablePath(options.PythonPath),
	}
	for _, module := range aiStorageModules(layout, pythonEnvironment) {
		statModelFiles(&module)
		absolute := AIStorageAbsoluteModule{
			Type:           module.Type,
			Name:           module.Name,
			ModelDirectory: absolutePath(module.ModelDirectory),
			ModelFiles:     []AIStorageAbsoluteFile{},
		}
		for _, file := range module.ModelFiles {
			absolute.ModelFiles = append(absolute.ModelFiles, AIStorageAbsoluteFile{
				Name:      file.Name,
				Path:      absolutePath(file.Path),
				SizeBytes: file.SizeBytes,
				Exists:    file.Exists,
			})
		}
		paths.Modules = append(paths.Modules, absolute)
	}
	return paths
}

// statModelFiles 补齐模型权重文件的大小与存在状态。
func statModelFiles(module *AIStorageModule) {
	for index := range module.ModelFiles {
		file := &module.ModelFiles[index]
		info, err := os.Stat(file.Path)
		if err != nil || !info.Mode().IsRegular() {
			file.Exists = false
			file.SizeBytes = 0
			continue
		}
		file.Exists = true
		file.SizeBytes = info.Size()
	}
}

// aiStorageModules 给出四个分析模块的模型与产物清单。
//
// 模型文件与产物目录都用绝对路径先落地，扫描完再统一相对化，这样相对
// 基准只有一个（缓存根目录），不会出现一半相对一半绝对。
func aiStorageModules(layout CacheLayout, pythonEnvironment string) []AIStorageModule {
	ocrModelDirectory := findRapidOCRModelDirectory(pythonEnvironment)
	return []AIStorageModule{
		{
			Type:           AIJobTypeMetadata,
			Name:           aiJobModuleName(AIJobTypeMetadata),
			ModelLocation:  AIStorageModelNone,
			ModelDirectory: "",
			ModelFiles:     []AIStorageFile{},
			Outputs: []AIStorageOutput{
				{
					Kind:  AIStorageOutputBatches,
					Label: "批次结果",
					Path:  filepath.Join(layout.MetadataDir, AIJobTypeMetadata),
				},
			},
		},
		{
			Type:           AIJobTypeEmbedding,
			Name:           aiJobModuleName(AIJobTypeEmbedding),
			ModelLocation:  AIStorageModelCache,
			ModelDirectory: layout.AIModelsDir,
			ModelFiles: []AIStorageFile{
				modelFile(filepath.Join(layout.AIModelsDir, ChineseCLIPModelFile), AIStorageModelCache),
			},
			Outputs: []AIStorageOutput{
				{
					Kind:  AIStorageOutputBatches,
					Label: "批次结果",
					Path:  filepath.Join(layout.MetadataDir, AIJobTypeEmbedding),
				},
				{
					Kind:  AIStorageOutputVectors,
					Label: "向量索引",
					Path:  layout.AIVectorsDir,
				},
			},
		},
		{
			Type:           AIJobTypeOCR,
			Name:           aiJobModuleName(AIJobTypeOCR),
			ModelLocation:  AIStorageModelPython,
			ModelDirectory: ocrModelDirectory,
			ModelFiles:     scanAIModelFiles(ocrModelDirectory),
			Outputs: []AIStorageOutput{
				{
					Kind:  AIStorageOutputBatches,
					Label: "批次结果",
					Path:  filepath.Join(layout.MetadataDir, AIJobTypeOCR),
				},
				{
					Kind:  AIStorageOutputIndex,
					Label: "搜索索引",
					Path:  filepath.Join(layout.AIDerivedDir, "ocr-search-index.json"),
				},
			},
		},
		{
			Type:           AIJobTypeFace,
			Name:           aiJobModuleName(AIJobTypeFace),
			ModelLocation:  AIStorageModelCache,
			ModelDirectory: filepath.Join(layout.AIModelsDir, "face"),
			ModelFiles: []AIStorageFile{
				modelFile(filepath.Join(layout.AIModelsDir, "face", "face_detection_yunet_2023mar.onnx"), AIStorageModelCache),
				modelFile(filepath.Join(layout.AIModelsDir, "face", "face_recognition_sface_2021dec.onnx"), AIStorageModelCache),
			},
			Outputs: []AIStorageOutput{
				{
					Kind:  AIStorageOutputBatches,
					Label: "批次结果",
					Path:  filepath.Join(layout.MetadataDir, AIJobTypeFace),
				},
				{
					Kind:  AIStorageOutputIndex,
					Label: "人物索引",
					Path:  filepath.Join(layout.AIDerivedDir, "people-index.json"),
				},
			},
		},
	}
}

// scanAIStorage 统计模型权重与各模块产物。
func scanAIStorage(cacheRoot string, workerDirectory string) AIStorageUsage {
	root := absolutePath(cacheRoot)
	layout := ResolveCacheLayout(root)
	workerDirectory = absolutePath(workerDirectory)
	pythonEnvironment := filepath.Join(workerDirectory, ".venv")

	modules := aiStorageModules(layout, pythonEnvironment)
	summary := AIStorageSummary{}
	for index := range modules {
		module := &modules[index]
		statModelFiles(module)
		// 模型文件按位置类别选相对基准：缓存内的相对缓存根，
		// Python 环境里的相对 Python 环境。
		modelBase := root
		if module.ModelLocation == AIStorageModelPython {
			modelBase = pythonEnvironment
		}
		for fileIndex := range module.ModelFiles {
			file := &module.ModelFiles[fileIndex]
			file.Path = relativePath(modelBase, file.Path)
			module.ModelBytes += file.SizeBytes
		}
		module.ModelDirectory = relativePath(modelBase, module.ModelDirectory)
		summary.ModelBytes += module.ModelBytes
		summary.ModelFileCount += len(module.ModelFiles)

		for outputIndex := range module.Outputs {
			output := &module.Outputs[outputIndex]
			scanned := scanAIStorageTarget(output.Path)
			output.Bytes = scanned.bytes
			output.FileCount = scanned.fileCount
			output.Available = scanned.available
			output.Path = relativePath(root, output.Path)
			module.OutputBytes += output.Bytes
			module.OutputFileCount += output.FileCount
		}
		summary.OutputBytes += module.OutputBytes
		summary.OutputFileCount += module.OutputFileCount
	}

	available := true
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		available = false
	}

	return AIStorageUsage{
		ScannedAt: time.Now(),
		Available:  available,
		Summary:    summary,
		Modules:    modules,
		Paths: AIStorageRelativePaths{
			RelativeTo:         "cacheRoot",
			StateDirectory:     relativePath(root, layout.StateDir),
			JobsFile:           relativePath(root, layout.AIJobsPath),
			MetadataDirectory:  relativePath(root, layout.MetadataDir),
			AIDerivedDirectory: relativePath(root, layout.AIDerivedDir),
			VectorDirectory:    relativePath(root, layout.AIVectorsDir),
			ModelDirectory:     relativePath(root, layout.AIModelsDir),
		},
	}
}

// aiStorageScanResult 一个目录或单个文件的占用。
type aiStorageScanResult struct {
	bytes     int64
	fileCount int
	available bool
}

// scanAIStorageTarget 统计目录或单个文件的占用。
func scanAIStorageTarget(path string) aiStorageScanResult {
	info, err := os.Stat(path)
	if err != nil {
		return aiStorageScanResult{}
	}
	if !info.IsDir() {
		if !info.Mode().IsRegular() {
			return aiStorageScanResult{}
		}
		return aiStorageScanResult{bytes: info.Size(), fileCount: 1, available: true}
	}
	result := aiStorageScanResult{available: true}
	_ = filepath.WalkDir(path, func(_ string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		fileInfo, err := entry.Info()
		if err != nil || !fileInfo.Mode().IsRegular() {
			return nil
		}
		result.bytes += fileInfo.Size()
		result.fileCount++
		return nil
	})
	return result
}

// relativePath 返回 target 相对 base 的斜杠路径。
//
// target 不在 base 之下时返回空串：那种路径没有可以公开的相对表示。
func relativePath(base string, target string) string {
	if base == "" || target == "" {
		return ""
	}
	rel, err := filepath.Rel(base, target)
	if err != nil {
		return ""
	}
	if rel == "." {
		return ""
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return ""
	}
	return filepath.ToSlash(rel)
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

func modelFile(path string, location string) AIStorageFile {
	return AIStorageFile{Name: filepath.Base(path), Path: path, Location: location}
}

// scanAIModelFiles 列出目录里的 onnx 权重。
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
		files = append(files, modelFile(filepath.Join(directory, entry.Name()), AIStorageModelPython))
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	return files
}

// findRapidOCRModelDirectory 找到 RapidOCR 的权重目录。
//
// OCR 权重随 pip 包安装，不在缓存根目录里；它跟着 Python 环境走，
// 因此位置类别是 python 而不是 cache。
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
