package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/tianlongxiang/local-gallery/internal/models"
)

const (
	AIJobTypeMetadata  = "metadata"
	AIJobTypeEmbedding = "embedding"
	AIJobTypeOCR       = "ocr"
	AIJobTypeFace      = "face"

	AIJobModeFull        = "full"
	AIJobModeIncremental = "incremental"

	AIJobStatusPending   = "pending"
	AIJobStatusRunning   = "running"
	AIJobStatusPaused    = "paused"
	AIJobStatusCompleted = "completed"
	AIJobStatusFailed    = "failed"
	AIJobStatusCancelled = "cancelled"

	// 分析模块在单条结果里报告的字段标识，用于按字段统计任务产出。
	AIFieldExifTime  = "exifTime"
	AIFieldCamera    = "camera"
	AIFieldGPS       = "gps"
	AIFieldEmbedding = "embedding"
	AIFieldOCRText   = "ocrText"
	AIFieldFaces     = "faces"

	aiJobStoreVersion = 1
	// AIBatchSize 是一批提交的图片数；批次文件按这个粒度落在派生目录里。
	AIBatchSize  = 32
	aiMaxWorkers = 4
	// aiStatWorkerCount 是采集文件指纹时的并发数。stat 是 IO 密集的，
	// 单独于分析 worker 的上限。
	aiStatWorkerCount = 8
)

var ErrAIJobActive = errors.New("an analysis job is already active")
var ErrAIJobNotFound = errors.New("analysis job not found")
var ErrAIJobNotManageable = errors.New("analysis job cannot be managed in its current state")
var ErrAIJobInvalidDirection = errors.New("invalid queue direction")
var ErrAIAnalyzerUnavailable = errors.New("analysis module runtime or model is unavailable")
var ErrPeopleAnalysisDisabled = errors.New("people analysis is disabled")

// AIAnalysisOutput 是一个分析模块对单个媒体返回的可序列化结果。
type AIAnalysisOutput struct {
	Status       string          `json:"status"`
	Data         json.RawMessage `json:"data,omitempty"`
	ErrorCode    string          `json:"errorCode,omitempty"`
	ErrorMessage string          `json:"errorMessage,omitempty"`
	// Fields 列出这条结果里实际有值的字段标识；任务按字段累计产出。
	Fields []string `json:"fields,omitempty"`
}

// AIAnalyzer 是 metadata / embedding / ocr / face 模块的扩展边界。
// 每个模块提供独立版本号，版本变化只会使本模块的结果失效。
type AIAnalyzer interface {
	Type() string
	Version() string
	Analyze(context.Context, io.ReadSeeker) (AIAnalysisOutput, error)
}

// AIAnalyzerBatch 可选地覆盖同一任务提交批次的推理，供 GPU 模块调用常驻 Worker。
type AIAnalyzerBatch interface {
	AnalyzeBatch(context.Context, []AIAnalysisInput) ([]AIAnalysisOutput, error)
}

// AIAnalyzerHardware validates and executes a task using its captured device mode.
type AIAnalyzerHardware interface {
	ValidateHardware(context.Context, string) error
}

type AIAnalysisInput struct {
	ResourceID    string
	Path          string
	Size          int64
	MTimeNs       int64
	ComputeDevice string
}

type AIAnalyzerReadiness interface {
	Ready(context.Context) error
}

// AIAnalyzerAvailability reports whether an optional module's local runtime and models are ready.
type AIAnalyzerAvailability interface {
	Available() (bool, string)
}

type AIAnalyzerRecordValidator interface {
	RecordCurrent(AIAnalysisRecord) bool
}

type AIAnalyzerWorkerLimit interface {
	MaxWorkers() int
}

type AIAnalyzerCloser interface {
	Close() error
}

// MetadataAnalyzer 使用 EXIF 解析器实现 metadata 模块。
type MetadataAnalyzer struct{}

func (MetadataAnalyzer) Type() string    { return AIJobTypeMetadata }
func (MetadataAnalyzer) Version() string { return MetadataParserVersion }
func (MetadataAnalyzer) Analyze(ctx context.Context, reader io.ReadSeeker) (AIAnalysisOutput, error) {
	if err := ctx.Err(); err != nil {
		return AIAnalysisOutput{}, err
	}
	metadata, err := ParseImageMetadata(reader)
	if err != nil {
		return AIAnalysisOutput{}, err
	}
	data, err := json.Marshal(metadata)
	if err != nil {
		return AIAnalysisOutput{}, err
	}
	return AIAnalysisOutput{Status: metadata.Status, Data: data, Fields: metadataFields(metadata)}, nil
}

// metadataFields 报告这条元数据里实际有值的字段。
func metadataFields(metadata ImageMetadata) []string {
	fields := make([]string, 0, 3)
	if metadata.DateTimeOriginal != "" {
		fields = append(fields, AIFieldExifTime)
	}
	if metadata.CameraMake != "" || metadata.CameraModel != "" {
		fields = append(fields, AIFieldCamera)
	}
	if metadata.GPS != nil {
		fields = append(fields, AIFieldGPS)
	}
	return fields
}

// AIJobCheckpoint 是某个模块任务的独立恢复游标。
type AIJobCheckpoint struct {
	Offset         int    `json:"offset"`
	LastResourceID string `json:"lastResourceId,omitempty"`
	TargetDigest   string `json:"targetDigest,omitempty"`
	Batch          int    `json:"batch"`
	ModuleVersion  string `json:"moduleVersion"`
}

// AIJobError 保存资源 ID、根目录别名下的相对路径和脱敏原因，不保存绝对路径。
type AIJobError struct {
	ResourceID string    `json:"resourceId"`
	Path       string    `json:"path,omitempty"`
	Code       string    `json:"code"`
	Message    string    `json:"message"`
	At         time.Time `json:"at"`
}

// AIJob 是用户可查看的持久化任务记录。
type AIJob struct {
	ID                string          `json:"id"`
	Type              string          `json:"type"`
	Mode              string          `json:"mode"`
	Status            string          `json:"status"`
	Stage             string          `json:"stage"`
	ModuleVersion     string          `json:"moduleVersion"`
	Total             int             `json:"total"`
	Processed         int             `json:"processed"`
	Skipped           int             `json:"skipped"`
	Failed            int             `json:"failed"`
	Done              int             `json:"done"`
	CurrentResourceID string          `json:"currentResourceId,omitempty"`
	Checkpoint        AIJobCheckpoint `json:"checkpoint"`
	Errors            []AIJobError    `json:"errors,omitempty"`
	Error             string          `json:"error,omitempty"`
	ErrorCode         string          `json:"errorCode,omitempty"`
	ComputeDevice     string          `json:"computeDevice"`
	Scheduled         bool            `json:"scheduled,omitempty"`
	RetryOf           string          `json:"retryOf,omitempty"`
	RetryFailedOnly   bool            `json:"retryFailedOnly,omitempty"`
	RetryFromOffset   int             `json:"retryFromOffset,omitempty"`
	StartedAt         *time.Time      `json:"startedAt,omitempty"`
	FinishedAt        *time.Time      `json:"finishedAt,omitempty"`
	CreatedAt         time.Time       `json:"createdAt"`
	UpdatedAt         time.Time       `json:"updatedAt"`
	ElapsedMs         int64           `json:"elapsedMs"`
	SpeedPerSecond    float64         `json:"speedPerSecond"`
	// Planned 是本次任务实际要处理的张数，Completed 是已处理张数。
	// 两者由快照按持久化计数推导，不作为事实落盘。
	Planned   int `json:"planned"`
	Completed int `json:"completed"`
	// EstimatedRemainingMs 是运行中任务的预计剩余毫秒，同样是快照派生值。
	EstimatedRemainingMs int64 `json:"estimatedRemainingMs"`
	// Results 按解析结果分类计数，Fields 按字段统计产出；两者是事实，落盘保留。
	Results map[string]int `json:"results,omitempty"`
	Fields  map[string]int `json:"fields,omitempty"`
}

// AIJobSettings 放在 state/，不属于可重建的 derived 数据。
type AIJobSettings struct {
	DailyEnabled      bool     `json:"dailyEnabled"`
	DailyTime         string   `json:"dailyTime"`
	DailyModules      []string `json:"dailyModules"`
	PeopleEnabled     bool     `json:"peopleEnabled"`
	GPUEnabled        bool     `json:"gpuEnabled"`
	LastScheduledDate string   `json:"lastScheduledDate,omitempty"`
	gpuEnabledSet     bool
}

func (s *AIJobSettings) UnmarshalJSON(data []byte) error {
	type plain AIJobSettings
	var value plain
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*s = AIJobSettings(value)
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	_, s.gpuEnabledSet = fields["gpuEnabled"]
	return nil
}

type AIJobSnapshot struct {
	Jobs     []AIJob       `json:"jobs"`
	Active   *AIJob        `json:"active,omitempty"`
	Queue    []string      `json:"queue"`
	Settings AIJobSettings `json:"settings"`
	// Modules 列出全部已知分析模块及其安装状态，前端不再硬编码模块名。
	Modules []AIJobModule `json:"modules"`
}

