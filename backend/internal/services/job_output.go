package services

import (
	"path/filepath"
	"sync"
	"time"
)

// AIJobOutputUsage 单次分析任务已提交批次的占用。
//
// Path 是相对缓存根目录的路径：批次目录按任务 ID 分目录，这个相对路径
// 就是「这次任务的结果落在哪」的答案，不含任何本机绝对路径。
type AIJobOutputUsage struct {
	JobID     string    `json:"jobId"`
	Type      string    `json:"type"`
	BatchSize int       `json:"batchSize"`
	Path      string    `json:"path"`
	Bytes     int64     `json:"bytes"`
	FileCount int       `json:"fileCount"`
	Available bool      `json:"available"`
	ScannedAt time.Time `json:"scannedAt"`
}

// jobOutputEntry 单个任务的产物缓存。
type jobOutputEntry struct {
	usage   AIJobOutputUsage
	expiry  time.Time
	invalid bool
}

// JobOutputService 统计单次任务产物目录的占用。
//
// 一个任务的批次目录有「图片数 / 每批张数」个文件，全量历史都展开一遍
// 相当于走一遍派生目录；这里按任务 ID 缓存 60 秒，重复展开零成本。
type JobOutputService struct {
	mu    sync.Mutex
	cache map[string]jobOutputEntry
	root  string
	ttl   time.Duration
}

// NewJobOutputService 构造；root 是缓存根目录，ttl 通常 60s。
func NewJobOutputService(root string, ttl time.Duration) *JobOutputService {
	if ttl <= 0 {
		ttl = 60 * time.Second
	}
	return &JobOutputService{
		cache: map[string]jobOutputEntry{},
		root:  absolutePath(root),
		ttl:   ttl,
	}
}

// Invalidate 清掉缓存，下次读取重新统计。
func (s *JobOutputService) Invalidate() {
	s.mu.Lock()
	s.cache = map[string]jobOutputEntry{}
	s.mu.Unlock()
}

// Usage 返回该次任务产物目录的占用。
//
// 目录已经不存在时给出 available=false，但仍返回它本该在的相对路径 ——
// 用户要看到的是「结果本来落在哪」，而不是一句「没了」。
func (s *JobOutputService) Usage(jobID string, moduleType string, directory string) AIJobOutputUsage {
	s.mu.Lock()
	if entry, ok := s.cache[jobID]; ok && !entry.invalid && time.Now().Before(entry.expiry) {
		usage := entry.usage
		s.mu.Unlock()
		return usage
	}
	s.mu.Unlock()

	usage := AIJobOutputUsage{
		JobID:     jobID,
		Type:      moduleType,
		BatchSize: AIBatchSize,
		Path:      relativePath(s.root, directory),
		ScannedAt: time.Now(),
	}
	scanned := scanAIStorageTarget(directory)
	usage.Bytes = scanned.bytes
	usage.FileCount = scanned.fileCount
	usage.Available = scanned.available

	s.mu.Lock()
	s.cache[jobID] = jobOutputEntry{usage: usage, expiry: time.Now().Add(s.ttl)}
	s.mu.Unlock()
	return usage
}

// JobOutputDir 返回该次任务已提交批次的目录与模块类型。
//
// 目录与类型都取自任务记录本身，不取自调用方给的标识：这样外部传入的
// 任何字符串都不会参与路径拼接。
func (s *AIJobService) JobOutputDir(jobID string) (string, string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.jobs[jobID]
	if !ok {
		return "", "", false
	}
	return filepath.Join(s.metadataDir, job.Type, "batches", job.ID), job.Type, true
}
