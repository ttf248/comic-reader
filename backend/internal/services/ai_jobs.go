package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
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
	AIFieldExifTime = "exifTime"
	AIFieldCamera   = "camera"
	AIFieldGPS      = "gps"

	aiJobStoreVersion = 1
	aiBatchSize       = 32
	aiMaxWorkers      = 4
)

var ErrAIJobActive = errors.New("an analysis job is already active")

// AIAnalysisOutput 是一个分析模块对单个媒体返回的可序列化结果。
type AIAnalysisOutput struct {
	Status string          `json:"status"`
	Data   json.RawMessage `json:"data,omitempty"`
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
	DailyEnabled      bool   `json:"dailyEnabled"`
	DailyTime         string `json:"dailyTime"`
	LastScheduledDate string `json:"lastScheduledDate,omitempty"`
}

type AIJobSnapshot struct {
	Jobs     []AIJob       `json:"jobs"`
	Active   *AIJob        `json:"active,omitempty"`
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
	StatePath    string
	MetadataDir  string
	Catalog      *ResourceCatalog
	ValidatePath func(string) (string, error)
	Analyzers    []AIAnalyzer
	WorkerCount  int
	Now          func() time.Time
}

type aiJobDiskState struct {
	Version  int           `json:"version"`
	Jobs     []AIJob       `json:"jobs"`
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
	mu           sync.Mutex
	statePath    string
	metadataDir  string
	catalog      *ResourceCatalog
	validatePath func(string) (string, error)
	analyzers    map[string]AIAnalyzer
	workerCount  int
	now          func() time.Time
	jobs         map[string]*AIJob
	order        []string
	records      map[string]AIAnalysisRecord
	runtimes     map[string]*aiJobRuntime
	subs         map[string]map[chan AIJob]struct{}
	activeID     string
	closed       bool
	settings     AIJobSettings
	stopSchedule context.CancelFunc
	wg           sync.WaitGroup
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
		statePath:    options.StatePath,
		metadataDir:  options.MetadataDir,
		catalog:      options.Catalog,
		validatePath: options.ValidatePath,
		analyzers:    make(map[string]AIAnalyzer, len(options.Analyzers)),
		workerCount:  options.WorkerCount,
		now:          options.Now,
		jobs:         make(map[string]*AIJob),
		records:      make(map[string]AIAnalysisRecord),
		runtimes:     make(map[string]*aiJobRuntime),
		subs:         make(map[string]map[chan AIJob]struct{}),
		settings:     AIJobSettings{DailyEnabled: true, DailyTime: "03:00"},
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

// Start 创建并启动全量或增量任务。metadata 是当前唯一已注册的分析模块。
func (s *AIJobService) Start(moduleType, mode string) (AIJob, bool, error) {
	if mode != AIJobModeFull && mode != AIJobModeIncremental {
		return AIJob{}, false, errors.New("unknown analysis mode")
	}
	if _, exists := s.analyzers[moduleType]; !exists {
		if validAIJobType(moduleType) {
			return AIJob{}, false, fmt.Errorf("analysis module %q is not installed", moduleType)
		}
		return AIJob{}, false, errors.New("unknown analysis module")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return AIJob{}, false, errors.New("AI job service is shutting down")
	}
	if s.activeID != "" {
		active := s.jobs[s.activeID]
		if active != nil && active.Type == moduleType && active.Mode == mode && isAIJobActive(active.Status) {
			return s.snapshotLocked(active), true, nil
		}
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
	defer s.mu.Unlock()
	job := s.jobs[id]
	runtimeState := s.runtimes[id]
	if job == nil || runtimeState == nil || !isAIJobActive(job.Status) {
		return false
	}
	runtimeState.stopReason = "user"
	runtimeState.cancel()
	return true
}

// Retry 从失败或取消任务创建新的历史项，只重试失败记录与未提交尾段。
func (s *AIJobService) Retry(id string) (AIJob, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return AIJob{}, errors.New("AI job service is shutting down")
	}
	if s.activeID != "" {
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
		Settings: s.settings,
		Jobs:     make([]AIJob, 0, len(s.order)),
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
			module.Installed = true
			module.Version = analyzer.Version()
		}
		modules = append(modules, module)
	}
	return modules
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
func (s *AIJobService) ConfigureDaily(enabled bool, dailyTime string) (AIJobSettings, error) {
	if _, err := time.Parse("15:04", dailyTime); err != nil {
		return AIJobSettings{}, errors.New("daily time must use HH:MM")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return AIJobSettings{}, errors.New("AI job service is shutting down")
	}
	previous := s.settings
	s.settings.DailyEnabled = enabled
	s.settings.DailyTime = dailyTime
	if err := s.persistLocked(); err != nil {
		s.settings = previous
		return AIJobSettings{}, err
	}
	return s.settings, nil
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
	for _, id := range s.order {
		job := s.jobs[id]
		if job != nil && job.Status == AIJobStatusPending {
			s.activeID = id
			s.launchLocked(id)
			return
		}
	}
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
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *AIJobService) newJobLocked(moduleType, mode string) AIJob {
	now := s.now()
	version := s.analyzers[moduleType].Version()
	return AIJob{
		ID:            uuid.NewString(),
		Type:          moduleType,
		Mode:          mode,
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

	snapshot, err := s.waitForCatalog(runtimeState.ctx)
	if err != nil {
		s.finishInterrupted(id, runtimeState, err)
		return
	}
	targets := s.buildTargets(snapshot)
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

	for start := 0; start < len(candidates); start += aiBatchSize {
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
		end := min(start+aiBatchSize, len(candidates))
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

func (s *AIJobService) buildTargets(snapshot CatalogSnapshot) []aiJobTarget {
	ids := snapshot.FileIDs()
	targets := make([]aiJobTarget, 0, len(ids))
	for _, id := range ids {
		ref, ok := snapshot.Lookup(id)
		if !ok || !models.IsImageFile(ref.AbsolutePath) {
			continue
		}
		target := aiJobTarget{
			resourceID:  id,
			path:        ref.AbsolutePath,
			displayPath: snapshot.RelativeLabel(id),
			position:    len(targets),
		}
		validated, err := s.validatePath(ref.AbsolutePath)
		if err != nil {
			target.statCode = "source_unavailable"
			targets = append(targets, target)
			continue
		}
		info, err := os.Stat(validated)
		if err != nil || !info.Mode().IsRegular() {
			target.statCode = "source_unavailable"
		} else {
			target.path = validated
			target.size = info.Size()
			target.mtimeNs = info.ModTime().UnixNano()
		}
		targets = append(targets, target)
	}
	return targets
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
		for _, target := range targets {
			record, exists := s.records[aiRecordKey(job.Type, target.resourceID)]
			current := exists && record.Size == target.size && record.MTimeNs == target.mtimeNs && record.ModuleVersion == version
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
	job.Stage = "metadata"
	job.UpdatedAt = s.now()
	if err := s.persistLocked(); err != nil {
		return nil, err
	}
	s.publishLocked(*job)
	return candidates, nil
}

func (s *AIJobService) processBatch(ctx context.Context, jobID string, targets []aiJobTarget) []AIAnalysisRecord {
	results := make([]AIAnalysisRecord, len(targets))
	workers := min(s.workerCount, len(targets))
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
	defer s.mu.Unlock()
	job = s.jobs[jobID]
	if job == nil {
		return errors.New("analysis job not found")
	}
	for index, record := range records {
		if record.ResourceID == "" {
			continue
		}
		s.records[aiRecordKey(record.Type, record.ResourceID)] = record
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
	job.Stage = "metadata"
	if err := s.persistLocked(); err != nil {
		return err
	}
	s.publishLocked(*job)
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
	s.mu.Lock()
	defer s.mu.Unlock()
	job := s.jobs[id]
	if job == nil {
		return
	}
	job.Status = status
	job.Stage = stage
	job.Error = message
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
		job.FinishedAt = &finished
		_ = s.persistLocked()
	}
	s.publishLocked(*job)
}

func (s *AIJobService) scheduleTick(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || !s.settings.DailyEnabled {
		return
	}
	now = now.In(time.Local)
	today := now.Format("2006-01-02")
	if s.settings.LastScheduledDate == today {
		return
	}
	scheduledToday, err := time.ParseInLocation("2006-01-02 15:04", today+" "+s.settings.DailyTime, time.Local)
	if err != nil {
		return
	}
	missedPreviousDay := false
	if s.settings.LastScheduledDate != "" {
		lastDate, parseErr := time.ParseInLocation("2006-01-02", s.settings.LastScheduledDate, time.Local)
		if parseErr == nil {
			yesterday := time.Date(now.Year(), now.Month(), now.Day()-1, 0, 0, 0, 0, time.Local)
			missedPreviousDay = lastDate.Before(yesterday)
		}
	}
	if now.Before(scheduledToday) && !missedPreviousDay {
		return
	}
	if s.activeID != "" {
		return
	}
	job := s.newJobLocked(AIJobTypeMetadata, AIJobModeIncremental)
	job.Scheduled = true
	s.jobs[job.ID] = &job
	s.order = append(s.order, job.ID)
	s.activeID = job.ID
	previousDate := s.settings.LastScheduledDate
	s.settings.LastScheduledDate = today
	if err := s.persistLocked(); err != nil {
		s.settings.LastScheduledDate = previousDate
		delete(s.jobs, job.ID)
		s.order = s.order[:len(s.order)-1]
		s.activeID = ""
		return
	}
	s.launchLocked(job.ID)
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
	if state.Settings.DailyTime != "" {
		if _, err := time.Parse("15:04", state.Settings.DailyTime); err != nil {
			return errors.New("invalid daily analysis time in state")
		}
		s.settings = state.Settings
	}
	for _, job := range state.Jobs {
		if job.ID == "" || !validAIJobType(job.Type) || (job.Mode != AIJobModeFull && job.Mode != AIJobModeIncremental) {
			continue
		}
		if job.Errors == nil {
			job.Errors = []AIJobError{}
		}
		copy := job
		s.jobs[job.ID] = &copy
		s.order = append(s.order, job.ID)
	}
	return nil
}

func (s *AIJobService) recoverInterruptedJobs() {
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	for _, id := range s.order {
		job := s.jobs[id]
		if job.Status == AIJobStatusRunning {
			job.Status = AIJobStatusPending
			job.Stage = "pending"
			job.CurrentResourceID = ""
			job.UpdatedAt = s.now()
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