// AIJobModule 描述一个分析模块的安装情况。
type AIJobModule struct {
	Type      string `json:"type"`
	Name      string `json:"name"`
	Installed bool   `json:"installed"`
	Version   string `json:"version,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// AIAnalysisRecord 是 derived/metadata 中可重建的单资源分析结果。
type AIAnalysisRecord struct {
	Type          string          `json:"type"`
	ResourceID    string          `json:"resourceId"`
	Size          int64           `json:"size"`
	MTimeNs       int64           `json:"mtimeNs"`
	ModuleVersion string          `json:"moduleVersion"`
	Status        string          `json:"status"`
	Data          json.RawMessage `json:"data,omitempty"`
	ErrorCode     string          `json:"errorCode,omitempty"`
	ErrorMessage  string          `json:"errorMessage,omitempty"`
	UpdatedAt     time.Time       `json:"updatedAt"`
	// Fields 记录这条结果里实际有值的字段；批次重放要靠它还原任务产出。
	Fields []string `json:"fields,omitempty"`
}

type AIJobServiceOptions struct {
	StatePath          string
	MetadataDir        string
	Catalog            *ResourceCatalog
	ValidatePath       func(string) (string, error)
	Analyzers          []AIAnalyzer
	WorkerCount        int
	Now                func() time.Time
	OnRecordsCommitted func([]AIAnalysisRecord)
	// OnRecordsCleared 在某个模块的派生结果被整体删除后调用，
	// 让按目录统计的占用缓存重新扫描。
	OnRecordsCleared func()
}

type aiJobDiskState struct {
	Version  int           `json:"version"`
	Jobs     []AIJob       `json:"jobs"`
	Queue    []string      `json:"queue,omitempty"`
	Settings AIJobSettings `json:"settings"`
}

type aiJobBatch struct {
	JobID          string             `json:"jobId"`
	Number         int                `json:"number"`
	Offset         int                `json:"offset"`
	LastResourceID string             `json:"lastResourceId"`
	TargetDigest   string             `json:"targetDigest"`
	Records        []AIAnalysisRecord `json:"records"`
}

type aiJobRuntime struct {
	ctx            context.Context
	cancel         context.CancelFunc
	resume         chan struct{}
	pauseRequested bool
	stopReason     string
}

type aiJobTarget struct {
	resourceID  string
	path        string
	displayPath string
	position    int
	size        int64
	mtimeNs     int64
	statCode    string
}

// AIJobService 持久化分析任务，并通过有界 worker 处理图片元数据。
type AIJobService struct {
	mu                 sync.Mutex
	statePath          string
	metadataDir        string
	catalog            *ResourceCatalog
	validatePath       func(string) (string, error)
	analyzers          map[string]AIAnalyzer
	workerCount        int
	now                func() time.Time
	onRecordsCommitted func([]AIAnalysisRecord)
	onRecordsCleared   func()
	jobs               map[string]*AIJob
	order              []string
	queue              []string
	records            map[string]AIAnalysisRecord
	// recordsRevision 在分析结果增删改时递增。
	// 依赖分析结果的派生数据（如离线地点图谱）用它判断缓存是否过期。
	recordsRevision uint64
	runtimes        map[string]*aiJobRuntime
	subs            map[string]map[chan AIJob]struct{}
	activeID        string
	closed          bool
	settings        AIJobSettings
	stopSchedule    context.CancelFunc
	closeOnce       sync.Once
	wg              sync.WaitGroup
	// targetCache 是文件指纹清单的短时缓存，只服务空闲时的规模预估。
	// 它有自己的锁，避免把 stat 的等待混进任务状态锁。
	targetCacheMu sync.Mutex
	targetCache   *aiTargetCache
}

// aiTargetCache 是一次文件指纹采集的结果，按媒体库 revision 归类。
type aiTargetCache struct {
	revision uint64
	builtAt  time.Time
	targets  []aiJobTarget
}

func NewAIJobService(options AIJobServiceOptions) (*AIJobService, error) {
	if options.StatePath == "" || options.MetadataDir == "" || options.Catalog == nil || options.ValidatePath == nil {
		return nil, errors.New("AI job service requires state, metadata, catalog, and path validation")
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.WorkerCount <= 0 {
		options.WorkerCount = aiWorkerCount()
	}
	options.WorkerCount = min(options.WorkerCount, aiMaxWorkers)

	service := &AIJobService{
		statePath:          options.StatePath,
		metadataDir:        options.MetadataDir,
		catalog:            options.Catalog,
		validatePath:       options.ValidatePath,
		analyzers:          make(map[string]AIAnalyzer, len(options.Analyzers)),
		workerCount:        options.WorkerCount,
		now:                options.Now,
		onRecordsCommitted: options.OnRecordsCommitted,
		onRecordsCleared:   options.OnRecordsCleared,
		jobs:               make(map[string]*AIJob),
		records:            make(map[string]AIAnalysisRecord),
		runtimes:           make(map[string]*aiJobRuntime),
		subs:               make(map[string]map[chan AIJob]struct{}),
		settings:           AIJobSettings{DailyEnabled: true, DailyTime: "03:00", DailyModules: []string{AIJobTypeMetadata}, GPUEnabled: true},
	}
	for _, analyzer := range options.Analyzers {
		if analyzer == nil || !validAIJobType(analyzer.Type()) || strings.TrimSpace(analyzer.Version()) == "" {
			return nil, errors.New("AI analyzer has invalid type or version")
		}
		if _, exists := service.analyzers[analyzer.Type()]; exists {
			return nil, fmt.Errorf("duplicate AI analyzer type %q", analyzer.Type())
		}
		service.analyzers[analyzer.Type()] = analyzer
	}
	if _, exists := service.analyzers[AIJobTypeMetadata]; !exists {
		return nil, errors.New("metadata analyzer is required")
	}
	if err := os.MkdirAll(options.MetadataDir, 0o755); err != nil {
		return nil, fmt.Errorf("create metadata directory: %w", err)
	}
	if err := service.loadState(); err != nil {
		return nil, err
	}
	if err := service.loadRecords(); err != nil {
		return nil, err
	}
	service.recoverInterruptedJobs()
	return service, nil
}

// Start 创建并启动已注册分析模块的全量或增量任务。
func (s *AIJobService) Start(moduleType, mode string) (AIJob, bool, error) {
	if mode != AIJobModeFull && mode != AIJobModeIncremental {
		return AIJob{}, false, errors.New("unknown analysis mode")
	}
	if moduleType == AIJobTypeFace && !s.PeopleEnabled() {
		return AIJob{}, false, ErrPeopleAnalysisDisabled
	}
	analyzer, exists := s.analyzers[moduleType]
	if !exists {
		if validAIJobType(moduleType) {
			return AIJob{}, false, fmt.Errorf("analysis module %q is not installed", moduleType)
		}
		return AIJob{}, false, errors.New("unknown analysis module")
	}
	if !aiAnalyzerAvailable(analyzer) {
		return AIJob{}, false, ErrAIAnalyzerUnavailable
	}
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return AIJob{}, false, errors.New("AI job service is shutting down")
	}
	if readiness, ok := analyzer.(AIAnalyzerReadiness); ok {
		readyCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := readiness.Ready(readyCtx); err != nil {
			return AIJob{}, false, err
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return AIJob{}, false, errors.New("AI job service is shutting down")
	}
	if moduleType == AIJobTypeFace && !s.settings.PeopleEnabled {
		return AIJob{}, false, ErrPeopleAnalysisDisabled
	}
	if s.activeID != "" {
		active := s.jobs[s.activeID]
		if active != nil && active.Type == moduleType && active.Mode == mode && isAIJobActive(active.Status) {
			return s.snapshotLocked(active), true, nil
		}
		return AIJob{}, false, ErrAIJobActive
	}
	if s.hasPendingJobsLocked() {
		return AIJob{}, false, ErrAIJobActive
	}
	job := s.newJobLocked(moduleType, mode)
	s.jobs[job.ID] = &job
	s.order = append(s.order, job.ID)
	s.activeID = job.ID
	if err := s.persistLocked(); err != nil {
		delete(s.jobs, job.ID)
		s.order = s.order[:len(s.order)-1]
		s.activeID = ""
		return AIJob{}, false, err
	}
	s.launchLocked(job.ID)
	return s.snapshotLocked(&job), false, nil
}

// StartAll 按固定模块顺序把所有已就绪的分析任务写入现有任务队列。
func (s *AIJobService) StartAll(mode string) ([]AIJob, []AIJobModule, error) {
	if mode != AIJobModeFull && mode != AIJobModeIncremental {
		return nil, nil, errors.New("unknown analysis mode")
	}
	moduleTypes := []string{AIJobTypeMetadata, AIJobTypeEmbedding, AIJobTypeOCR, AIJobTypeFace}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, nil, errors.New("AI job service is shutting down")
	}
	if s.hasPendingJobsLocked() {
		s.mu.Unlock()
		return nil, nil, ErrAIJobActive
	}
	peopleEnabled := s.settings.PeopleEnabled
	analyzers := make(map[string]AIAnalyzer, len(moduleTypes))
	for _, moduleType := range moduleTypes {
		analyzers[moduleType] = s.analyzers[moduleType]
	}
	s.mu.Unlock()

	readyModules := make([]string, 0, len(moduleTypes))
	skippedModules := make([]AIJobModule, 0)
	for _, moduleType := range moduleTypes {
		if moduleType == AIJobTypeFace && !peopleEnabled {
			skippedModules = append(skippedModules, AIJobModule{
				Type: moduleType, Name: aiJobModuleName(moduleType), Reason: "people_analysis_disabled",
			})
			continue
		}
		analyzer := analyzers[moduleType]
		if analyzer == nil {
			skippedModules = append(skippedModules, AIJobModule{
				Type: moduleType, Name: aiJobModuleName(moduleType), Reason: "module_not_registered",
			})
			continue
		}
		if available, reason := aiAnalyzerAvailability(analyzer); !available {
			skippedModules = append(skippedModules, AIJobModule{
				Type: moduleType, Name: aiJobModuleName(moduleType), Reason: reason,
			})
			continue
		}
		if readiness, ok := analyzer.(AIAnalyzerReadiness); ok {
			readyCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			err := readiness.Ready(readyCtx)
			cancel()
			if err != nil {
				_, reason := aiAnalyzerAvailability(analyzer)
				if reason == "" {
					reason = "runtime_unavailable"
				}
				skippedModules = append(skippedModules, AIJobModule{
					Type: moduleType, Name: aiJobModuleName(moduleType), Reason: reason,
				})
				continue
			}
		}
		readyModules = append(readyModules, moduleType)
	}
	if len(readyModules) == 0 {
		return nil, skippedModules, ErrAIAnalyzerUnavailable
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, nil, errors.New("AI job service is shutting down")
	}
	if s.hasPendingJobsLocked() {
		return nil, nil, ErrAIJobActive
	}
	previousOrderLength := len(s.order)
	previousQueue := append([]string(nil), s.queue...)
	jobIDs := make([]string, 0, len(readyModules))
	for _, moduleType := range readyModules {
		job := s.newJobLocked(moduleType, mode)
		s.jobs[job.ID] = &job
		s.order = append(s.order, job.ID)
		jobIDs = append(jobIDs, job.ID)
	}
	s.activeID = jobIDs[0]
	s.queue = append([]string(nil), jobIDs[1:]...)
	if err := s.persistLocked(); err != nil {
		for _, id := range jobIDs {
			delete(s.jobs, id)
		}
		s.order = s.order[:previousOrderLength]
		s.queue = previousQueue
		s.activeID = ""
		return nil, nil, err
	}
	s.launchLocked(jobIDs[0])
	jobs := make([]AIJob, 0, len(jobIDs))
	for _, id := range jobIDs {
		jobs = append(jobs, s.snapshotLocked(s.jobs[id]))
	}
	return jobs, skippedModules, nil
}

func (s *AIJobService) hasPendingJobsLocked() bool {
	if s.activeID != "" {
		return true
	}
	for _, job := range s.jobs {
		if isAIJobActive(job.Status) || job.Status == AIJobStatusPending {
			return true
		}
	}
	return false
}

// Pause 请求在当前批次原子提交后暂停任务。
func (s *AIJobService) Pause(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	job := s.jobs[id]
	runtimeState := s.runtimes[id]
	if job == nil || runtimeState == nil || !isAIJobActive(job.Status) || job.Status == AIJobStatusPaused {
		return false
	}
	previousStage, previousUpdated := job.Stage, job.UpdatedAt
	runtimeState.pauseRequested = true
	job.Stage = "pausing"
	job.UpdatedAt = s.now()
	if err := s.persistLocked(); err != nil {
		runtimeState.pauseRequested = false
		job.Stage, job.UpdatedAt = previousStage, previousUpdated
		return false
	}
	s.publishLocked(*job)
	return true
}

// Resume 恢复一个暂停任务；重启后持久化的 paused 任务会新建 runner。
func (s *AIJobService) Resume(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	job := s.jobs[id]
	if job == nil || job.Status != AIJobStatusPaused || s.closed {
		return false
	}
	if s.activeID != "" && s.activeID != id {
		return false
	}
	s.activeID = id
	if runtimeState := s.runtimes[id]; runtimeState != nil {
		previousStage, previousStatus, previousUpdated := job.Stage, job.Status, job.UpdatedAt
		runtimeState.pauseRequested = false
		job.Status = AIJobStatusRunning
		job.Stage = "processing"
		job.UpdatedAt = s.now()
		if err := s.persistLocked(); err != nil {
			runtimeState.pauseRequested = true
			job.Status, job.Stage, job.UpdatedAt = previousStatus, previousStage, previousUpdated
			return false
		}
		s.publishLocked(*job)
		select {
		case runtimeState.resume <- struct{}{}:
		default:
		}
		return true
	}
	job.Status = AIJobStatusPending
	job.Stage = "pending"
	job.UpdatedAt = s.now()
	if err := s.persistLocked(); err != nil {
		job.Status = AIJobStatusPaused
		return false
	}
	s.publishLocked(*job)
	s.launchLocked(id)
	return true
}

// Cancel 取消任务；已提交批次保留，未提交的当前批次会幂等重跑。
func (s *AIJobService) Cancel(id string) bool {
	s.mu.Lock()
	job := s.jobs[id]
	runtimeState := s.runtimes[id]
	if job == nil || !isAIJobActive(job.Status) {
		s.mu.Unlock()
		return false
	}
	if job.Status == AIJobStatusPending && runtimeState == nil {
		queueIndex := slices.Index(s.queue, id)
		if queueIndex < 0 {
			s.mu.Unlock()
			return false
		}
		previousQueue := append([]string(nil), s.queue...)
		previousStatus, previousStage, previousUpdated, previousFinished := job.Status, job.Stage, job.UpdatedAt, job.FinishedAt
		s.queue = slices.Delete(s.queue, queueIndex, queueIndex+1)
		job.Status = AIJobStatusCancelled
		job.Stage = AIJobStatusCancelled
		finished := s.now()
		job.FinishedAt = &finished
		job.UpdatedAt = finished
		if err := s.persistLocked(); err != nil {
			s.queue = previousQueue
			job.Status, job.Stage, job.UpdatedAt, job.FinishedAt = previousStatus, previousStage, previousUpdated, previousFinished
			s.mu.Unlock()
			return false
		}
		s.publishLocked(*job)
		s.mu.Unlock()
		return true
	}
	if runtimeState == nil {
		if job.Status != AIJobStatusPaused {
			s.mu.Unlock()
			return false
		}
		previousStatus, previousStage, previousUpdated, previousFinished, previousActive := job.Status, job.Stage, job.UpdatedAt, job.FinishedAt, s.activeID
		job.Status = AIJobStatusCancelled
		job.Stage = AIJobStatusCancelled
		finished := s.now()
		job.FinishedAt = &finished
		job.UpdatedAt = finished
		if s.activeID == id {
			s.activeID = ""
		}
		if err := s.persistLocked(); err != nil {
			job.Status, job.Stage, job.UpdatedAt, job.FinishedAt = previousStatus, previousStage, previousUpdated, previousFinished
			s.activeID = previousActive
			s.mu.Unlock()
			return false
		}
		s.publishLocked(*job)
		s.mu.Unlock()
		s.StartPending()
		return true
	}
	runtimeState.stopReason = "user"
	runtimeState.cancel()
	s.mu.Unlock()
	return true
}

// MovePending moves a queued task one position up or down.
func (s *AIJobService) MovePending(id, direction string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	job := s.jobs[id]
	if job == nil {
		return ErrAIJobNotFound
	}
	if job.Status != AIJobStatusPending {
		return ErrAIJobNotManageable
	}
	index := slices.Index(s.queue, id)
	if index < 0 {
		return ErrAIJobNotManageable
	}
	target := index
	switch direction {
	case "up":
		target--
	case "down":
		target++
	default:
		return ErrAIJobInvalidDirection
	}
	if target < 0 || target >= len(s.queue) {
		return ErrAIJobNotManageable
	}
	s.queue[index], s.queue[target] = s.queue[target], s.queue[index]
	if err := s.persistLocked(); err != nil {
		s.queue[index], s.queue[target] = s.queue[target], s.queue[index]
		return err
	}
	return nil
}

// ClearPending cancels all waiting tasks while leaving the active task untouched.
func (s *AIJobService) ClearPending() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.queue) == 0 {
		return 0, nil
	}
	previousQueue := append([]string(nil), s.queue...)
	type previousJobState struct {
		job      *AIJob
		status   string
		stage    string
		updated  time.Time
		finished *time.Time
	}
	previous := make([]previousJobState, 0, len(s.queue))
	finished := s.now()
	for _, id := range s.queue {
		job := s.jobs[id]
		if job == nil || job.Status != AIJobStatusPending {
			continue
		}
		previous = append(previous, previousJobState{job: job, status: job.Status, stage: job.Stage, updated: job.UpdatedAt, finished: job.FinishedAt})
		job.Status = AIJobStatusCancelled
		job.Stage = AIJobStatusCancelled
		job.FinishedAt = &finished
		job.UpdatedAt = finished
	}
	s.queue = nil
	if err := s.persistLocked(); err != nil {
		s.queue = previousQueue
		for _, state := range previous {
			state.job.Status, state.job.Stage, state.job.UpdatedAt, state.job.FinishedAt = state.status, state.stage, state.updated, state.finished
		}
		return 0, err
	}
	for _, state := range previous {
		s.publishLocked(*state.job)
	}
	return len(previous), nil
}

// DeleteHistory deletes one terminal task record without touching its analysis results.
func (s *AIJobService) DeleteHistory(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	job := s.jobs[id]
	if job == nil {
		return ErrAIJobNotFound
	}
	if !isAIJobTerminal(job.Status) {
		return ErrAIJobNotManageable
	}
	previousOrder := append([]string(nil), s.order...)
	delete(s.jobs, id)
	s.order = slices.DeleteFunc(s.order, func(value string) bool { return value == id })
	if err := s.persistLocked(); err != nil {
		s.jobs[id] = job
		s.order = previousOrder
		return err
	}
	return nil
}

// ClearHistory deletes terminal task records while preserving pending and active tasks.
func (s *AIJobService) ClearHistory() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	deleted := make(map[string]*AIJob)
	keptOrder := make([]string, 0, len(s.order))
	for _, id := range s.order {
		job := s.jobs[id]
		if job != nil && isAIJobTerminal(job.Status) {
			deleted[id] = job
			continue
		}
		keptOrder = append(keptOrder, id)
	}
	if len(deleted) == 0 {
		return 0, nil
	}
	previousOrder := s.order
	for id := range deleted {
		delete(s.jobs, id)
	}
	s.order = keptOrder
	if err := s.persistLocked(); err != nil {
		for id, job := range deleted {
			s.jobs[id] = job
		}
		s.order = previousOrder
		return 0, err
	}
	return len(deleted), nil
}

func isAIJobTerminal(status string) bool {
	return status == AIJobStatusCompleted || status == AIJobStatusFailed || status == AIJobStatusCancelled
}

// Retry 从失败或取消任务创建新的历史项，只重试失败记录与未提交尾段。
func (s *AIJobService) Retry(id string) (AIJob, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return AIJob{}, errors.New("AI job service is shutting down")
	}
	if s.hasPendingJobsLocked() {
		return AIJob{}, ErrAIJobActive
	}
	previous := s.jobs[id]
	if previous == nil {
		return AIJob{}, errors.New("analysis job not found")
	}
	if previous.Status != AIJobStatusFailed && previous.Status != AIJobStatusCancelled {
		return AIJob{}, errors.New("only failed or cancelled jobs can be retried")
	}
	job := s.newJobLocked(previous.Type, previous.Mode)
	job.RetryOf = previous.ID
	job.RetryFailedOnly = true
	job.RetryFromOffset = previous.Checkpoint.Offset
	s.jobs[job.ID] = &job
	s.order = append(s.order, job.ID)
	s.activeID = job.ID
	if err := s.persistLocked(); err != nil {
		delete(s.jobs, job.ID)
		s.order = s.order[:len(s.order)-1]
		s.activeID = ""
		return AIJob{}, err
	}
	s.launchLocked(job.ID)
	return s.snapshotLocked(&job), nil
}

func (s *AIJobService) Get(id string) (AIJob, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job := s.jobs[id]
	if job == nil {
		return AIJob{}, false
	}
	return s.snapshotLocked(job), true
}

func (s *AIJobService) List() AIJobSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := AIJobSnapshot{
		Settings: s.copySettingsLocked(),
		Jobs:     make([]AIJob, 0, len(s.order)),
		Queue:    append([]string{}, s.queue...),
		Modules:  s.modulesLocked(),
	}
	for index := len(s.order) - 1; index >= 0; index-- {
		if job := s.jobs[s.order[index]]; job != nil {
			copy := s.snapshotLocked(job)
			result.Jobs = append(result.Jobs, copy)
			if job.ID == s.activeID {
				active := copy
				result.Active = &active
			}
		}
	}
	return result
}

// modulesLocked 列出全部已知分析模块及其安装情况。
func (s *AIJobService) modulesLocked() []AIJobModule {
	known := []string{AIJobTypeMetadata, AIJobTypeEmbedding, AIJobTypeOCR, AIJobTypeFace}
	modules := make([]AIJobModule, 0, len(known))
	for _, moduleType := range known {
		module := AIJobModule{Type: moduleType, Name: aiJobModuleName(moduleType)}
		if analyzer, exists := s.analyzers[moduleType]; exists {
			module.Installed, module.Reason = aiAnalyzerAvailability(analyzer)
			if module.Installed {
				module.Version = analyzer.Version()
			}
		}
		modules = append(modules, module)
	}
	return modules
}

func aiAnalyzerAvailable(analyzer AIAnalyzer) bool {
	available, _ := aiAnalyzerAvailability(analyzer)
	return available
}

func aiAnalyzerAvailability(analyzer AIAnalyzer) (bool, string) {
	if availability, ok := analyzer.(AIAnalyzerAvailability); ok {
		return availability.Available()
	}
	return true, ""
}

// aiJobModuleName 给分析模块一个中文显示名。
func aiJobModuleName(moduleType string) string {
	switch moduleType {
	case AIJobTypeMetadata:
		return "照片元数据"
	case AIJobTypeEmbedding:
		return "向量索引"
	case AIJobTypeOCR:
		return "文字识别"
	case AIJobTypeFace:
		return "人脸识别"
	default:
		return moduleType
	}
}

// ConfigureDaily 更新持久化的本地每日调度设置。
func (s *AIJobService) ConfigureDaily(enabled bool, dailyTime string, dailyModules []string, peopleEnabled bool) (AIJobSettings, error) {
	if _, err := time.Parse("15:04", dailyTime); err != nil {
		return AIJobSettings{}, errors.New("daily time must use HH:MM")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return AIJobSettings{}, errors.New("AI job service is shutting down")
	}
	if !peopleEnabled && hasActiveAIJobType(s.jobs, AIJobTypeFace) {
		return AIJobSettings{}, ErrAIJobActive
	}
	if !peopleEnabled {
		dailyModules = withoutModule(dailyModules, AIJobTypeFace)
	}
	modules, err := s.normalizeDailyModulesLocked(dailyModules, enabled)
	if err != nil {
		return AIJobSettings{}, err
	}
	previous := s.copySettingsLocked()
	s.settings.DailyEnabled = enabled
	s.settings.DailyTime = dailyTime
	s.settings.DailyModules = modules
	s.settings.PeopleEnabled = peopleEnabled
	if err := s.persistLocked(); err != nil {
		s.settings = previous
		return AIJobSettings{}, err
	}
	return s.copySettingsLocked(), nil
}

// SetGPUEnabled updates the hardware plan for newly created jobs. Existing queued
// jobs keep the device mode captured when they were created.
func (s *AIJobService) SetGPUEnabled(enabled bool) (AIJobSettings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return AIJobSettings{}, errors.New("AI job service is shutting down")
	}
	previous := s.settings
	s.settings.GPUEnabled = enabled
	s.settings.gpuEnabledSet = true
	if err := s.persistLocked(); err != nil {
		s.settings = previous
		return AIJobSettings{}, err
	}
	return s.copySettingsLocked(), nil
}

// PeopleEnabled reports whether face analysis has been explicitly enabled.
func (s *AIJobService) PeopleEnabled() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.settings.PeopleEnabled
}

// SetPeopleEnabled controls face analysis without changing other schedule settings.
func (s *AIJobService) SetPeopleEnabled(enabled bool) (AIJobSettings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return AIJobSettings{}, errors.New("AI job service is shutting down")
	}
	if !enabled && hasActiveAIJobType(s.jobs, AIJobTypeFace) {
		return AIJobSettings{}, ErrAIJobActive
	}
	previous := s.copySettingsLocked()
	s.settings.PeopleEnabled = enabled
	if !enabled {
		s.settings.DailyModules = withoutModule(s.settings.DailyModules, AIJobTypeFace)
	}
	if err := s.persistLocked(); err != nil {
		s.settings = previous
		return AIJobSettings{}, err
	}
	return s.copySettingsLocked(), nil
}

// ClearModuleRecords removes a module's batch files and in-memory results.
func (s *AIJobService) ClearModuleRecords(moduleType string) error {
	if moduleType != AIJobTypeFace {
		return errors.New("only face analysis data can be cleared independently")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("AI job service is shutting down")
	}
	if hasActiveAIJobType(s.jobs, moduleType) {
		return ErrAIJobActive
	}
	moduleDir := filepath.Join(s.metadataDir, moduleType)
	if err := os.RemoveAll(moduleDir); err != nil {
		return err
	}
	for key, record := range s.records {
		if record.Type == moduleType {
			delete(s.records, key)
		}
	}
	s.recordsRevision++
	keptOrder := s.order[:0]
	for _, id := range s.order {
		if job := s.jobs[id]; job != nil && job.Type == moduleType {
			delete(s.jobs, id)
			continue
		}
		keptOrder = append(keptOrder, id)
	}
	s.order = keptOrder
	if err := s.persistLocked(); err != nil {
		return err
	}
	if s.onRecordsCleared != nil {
		s.onRecordsCleared()
	}
	return nil
}

func hasActiveAIJobType(jobs map[string]*AIJob, moduleType string) bool {
	for _, job := range jobs {
		if job != nil && job.Type == moduleType && isAIJobActive(job.Status) {
			return true
		}
	}
	return false
}

func withoutModule(modules []string, excluded string) []string {
	result := make([]string, 0, len(modules))
	for _, module := range modules {
		if module != excluded {
			result = append(result, module)
		}
	}
	return result
}

func (s *AIJobService) normalizeDailyModulesLocked(modules []string, enabled bool) ([]string, error) {
	if len(modules) == 0 {
		if enabled {
			return nil, errors.New("at least one installed analysis module is required")
		}
		return []string{}, nil
	}
	selected := make(map[string]struct{}, len(modules))
	for _, moduleType := range modules {
		if !validAIJobType(moduleType) {
			return nil, fmt.Errorf("unknown analysis module %q", moduleType)
		}
		analyzer, installed := s.analyzers[moduleType]
		if !installed || !aiAnalyzerAvailable(analyzer) {
			return nil, fmt.Errorf("analysis module %q is not installed", moduleType)
		}
		selected[moduleType] = struct{}{}
	}
	ordered := make([]string, 0, len(selected))
	for _, moduleType := range []string{AIJobTypeMetadata, AIJobTypeEmbedding, AIJobTypeOCR, AIJobTypeFace} {
		if _, exists := selected[moduleType]; exists {
			ordered = append(ordered, moduleType)
		}
	}
	return ordered, nil
}

func (s *AIJobService) copySettingsLocked() AIJobSettings {
	settings := s.settings
	settings.DailyModules = append([]string{}, s.settings.DailyModules...)
	return settings
}

// Subscribe 为单个客户端创建独立缓冲订阅，并立即发送任务快照。
func (s *AIJobService) Subscribe(id string) (<-chan AIJob, func(), bool) {
	s.mu.Lock()
	job := s.jobs[id]
	if job == nil {
		s.mu.Unlock()
		return nil, func() {}, false
	}
	channel := make(chan AIJob, 8)
	channel <- s.snapshotLocked(job)
	if isAIJobActive(job.Status) {
		if s.subs[id] == nil {
			s.subs[id] = make(map[chan AIJob]struct{})
		}
		s.subs[id][channel] = struct{}{}
	} else {
		close(channel)
	}
	s.mu.Unlock()

	unsubscribe := func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if subscribers := s.subs[id]; subscribers != nil {
			if _, exists := subscribers[channel]; exists {
				delete(subscribers, channel)
				close(channel)
			}
			if len(subscribers) == 0 {
				delete(s.subs, id)
			}
		}
	}
	return channel, unsubscribe, true
}

// RecordsRevision 返回当前分析结果的版本号。
//
// 每次记录增删改都会递增它，派生数据据此判断自己的缓存是否过期。
func (s *AIJobService) RecordsRevision() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.recordsRevision
}

// Records 返回指定模块的结果副本，便于 handler 按当前资源快照过滤过期记录。
func (s *AIJobService) Records(moduleType string) []AIAnalysisRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]AIAnalysisRecord, 0)
	analyzer, installed := s.analyzers[moduleType]
	if !installed {
		return result
	}
	for _, record := range s.records {
		if record.Type == moduleType && record.ModuleVersion == analyzer.Version() {
			record.Data = append(json.RawMessage(nil), record.Data...)
			result = append(result, record)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ResourceID < result[j].ResourceID })
	return result
}

// Record 返回一个资源在指定模块中的当前分析结果。
func (s *AIJobService) Record(moduleType, resourceID string) (AIAnalysisRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.analyzers[moduleType]; !exists {
		return AIAnalysisRecord{}, false
	}
	record, exists := s.records[aiRecordKey(moduleType, resourceID)]
	if !exists || record.ModuleVersion != s.analyzers[moduleType].Version() {
		return AIAnalysisRecord{}, false
	}
	record.Data = append(json.RawMessage(nil), record.Data...)
	return record, true
}

// StartPending 恢复启动时持久化的 pending 任务；调用时应已加载扫描快照。
func (s *AIJobService) StartPending() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.activeID != "" {
		return
	}
	queue := s.queue
	if len(queue) == 0 {
		for _, id := range s.order {
			if job := s.jobs[id]; job != nil && job.Status == AIJobStatusPending {
				s.queue = append(s.queue, id)
			}
		}
		queue = s.queue
	}
	if len(queue) == 0 {
		return
	}
	id := queue[0]
	job := s.jobs[id]
	if job == nil || job.Status != AIJobStatusPending {
		s.queue = slices.Delete(s.queue, 0, 1)
		_ = s.persistLocked()
		return
	}
	previousQueue := append([]string(nil), s.queue...)
	s.queue = slices.Delete(s.queue, 0, 1)
	s.activeID = id
	if err := s.persistLocked(); err != nil {
		s.queue = previousQueue
		s.activeID = ""
		return
	}
	s.launchLocked(id)
}

// StartScheduler 启动本地时钟调度器；服务关闭或 context 取消时退出。
func (s *AIJobService) StartScheduler(ctx context.Context) {
	s.mu.Lock()
	if s.closed || s.stopSchedule != nil {
		s.mu.Unlock()
		return
	}
	schedulerCtx, cancel := context.WithCancel(ctx)
	s.stopSchedule = cancel
	s.wg.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.wg.Done()
		s.scheduleTick(s.now())
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-schedulerCtx.Done():
				return
			case <-ticker.C:
				s.scheduleTick(s.now())
			}
		}
	}()
}

// Shutdown 停止调度并让当前批次以 pending 检查点退出，供下次启动续跑。
func (s *AIJobService) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	s.closed = true
	if s.stopSchedule != nil {
		s.stopSchedule()
	}
	for id, runtimeState := range s.runtimes {
		if job := s.jobs[id]; job != nil && job.Status == AIJobStatusPaused {
			runtimeState.stopReason = "shutdown_paused"
		} else {
			runtimeState.stopReason = "shutdown"
		}
		runtimeState.cancel()
	}
	if err := s.persistLocked(); err != nil {
		s.mu.Unlock()
		return err
	}
	s.mu.Unlock()

	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		s.closeAnalyzers()
		return nil
	case <-ctx.Done():
		s.closeAnalyzers()
		return ctx.Err()
	}
}

func (s *AIJobService) closeAnalyzers() {
	s.closeOnce.Do(func() {
		for _, analyzer := range s.analyzers {
			if closer, ok := analyzer.(AIAnalyzerCloser); ok {
				_ = closer.Close()
			}
		}
	})
}

func (s *AIJobService) newJobLocked(moduleType, mode string) AIJob {
	now := s.now()
	version := s.analyzers[moduleType].Version()
	computeDevice := "cpu"
	if moduleType != AIJobTypeMetadata && s.settings.GPUEnabled {
		computeDevice = "gpu"
	}
	return AIJob{
		ID:            uuid.NewString(),
		Type:          moduleType,
		Mode:          mode,
		ComputeDevice: computeDevice,
		Status:        AIJobStatusPending,
		Stage:         "pending",
		ModuleVersion: version,
		CreatedAt:     now,
		UpdatedAt:     now,
		Checkpoint:    AIJobCheckpoint{ModuleVersion: version},
	}
}

func (s *AIJobService) launchLocked(id string) {
	if s.closed || s.runtimes[id] != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	runtimeState := &aiJobRuntime{ctx: ctx, cancel: cancel, resume: make(chan struct{}, 1)}
	s.runtimes[id] = runtimeState
	s.wg.Add(1)
	go s.run(id, runtimeState)
}

func (s *AIJobService) run(id string, runtimeState *aiJobRuntime) {
	defer s.wg.Done()
	defer func() {
		runtimeState.cancel()
		s.mu.Lock()
		delete(s.runtimes, id)
		job := s.jobs[id]
		if s.activeID == id && (job == nil || !isAIJobActive(job.Status)) {
			s.activeID = ""
		}
		s.mu.Unlock()
		s.StartPending()
	}()

	s.mu.Lock()
	job := s.jobs[id]
	if job == nil {
		s.mu.Unlock()
		return
	}
	analyzer := s.analyzers[job.Type]
	computeDevice := job.ComputeDevice
	now := s.now()
	job.Status = AIJobStatusRunning
	job.Stage = "waiting_for_library"
	if job.StartedAt == nil {
		job.StartedAt = &now
	}
	job.UpdatedAt = now
	if err := s.persistLocked(); err != nil {
		job.Status = AIJobStatusFailed
		job.Stage = "failed"
		job.Error = "任务状态未能持久化"
		finished := s.now()
		job.FinishedAt = &finished
		s.publishLocked(*job)
		s.mu.Unlock()
		return
	}
	s.publishLocked(*job)
	s.mu.Unlock()

	if computeDevice == "gpu" {
		validator, ok := analyzer.(AIAnalyzerHardware)
		if !ok {
			s.failGPUJob(id, "gpu_backend_unsupported", "此分析模块没有可用的 GPU 推理实现")
			return
		}
		if err := validator.ValidateHardware(runtimeState.ctx, computeDevice); err != nil {
			code, message := analysisFailure(err, analyzer.Type())
			log.Printf("AI job failed: type=%s code=%s", analyzer.Type(), code)
			s.failGPUJob(id, code, message)
			return
		}
	}

	snapshot, err := s.waitForCatalog(runtimeState.ctx)
	if err != nil {
		s.finishInterrupted(id, runtimeState, err)
		return
	}
	targets := s.buildTargets(runtimeState.ctx, snapshot)
	digest := digestAITargets(targets)
	candidates, err := s.selectTargets(id, targets, digest)
	if err != nil {
		s.finishJob(id, AIJobStatusFailed, "failed", "任务检查点未能持久化")
		return
	}
	if len(candidates) == 0 {
		s.mu.Lock()
		failed := s.jobs[id] != nil && s.jobs[id].Failed > 0
		s.mu.Unlock()
		if failed {
			s.finishJob(id, AIJobStatusFailed, "failed", "部分图片分析失败，可重试失败项")
		} else {
			s.finishJob(id, AIJobStatusCompleted, "completed", "")
		}
		return
	}

	for start := 0; start < len(candidates); start += AIBatchSize {
		if runtimeState.ctx.Err() != nil {
			s.finishInterrupted(id, runtimeState, runtimeState.ctx.Err())
			return
		}
		if s.pauseAtBoundary(id, runtimeState) {
			if runtimeState.ctx.Err() != nil {
				s.finishInterrupted(id, runtimeState, runtimeState.ctx.Err())
				return
			}
		}
		end := min(start+AIBatchSize, len(candidates))
		batch := candidates[start:end]
		records := s.processBatch(runtimeState.ctx, id, batch)
		if runtimeState.ctx.Err() != nil {
			s.finishInterrupted(id, runtimeState, runtimeState.ctx.Err())
			return
		}
		if err := s.commitBatch(id, runtimeState, batch, records, digest); err != nil {
			s.finishJob(id, AIJobStatusFailed, "failed", "分析结果未能持久化")
			return
		}
	}

	s.mu.Lock()
	job = s.jobs[id]
	failed := job != nil && job.Failed > 0
	s.mu.Unlock()
	if failed {
		s.finishJob(id, AIJobStatusFailed, "failed", "部分图片分析失败，可重试失败项")
	} else {
		s.finishJob(id, AIJobStatusCompleted, "completed", "")
	}
}

func (s *AIJobService) waitForCatalog(ctx context.Context) (CatalogSnapshot, error) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		snapshot := s.catalog.Acquire()
		if snapshot.Ready() {
			return snapshot, nil
		}
		select {
		case <-ctx.Done():
			return CatalogSnapshot{}, ctx.Err()
		case <-ticker.C:
		}
	}
}

func (s *AIJobService) buildTargets(ctx context.Context, snapshot CatalogSnapshot) []aiJobTarget {
	ids := snapshot.FileIDs()
	targets := make([]aiJobTarget, 0, len(ids))
	for _, id := range ids {
		ref, ok := snapshot.Lookup(id)
		if !ok || !models.IsImageFile(ref.AbsolutePath) {
			continue
		}
		targets = append(targets, aiJobTarget{
			resourceID:  id,
			path:        ref.AbsolutePath,
			displayPath: snapshot.RelativeLabel(id),
			position:    len(targets),
		})
	}
	s.statTargets(ctx, targets)
	return targets
}

// statTargets 并发补齐每个目标的路径校验、大小与纳秒修改时间。
//
// 逐张 stat 在大库上是秒级开销，而空闲时的规模预估与任务启动都要走这一步。
// 结果写进按下标分配的切片，顺序与资源 ID 排序保持一致 —— position 与
// 检查点都依赖这个顺序。
func (s *AIJobService) statTargets(ctx context.Context, targets []aiJobTarget) {
	if len(targets) == 0 {
		return
	}
	workers := min(aiStatWorkerCount, len(targets))
	var next atomic.Int64
	var wg sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				index := int(next.Add(1)) - 1
				if index >= len(targets) {
					return
				}
				if ctx.Err() != nil {
					return
				}
				s.statTarget(&targets[index])
			}
		}()
	}
	wg.Wait()
}

// statTarget 校验单个目标的路径并记下当前的文件指纹。
func (s *AIJobService) statTarget(target *aiJobTarget) {
	validated, err := s.validatePath(target.path)
	if err != nil {
		target.statCode = "source_unavailable"
		return
	}
	info, err := os.Stat(validated)
	if err != nil || !info.Mode().IsRegular() {
		target.statCode = "source_unavailable"
		return
	}
	target.path = validated
	target.size = info.Size()
	target.mtimeNs = info.ModTime().UnixNano()
}

// aiRecordIsCurrent 判断既有结果对某个目标文件是否仍然有效。
//
// 增量任务跳过与否、空闲时的规模预估，用的是同一条判据 —— 只有一份实现，
// 预估出来的张数才与任务实际的 planned 对得上。
func aiRecordIsCurrent(record AIAnalysisRecord, exists bool, target aiJobTarget, version string, validator AIAnalyzerRecordValidator) bool {
	if !exists || record.Status == "failed" {
		return false
	}
	if record.Size != target.size || record.MTimeNs != target.mtimeNs {
		return false
	}
	if record.ModuleVersion != version {
		return false
	}
	if validator != nil {
		return validator.RecordCurrent(record)
	}
	return true
}

func (s *AIJobService) selectTargets(jobID string, targets []aiJobTarget, digest string) ([]aiJobTarget, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job := s.jobs[jobID]
	if job == nil {
		return nil, errors.New("analysis job not found")
	}
	version := s.analyzers[job.Type].Version()
	if job.ModuleVersion != version || job.Checkpoint.ModuleVersion != "" && job.Checkpoint.ModuleVersion != version {
		job.ModuleVersion = version
		job.Checkpoint = AIJobCheckpoint{ModuleVersion: version}
		job.Total, job.Processed, job.Skipped, job.Failed, job.Done = 0, 0, 0, 0, 0
		job.Errors = nil
		job.Results, job.Fields = nil, nil
	}
	job.ModuleVersion = version
	job.Checkpoint.ModuleVersion = version

	candidates := make([]aiJobTarget, 0, len(targets))
	if job.Mode == AIJobModeFull && !job.RetryFailedOnly {
		if job.Total > 0 && job.Checkpoint.TargetDigest == digest {
			for _, target := range targets {
				if target.position >= job.Checkpoint.Offset {
					candidates = append(candidates, target)
				}
			}
		} else {
			job.Total = len(targets)
			job.Processed, job.Skipped, job.Failed, job.Done = 0, 0, 0, 0
			job.Checkpoint = AIJobCheckpoint{ModuleVersion: version, TargetDigest: digest}
			job.Errors = nil
			job.Results, job.Fields = nil, nil
			candidates = append(candidates, targets...)
		}
	} else {
		if job.Total == 0 {
			job.Total = len(targets)
		}
		validator, _ := s.analyzers[job.Type].(AIAnalyzerRecordValidator)
		for _, target := range targets {
			record, exists := s.records[aiRecordKey(job.Type, target.resourceID)]
			current := aiRecordIsCurrent(record, exists, target, version, validator)
			if job.RetryFailedOnly {
				if (exists && record.Status == "failed") || (target.position >= job.RetryFromOffset && !current) {
					candidates = append(candidates, target)
				}
				continue
			}
			if current {
				continue
			}
			candidates = append(candidates, target)
		}
		if job.Done == 0 {
			job.Skipped = len(targets) - len(candidates)
			job.Done = job.Skipped
		}
	}
	job.Stage = job.Type
	job.UpdatedAt = s.now()
	if err := s.persistLocked(); err != nil {
		return nil, err
	}
	s.publishLocked(*job)
	return candidates, nil
}

func (s *AIJobService) processBatch(ctx context.Context, jobID string, targets []aiJobTarget) []AIAnalysisRecord {
	s.mu.Lock()
	job := s.jobs[jobID]
	var analyzer AIAnalyzer
	computeDevice := "cpu"
	if job != nil {
		analyzer = s.analyzers[job.Type]
		computeDevice = job.ComputeDevice
	}
	s.mu.Unlock()
	if batchAnalyzer, ok := analyzer.(AIAnalyzerBatch); ok {
		return s.processAnalyzerBatch(ctx, analyzer, batchAnalyzer, computeDevice, targets)
	}
	results := make([]AIAnalysisRecord, len(targets))
	workers := min(s.workerCount, len(targets))
	if workerLimit, ok := analyzer.(AIAnalyzerWorkerLimit); ok && workerLimit.MaxWorkers() > 0 {
		workers = min(workers, workerLimit.MaxWorkers())
	}
	queue := make(chan int)
	var workersDone sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		workersDone.Add(1)
		go func() {
			defer workersDone.Done()
			for index := range queue {
				results[index] = s.processTarget(ctx, jobID, targets[index])
			}
		}()
	}

sendLoop:
	for index := range targets {
		select {
		case <-ctx.Done():
			break sendLoop
		case queue <- index:
		}
	}
	close(queue)
	workersDone.Wait()
	return results
}

func (s *AIJobService) processAnalyzerBatch(ctx context.Context, analyzer AIAnalyzer, batchAnalyzer AIAnalyzerBatch, computeDevice string, targets []aiJobTarget) []AIAnalysisRecord {
	version := analyzer.Version()
	results := make([]AIAnalysisRecord, len(targets))
	inputs := make([]AIAnalysisInput, 0, len(targets))
	inputPositions := make([]int, 0, len(targets))
	for index, target := range targets {
		results[index] = AIAnalysisRecord{
			Type: analyzer.Type(), ResourceID: target.resourceID, Size: target.size,
			MTimeNs: target.mtimeNs, ModuleVersion: version, UpdatedAt: s.now(),
		}
		if err := ctx.Err(); err != nil {
			continue
		}
		if target.statCode != "" {
			results[index] = failedAIRecord(results[index], "source_unavailable", "无法读取图片或路径校验失败")
			continue
		}
		validated, err := s.validatePath(target.path)
		if err != nil {
			results[index] = failedAIRecord(results[index], "source_unavailable", "无法读取图片或路径校验失败")
			continue
		}
		info, err := os.Stat(validated)
		if err != nil || !info.Mode().IsRegular() || info.Size() != target.size || info.ModTime().UnixNano() != target.mtimeNs {
			results[index] = failedAIRecord(results[index], "source_changed", "分析期间图片已发生变化")
			continue
		}
		inputs = append(inputs, AIAnalysisInput{ResourceID: target.resourceID, Path: validated, Size: target.size, MTimeNs: target.mtimeNs, ComputeDevice: computeDevice})
		inputPositions = append(inputPositions, index)
	}
	if len(inputs) == 0 || ctx.Err() != nil {
		return results
	}
	outputs, err := batchAnalyzer.AnalyzeBatch(ctx, inputs)
	if err != nil || len(outputs) != len(inputs) {
		code, message := analysisFailure(err, analyzer.Type())
		for _, index := range inputPositions {
			results[index] = failedAIRecord(results[index], code, message)
		}
		return results
	}
	for inputIndex, output := range outputs {
		position := inputPositions[inputIndex]
		if err := ctx.Err(); err != nil {
			continue
		}
		info, statErr := os.Stat(inputs[inputIndex].Path)
		if statErr != nil || !info.Mode().IsRegular() || info.Size() != inputs[inputIndex].Size || info.ModTime().UnixNano() != inputs[inputIndex].MTimeNs {
			results[position] = failedAIRecord(results[position], "source_changed", "分析期间图片已发生变化")
			continue
		}
		if output.Status == "failed" {
			code, message := output.ErrorCode, output.ErrorMessage
			if code == "" {
				code, message = "analysis_failed", analysisFailureMessage(analyzer.Type())
			}
			results[position] = failedAIRecord(results[position], code, message)
			continue
		}
		if output.Status == "" {
			output.Status = "processed"
		}
		results[position].Status = output.Status
		results[position].Data = append(json.RawMessage(nil), output.Data...)
		results[position].Fields = append([]string(nil), output.Fields...)
	}
	return results
}

func (s *AIJobService) processTarget(ctx context.Context, jobID string, target aiJobTarget) AIAnalysisRecord {
	s.mu.Lock()
	job := s.jobs[jobID]
	if job == nil {
		s.mu.Unlock()
		return AIAnalysisRecord{}
	}
	typeName := job.Type
	version := s.analyzers[typeName].Version()
	s.mu.Unlock()
	record := AIAnalysisRecord{
		Type:          typeName,
		ResourceID:    target.resourceID,
		Size:          target.size,
		MTimeNs:       target.mtimeNs,
		ModuleVersion: version,
		UpdatedAt:     s.now(),
	}
	if err := ctx.Err(); err != nil {
		return record
	}
	if target.statCode != "" {
		return failedAIRecord(record, "source_unavailable", "无法读取图片或路径校验失败")
	}
	validated, err := s.validatePath(target.path)
	if err != nil {
		return failedAIRecord(record, "source_unavailable", "无法读取图片或路径校验失败")
	}
	file, err := os.Open(validated)
	if err != nil {
		return failedAIRecord(record, "source_unavailable", "无法读取图片或路径校验失败")
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil || !before.Mode().IsRegular() || before.Size() != target.size || before.ModTime().UnixNano() != target.mtimeNs {
		return failedAIRecord(record, "source_changed", "分析期间图片已发生变化")
	}
	output, err := s.analyzers[typeName].Analyze(ctx, file)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return record
		}
		return failedAIRecord(record, "analysis_failed", analysisFailureMessage(typeName))
	}
	after, err := file.Stat()
	if err != nil || after.Size() != target.size || after.ModTime().UnixNano() != target.mtimeNs {
		return failedAIRecord(record, "source_changed", "分析期间图片已发生变化")
	}
	if output.Status == "" {
		output.Status = "processed"
	}
	record.Status = output.Status
	record.Data = append(json.RawMessage(nil), output.Data...)
	record.Fields = append([]string(nil), output.Fields...)
	return record
}

func failedAIRecord(record AIAnalysisRecord, code, message string) AIAnalysisRecord {
	record.Status = "failed"
	record.ErrorCode = code
	record.ErrorMessage = message
	return record
}

func analysisFailureMessage(moduleType string) string {
	switch moduleType {
	case AIJobTypeMetadata:
		return "EXIF 数据损坏或无法解析"
	default:
		return "分析模块处理失败"
	}
}

func analysisFailure(err error, moduleType string) (string, string) {
	if errors.Is(err, ErrAIGPUUnavailable) {
		return "gpu_unavailable", "未检测到可用的 NVIDIA CUDA 推理环境；已按 GPU 强制模式停止任务"
	}
	if errors.Is(err, ErrAIGPUInferenceFailed) {
		return "gpu_inference_failed", "GPU 推理失败；已按 GPU 强制模式停止任务"
	}
	return "analysis_failed", analysisFailureMessage(moduleType)
}

func (s *AIJobService) commitBatch(jobID string, runtimeState *aiJobRuntime, targets []aiJobTarget, records []AIAnalysisRecord, digest string) error {
	if runtimeState.ctx.Err() != nil {
		return runtimeState.ctx.Err()
	}
	s.mu.Lock()
	job := s.jobs[jobID]
	if job == nil {
		s.mu.Unlock()
		return errors.New("analysis job not found")
	}
	batchNumber := job.Checkpoint.Batch + 1
	s.mu.Unlock()

	lastIndex := len(records) - 1
	batchFile := aiJobBatch{
		JobID:          jobID,
		Number:         batchNumber,
		Offset:         targets[lastIndex].position + 1,
		LastResourceID: records[lastIndex].ResourceID,
		TargetDigest:   digest,
		Records:        records,
	}
	path := filepath.Join(s.metadataDir, records[0].Type, "batches", jobID, fmt.Sprintf("%08d.json", batchNumber))
	if err := writeAIJSONAtomic(path, batchFile); err != nil {
		return err
	}

	s.mu.Lock()
	job = s.jobs[jobID]
	if job == nil {
		s.mu.Unlock()
		return errors.New("analysis job not found")
	}
	for index, record := range records {
		if record.ResourceID == "" {
			continue
		}
		s.records[aiRecordKey(record.Type, record.ResourceID)] = record
		s.recordsRevision++
		if record.Status == "failed" {
			job.Failed++
			job.Errors = append(job.Errors, AIJobError{
				ResourceID: record.ResourceID,
				Path:       targets[index].displayPath,
				Code:       record.ErrorCode,
				Message:    record.ErrorMessage,
				At:         record.UpdatedAt,
			})
		} else {
			job.Processed++
		}
		accumulateAIJobOutput(job, record)
		job.Done++
		job.CurrentResourceID = record.ResourceID
		job.Checkpoint.Offset = targets[index].position + 1
		job.Checkpoint.LastResourceID = record.ResourceID
	}
	job.Checkpoint.Batch = batchNumber
	job.Checkpoint.TargetDigest = digest
	job.Checkpoint.ModuleVersion = job.ModuleVersion
	job.UpdatedAt = s.now()
	job.Stage = job.Type
	if err := s.persistLocked(); err != nil {
		s.mu.Unlock()
		return err
	}
	s.publishLocked(*job)
	onRecordsCommitted := s.onRecordsCommitted
	s.mu.Unlock()
	if onRecordsCommitted != nil {
		committed := make([]AIAnalysisRecord, len(records))
		for index, record := range records {
			record.Data = append(json.RawMessage(nil), record.Data...)
			record.Fields = append([]string(nil), record.Fields...)
			committed[index] = record
		}
		onRecordsCommitted(committed)
	}
	return nil
}

func (s *AIJobService) pauseAtBoundary(id string, runtimeState *aiJobRuntime) bool {
	s.mu.Lock()
	if !runtimeState.pauseRequested || runtimeState.ctx.Err() != nil {
		s.mu.Unlock()
		return false
	}
	job := s.jobs[id]
	if job == nil {
		s.mu.Unlock()
		return false
	}
	previousStatus, previousStage, previousUpdated := job.Status, job.Stage, job.UpdatedAt
	job.Status = AIJobStatusPaused
	job.Stage = "paused"
	job.UpdatedAt = s.now()
	if err := s.persistLocked(); err != nil {
		runtimeState.pauseRequested = false
		job.Status, job.Stage, job.UpdatedAt = previousStatus, previousStage, previousUpdated
		s.mu.Unlock()
		return false
	}
	s.publishLocked(*job)
	s.mu.Unlock()

	select {
	case <-runtimeState.ctx.Done():
		return true
	case <-runtimeState.resume:
		return true
	}
}

func (s *AIJobService) finishInterrupted(id string, runtimeState *aiJobRuntime, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job := s.jobs[id]
	if job == nil {
		return
	}
	if runtimeState.stopReason == "shutdown" {
		job.Status = AIJobStatusPending
		job.Stage = "pending"
		job.Error = ""
	} else if runtimeState.stopReason == "shutdown_paused" {
		job.Status = AIJobStatusPaused
		job.Stage = "paused"
		job.Error = ""
	} else if runtimeState.stopReason == "user" || errors.Is(err, context.Canceled) {
		job.Status = AIJobStatusCancelled
		job.Stage = "cancelled"
		job.Error = ""
		finished := s.now()
		job.FinishedAt = &finished
	} else {
		job.Status = AIJobStatusFailed
		job.Stage = "failed"
		job.Error = "后台任务已中断"
		finished := s.now()
		job.FinishedAt = &finished
	}
	job.UpdatedAt = s.now()
	if !isAIJobActive(job.Status) && s.activeID == id {
		s.activeID = ""
	}
	_ = s.persistLocked()
	s.publishLocked(*job)
}

func (s *AIJobService) finishJob(id, status, stage, message string) {
	s.finishJobWithCode(id, status, stage, "", message)
}

func (s *AIJobService) failGPUJob(id, code, message string) {
	s.finishJobWithCode(id, AIJobStatusFailed, "failed", code, message)
}

func (s *AIJobService) finishJobWithCode(id, status, stage, errorCode, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job := s.jobs[id]
	if job == nil {
		return
	}
	job.Status = status
	job.Stage = stage
	job.Error = message
	job.ErrorCode = errorCode
	finished := s.now()
	job.FinishedAt = &finished
	job.UpdatedAt = finished
	if s.activeID == id {
		s.activeID = ""
	}
	if err := s.persistLocked(); err != nil {
		job.Status = AIJobStatusFailed
		job.Stage = "failed"
		job.Error = "任务状态未能持久化"
		job.ErrorCode = "job_state_persist_failed"
		job.FinishedAt = &finished
		_ = s.persistLocked()
	}
	s.publishLocked(*job)
}

func (s *AIJobService) scheduleTick(now time.Time) {
	s.mu.Lock()
	if s.closed || s.hasPendingJobsLocked() || !dailyScheduleDue(s.settings, now) {
		s.mu.Unlock()
		return
	}
	modules := append([]string(nil), s.settings.DailyModules...)
	analyzers := make(map[string]AIAnalyzer, len(modules))
	for _, moduleType := range modules {
		analyzers[moduleType] = s.analyzers[moduleType]
	}
	s.mu.Unlock()

	readyModules := make([]string, 0, len(modules))
	for _, moduleType := range modules {
		analyzer := analyzers[moduleType]
		if analyzer == nil {
			continue
		}
		if readiness, ok := analyzer.(AIAnalyzerReadiness); ok {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			err := readiness.Ready(ctx)
			cancel()
			if err != nil {
				continue
			}
		}
		readyModules = append(readyModules, moduleType)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.hasPendingJobsLocked() || !dailyScheduleDue(s.settings, now) || !slices.Equal(s.settings.DailyModules, modules) {
		return
	}
	today := now.In(time.Local).Format("2006-01-02")
	previousDate := s.settings.LastScheduledDate
	previousOrderLength := len(s.order)
	previousQueue := append([]string(nil), s.queue...)
	created := make([]string, 0, len(readyModules))
	for _, moduleType := range readyModules {
		if _, installed := s.analyzers[moduleType]; !installed {
			continue
		}
		job := s.newJobLocked(moduleType, AIJobModeIncremental)
		job.Scheduled = true
		s.jobs[job.ID] = &job
		s.order = append(s.order, job.ID)
		created = append(created, job.ID)
	}
	if len(created) > 1 {
		s.queue = append(s.queue, created[1:]...)
	}
	s.settings.LastScheduledDate = today
	if err := s.persistLocked(); err != nil {
		s.settings.LastScheduledDate = previousDate
		for _, id := range created {
			delete(s.jobs, id)
		}
		s.order = s.order[:previousOrderLength]
		s.queue = previousQueue
		return
	}
	if len(created) > 0 {
		s.activeID = created[0]
		s.launchLocked(created[0])
	}
}

func dailyScheduleDue(settings AIJobSettings, now time.Time) bool {
	if !settings.DailyEnabled {
		return false
	}
	now = now.In(time.Local)
	today := now.Format("2006-01-02")
	if settings.LastScheduledDate == today {
		return false
	}
	scheduledToday, err := time.ParseInLocation("2006-01-02 15:04", today+" "+settings.DailyTime, time.Local)
	if err != nil {
		return false
	}
	missedPreviousDay := false
	if settings.LastScheduledDate != "" {
		lastDate, parseErr := time.ParseInLocation("2006-01-02", settings.LastScheduledDate, time.Local)
		if parseErr == nil {
			yesterday := time.Date(now.Year(), now.Month(), now.Day()-1, 0, 0, 0, 0, time.Local)
			missedPreviousDay = lastDate.Before(yesterday)
		}
	}
	return !now.Before(scheduledToday) || missedPreviousDay
}

func (s *AIJobService) snapshotLocked(job *AIJob) AIJob {
	copy := *job
	copy.Errors = append([]AIJobError(nil), job.Errors...)
	copy.Results = copyAIJobCounts(job.Results)
	copy.Fields = copyAIJobCounts(job.Fields)
	catalogSnapshot := s.catalog.Acquire()
	for index := range copy.Errors {
		copy.Errors[index].Path = catalogSnapshot.RelativeLabel(copy.Errors[index].ResourceID)
	}
	// Planned 是本次任务真正要处理的张数：增量任务的 total 是整库规模，
	// 拿 total 当分母会让进度一上来就接近满格。
	copy.Planned = max(0, job.Total-job.Skipped)
	copy.Completed = job.Processed + job.Failed
	copy.ElapsedMs = 0
	copy.SpeedPerSecond = 0
	copy.EstimatedRemainingMs = 0
	if job.StartedAt != nil {
		end := s.now()
		if job.FinishedAt != nil {
			end = *job.FinishedAt
		}
		copy.ElapsedMs = max(0, end.Sub(*job.StartedAt).Milliseconds())
		if copy.ElapsedMs > 0 {
			copy.SpeedPerSecond = float64(copy.Completed) * 1000 / float64(copy.ElapsedMs)
		}
	}
	// 预计剩余只在运行时给出：暂停时耗时仍在增长，速度已经失真。
	if job.Status == AIJobStatusRunning && copy.ElapsedMs > 0 && copy.Completed > 0 {
		if remaining := copy.Planned - copy.Completed; remaining > 0 {
			copy.EstimatedRemainingMs = int64(remaining) * copy.ElapsedMs / int64(copy.Completed)
		}
	}
	return copy
}

// copyAIJobCounts 复制计数表，避免调用方改到任务自身的状态。
func copyAIJobCounts(counts map[string]int) map[string]int {
	if len(counts) == 0 {
		return nil
	}
	result := make(map[string]int, len(counts))
	for key, value := range counts {
		result[key] = value
	}
	return result
}

// accumulateAIJobOutput 累计一条分析结果：按解析状态与字段统计产出。
func accumulateAIJobOutput(job *AIJob, record AIAnalysisRecord) {
	if record.Status != "" {
		if job.Results == nil {
			job.Results = make(map[string]int)
		}
		job.Results[record.Status]++
	}
	for _, field := range record.Fields {
		if job.Fields == nil {
			job.Fields = make(map[string]int)
		}
		job.Fields[field]++
	}
}

func (s *AIJobService) publishLocked(job AIJob) {
	for channel := range s.subs[job.ID] {
		select {
		case channel <- s.snapshotLocked(&job):
		default:
			select {
			case <-channel:
			default:
			}
			select {
			case channel <- s.snapshotLocked(&job):
			default:
			}
		}
	}
	if !isAIJobActive(job.Status) {
		for channel := range s.subs[job.ID] {
			close(channel)
			delete(s.subs[job.ID], channel)
		}
		delete(s.subs, job.ID)
	}
}

func (s *AIJobService) loadState() error {
	data, err := os.ReadFile(s.statePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var state aiJobDiskState
	if err := json.Unmarshal(data, &state); err != nil {
		return fmt.Errorf("decode AI job state: %w", err)
	}
	if state.Version != aiJobStoreVersion {
		return fmt.Errorf("unsupported AI job state version %d", state.Version)
	}
	settingsChanged := false
	if state.Settings.DailyTime != "" {
		if _, err := time.Parse("15:04", state.Settings.DailyTime); err != nil {
			return errors.New("invalid daily analysis time in state")
		}
		s.settings = state.Settings
		if !state.Settings.gpuEnabledSet {
			s.settings.GPUEnabled = true
			s.settings.gpuEnabledSet = true
			settingsChanged = true
		}
	}
	if s.settings.DailyModules == nil {
		s.settings.DailyModules = []string{AIJobTypeMetadata}
	}
	if !s.settings.PeopleEnabled {
		modules := withoutModule(s.settings.DailyModules, AIJobTypeFace)
		if len(modules) != len(s.settings.DailyModules) {
			s.settings.DailyModules = modules
			settingsChanged = true
		}
	}
	for _, job := range state.Jobs {
		if job.ID == "" || !validAIJobType(job.Type) || (job.Mode != AIJobModeFull && job.Mode != AIJobModeIncremental) {
			continue
		}
		if job.ComputeDevice == "" || (job.ComputeDevice != "cpu" && job.ComputeDevice != "gpu") {
			job.ComputeDevice = "cpu"
			if job.Type != AIJobTypeMetadata && s.settings.GPUEnabled && isAIJobActive(job.Status) {
				job.ComputeDevice = "gpu"
			}
			settingsChanged = true
		}
		if job.Errors == nil {
			job.Errors = []AIJobError{}
		}
		copy := job
		s.jobs[job.ID] = &copy
		s.order = append(s.order, job.ID)
	}
	if state.Queue == nil {
		for _, id := range s.order {
			if job := s.jobs[id]; job != nil && job.Status == AIJobStatusPending {
				s.queue = append(s.queue, id)
			}
		}
	} else {
		seen := make(map[string]struct{}, len(state.Queue))
		for _, id := range state.Queue {
			job := s.jobs[id]
			if job == nil || job.Status != AIJobStatusPending {
				continue
			}
			if _, exists := seen[id]; exists {
				continue
			}
			seen[id] = struct{}{}
			s.queue = append(s.queue, id)
		}
		activePending := make([]string, 0, len(s.order))
		for _, id := range s.order {
			job := s.jobs[id]
			if job == nil || job.Status != AIJobStatusPending {
				continue
			}
			if _, exists := seen[id]; !exists {
				activePending = append(activePending, id)
			}
		}
		s.queue = append(activePending, s.queue...)
	}
	if settingsChanged {
		return s.persistLocked()
	}
	return nil
}

func (s *AIJobService) recoverInterruptedJobs() {
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	for _, id := range s.order {
		job := s.jobs[id]
		if job.Type == AIJobTypeFace && !s.settings.PeopleEnabled && isAIJobActive(job.Status) {
			job.Status = AIJobStatusCancelled
			job.Stage = string(AIJobStatusCancelled)
			job.Error = ErrPeopleAnalysisDisabled.Error()
			finished := s.now()
			job.FinishedAt = &finished
			job.CurrentResourceID = ""
			job.UpdatedAt = finished
			changed = true
			continue
		}
		if job.Status == AIJobStatusRunning {
			job.Status = AIJobStatusPending
			job.Stage = "pending"
			job.CurrentResourceID = ""
			job.UpdatedAt = s.now()
			s.queue = append([]string{id}, s.queue...)
			changed = true
		}
		if job.Status == AIJobStatusPaused && s.activeID == "" {
			s.activeID = id
		}
	}
	if changed {
		_ = s.persistLocked()
	}
}

func (s *AIJobService) loadRecords() error {
	reconciled := false
	err := filepath.WalkDir(s.metadataDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".json" || entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var batch aiJobBatch
		if err := json.Unmarshal(data, &batch); err != nil {
			return fmt.Errorf("decode metadata batch: %w", err)
		}
		for _, record := range batch.Records {
			if !validAIJobType(record.Type) || record.ResourceID == "" || record.ModuleVersion == "" {
				continue
			}
			key := aiRecordKey(record.Type, record.ResourceID)
			current, exists := s.records[key]
			if !exists || record.UpdatedAt.After(current.UpdatedAt) {
				s.records[key] = record
				s.recordsRevision++
			}
		}
		if job := s.jobs[batch.JobID]; job != nil && batch.Number > job.Checkpoint.Batch {
			for _, record := range batch.Records {
				if record.Status == "failed" {
					job.Failed++
					job.Errors = append(job.Errors, AIJobError{
						ResourceID: record.ResourceID,
						Code:       record.ErrorCode,
						Message:    record.ErrorMessage,
						At:         record.UpdatedAt,
					})
				} else {
					job.Processed++
				}
				accumulateAIJobOutput(job, record)
				job.Done++
			}
			job.Checkpoint.Batch = batch.Number
			job.Checkpoint.Offset = batch.Offset
			job.Checkpoint.LastResourceID = batch.LastResourceID
			job.Checkpoint.TargetDigest = batch.TargetDigest
			job.UpdatedAt = s.now()
			reconciled = true
		}
		return nil
	})
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if reconciled {
		return s.persistLocked()
	}
	return nil
}

func (s *AIJobService) persistLocked() error {
	state := aiJobDiskState{
		Version:  aiJobStoreVersion,
		Settings: s.settings,
		Queue:    append([]string(nil), s.queue...),
		Jobs:     make([]AIJob, 0, len(s.order)),
	}
	for _, id := range s.order {
		if job := s.jobs[id]; job != nil {
			copy := *job
			copy.ElapsedMs = 0
			copy.SpeedPerSecond = 0
			copy.Planned = 0
			copy.Completed = 0
			copy.EstimatedRemainingMs = 0
			state.Jobs = append(state.Jobs, copy)
		}
	}
	return writeAIJSONAtomic(s.statePath, state)
}

func writeAIJSONAtomic(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".ai-job-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	var renameErr error
	// Windows 实时扫描可能短暂占用目标文件；原子替换失败时做有限退避重试。
	for attempt := 0; attempt < 6; attempt++ {
		renameErr = os.Rename(temporaryPath, path)
		if renameErr == nil {
			return nil
		}
		if attempt < 5 {
			time.Sleep(time.Duration(10<<attempt) * time.Millisecond)
		}
	}
	return renameErr
}

func digestAITargets(targets []aiJobTarget) string {
	hashValue := sha256.New()
	for _, target := range targets {
		_, _ = fmt.Fprintf(hashValue, "%s\x00%d\x00%d\x00%s\n", target.resourceID, target.size, target.mtimeNs, target.statCode)
	}
	return hex.EncodeToString(hashValue.Sum(nil))
}

func aiWorkerCount() int {
	return min(aiMaxWorkers, max(1, runtime.NumCPU()/2))
}

func aiRecordKey(moduleType, resourceID string) string {
	return moduleType + "\x00" + resourceID
}

func isAIJobActive(status string) bool {
	return status == AIJobStatusPending || status == AIJobStatusRunning || status == AIJobStatusPaused
}

func validAIJobType(moduleType string) bool {
	switch moduleType {
	case AIJobTypeMetadata, AIJobTypeEmbedding, AIJobTypeOCR, AIJobTypeFace:
		return true
	default:
		return false
	}
}
