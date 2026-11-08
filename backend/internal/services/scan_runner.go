package services

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/pathutil"
)

type ScanStatus string

const (
	ScanStatusPending   ScanStatus = "pending"
	ScanStatusRunning   ScanStatus = "running"
	ScanStatusComplete  ScanStatus = "complete"
	ScanStatusCancelled ScanStatus = "cancelled"
	ScanStatusError     ScanStatus = "error"
)

type ProgressEvent struct {
	ScanID          string     `json:"scanId"`
	Progress        int        `json:"progress"`
	Status          ScanStatus `json:"status"`
	Phase           string     `json:"phase,omitempty"`
	CurrentPath     string     `json:"currentPath,omitempty"`
	AlbumsFound     int        `json:"albumsFound"`
	Error           string     `json:"error,omitempty"`
	ElapsedMs       int64      `json:"elapsedMs"`
	LibraryRevision uint64     `json:"libraryRevision,omitempty"`
}

type ScanState struct {
	ID         string
	Ctx        context.Context
	Cancel     context.CancelFunc
	Status     ScanStatus
	StartedAt  time.Time
	FinishedAt time.Time
	Progress   int
	Result     *models.ScanResult
	Err        error
	Generation uint64
	Revision   uint64
	done       chan struct{}
	lastEvent  ProgressEvent
	subs       map[chan ProgressEvent]struct{}
}

type AsyncScanRunner struct {
	mu         sync.Mutex
	states     map[string]*ScanState
	activeID   string
	cache      *ScanResultCache
	catalog    *ResourceCatalog
	covers     *CoverOverrideStore
	retention  time.Duration
	closed     bool
	generation uint64
}

func NewAsyncScanRunner() *AsyncScanRunner {
	return &AsyncScanRunner{
		states:    make(map[string]*ScanState),
		retention: 10 * time.Minute,
	}
}

func (r *AsyncScanRunner) SetCache(cache *ScanResultCache)              { r.cache = cache }
func (r *AsyncScanRunner) SetCatalog(catalog *ResourceCatalog)          { r.catalog = catalog }
func (r *AsyncScanRunner) SetCoverOverrides(covers *CoverOverrideStore) { r.covers = covers }

// StartOrReuse 保证全进程同一时间只有一个扫描任务。
// 启动不创建进度订阅；消费方通过 Subscribe 显式订阅并负责释放。
func (r *AsyncScanRunner) StartOrReuse(opts ScanOptions) (string, bool, error) {
	if len(opts.Roots) == 0 {
		return "", false, errors.New("root is required")
	}

	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return "", false, errors.New("scan runner is shutting down")
	}
	if active := r.states[r.activeID]; active != nil && isActiveScan(active.Status) {
		id := active.ID
		r.mu.Unlock()
		return id, true, nil
	}

	id := uuid.New().String()
	ctx, cancel := context.WithCancel(context.Background())
	state := &ScanState{
		ID:         id,
		Ctx:        ctx,
		Cancel:     cancel,
		Status:     ScanStatusPending,
		StartedAt:  time.Now(),
		Generation: r.generation,
		done:       make(chan struct{}),
		subs:       make(map[chan ProgressEvent]struct{}),
	}
	state.lastEvent = ProgressEvent{ScanID: id, Status: ScanStatusPending}
	r.states[id] = state
	r.activeID = id
	r.mu.Unlock()

	go r.run(state, opts)
	return id, false, nil
}

func (r *AsyncScanRunner) Cancel(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.states[id]
	if state == nil || !isActiveScan(state.Status) {
		return false
	}
	state.Cancel()
	return true
}

// Invalidate 使当前任务的提交令牌失效并发出取消信号。
// 媒体根变更或用户清空库时必须先调用，防止旧任务稍后复活。
func (r *AsyncScanRunner) Invalidate() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.generation++
	if active := r.states[r.activeID]; active != nil && isActiveScan(active.Status) {
		active.Cancel()
	}
	// 旧任务继续登记直至回收，但不再作为新配置的可复用任务。
	r.activeID = ""
}

func (r *AsyncScanRunner) Get(id string) *ScanState {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.states[id]
	if state == nil {
		return nil
	}
	cp := *state
	cp.subs = nil
	return &cp
}

func (r *AsyncScanRunner) Result(id string) *models.ScanResult {
	r.mu.Lock()
	defer r.mu.Unlock()
	if state := r.states[id]; state != nil {
		return state.Result
	}
	return nil
}

func (r *AsyncScanRunner) Wait(id string) {
	r.mu.Lock()
	state := r.states[id]
	r.mu.Unlock()
	if state != nil {
		<-state.done
	}
}

// Shutdown 拒绝新任务、取消所有活动扫描并等待退出。
func (r *AsyncScanRunner) Shutdown(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	r.mu.Lock()
	r.closed = true
	waits := make([]<-chan struct{}, 0, len(r.states))
	for _, state := range r.states {
		if !isActiveScan(state.Status) {
			continue
		}
		state.Cancel()
		waits = append(waits, state.done)
	}
	r.mu.Unlock()

	for _, done := range waits {
		select {
		case <-done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

// Subscribe 为每个 SSE 客户端创建独立缓冲通道，并立即发送最新快照。
func (r *AsyncScanRunner) Subscribe(id string) (<-chan ProgressEvent, func(), bool) {
	r.mu.Lock()
	state := r.states[id]
	if state == nil {
		r.mu.Unlock()
		return nil, func() {}, false
	}
	ch := r.subscribeLocked(state)
	terminal := !isActiveScan(state.Status)
	if terminal {
		close(ch)
	}
	r.mu.Unlock()
	cancel := func() {
		r.mu.Lock()
		if current := r.states[id]; current != nil {
			if _, ok := current.subs[ch]; ok {
				delete(current.subs, ch)
				close(ch)
			}
		}
		r.mu.Unlock()
	}
	return ch, cancel, true
}

func (r *AsyncScanRunner) subscribeLocked(state *ScanState) chan ProgressEvent {
	ch := make(chan ProgressEvent, 8)
	ch <- state.lastEvent
	if isActiveScan(state.Status) {
		state.subs[ch] = struct{}{}
	}
	return ch
}

func (r *AsyncScanRunner) run(state *ScanState, opts ScanOptions) {
	defer close(state.done)
	r.publish(state, ProgressEvent{ScanID: state.ID, Status: ScanStatusRunning})

	roots, err := prepareScanRoots(opts)
	if err != nil {
		if state.Ctx.Err() != nil {
			r.finishInterrupted(state, ScanStatusCancelled, context.Canceled)
		} else {
			r.finishInterrupted(state, ScanStatusError, err)
		}
		return
	}
	rootPaths := scanRootPaths(roots)
	scanner := NewScanner()
	scanner.ctx = state.Ctx
	progress := 0
	hook := func(ev ScanProgress) {
		if state.Ctx.Err() != nil {
			return
		}
		progress = estimateScanProgress(ev, progress)
		r.publish(state, ProgressEvent{
			ScanID:      state.ID,
			Progress:    progress,
			Status:      ScanStatusRunning,
			Phase:       ev.Phase,
			CurrentPath: relativeScanPath(ev.CurrentPath, rootPaths),
			AlbumsFound: ev.AlbumsFound,
			ElapsedMs:   time.Since(state.StartedAt).Milliseconds(),
		})
	}

	result, err := scanner.scanRoots(opts, roots, hook)
	if err == nil {
		err = validateScanRoots(roots)
	}
	if errors.Is(err, context.Canceled) || state.Ctx.Err() != nil {
		r.finishInterrupted(state, ScanStatusCancelled, context.Canceled)
		return
	}
	if err != nil {
		r.finishInterrupted(state, ScanStatusError, err)
		return
	}
	// 检查 generation、发布对外视图和替换持久化快照共用一把写锁。
	// 媒体根变更时 Invalidate 会等待本段完成后再清空库；若它先发生，
	// 旧任务则无法再把结果复活。
	r.mu.Lock()
	if state.Generation != r.generation || state.Ctx.Err() != nil {
		r.mu.Unlock()
		r.finishInterrupted(state, ScanStatusCancelled, context.Canceled)
		return
	}
	revision := uint64(0)
	if r.catalog != nil {
		result, revision = r.catalog.CommitScan(
			result, rootPaths, r.cache, r.covers,
		)
	} else if r.cache != nil {
		r.cache.Set(result)
	}
	state.Revision = revision
	event := ProgressEvent{
		ScanID: state.ID, Progress: 100, Status: ScanStatusComplete, Phase: "done",
		AlbumsFound: result.AlbumCount, ElapsedMs: time.Since(state.StartedAt).Milliseconds(),
		LibraryRevision: revision,
	}
	retention := r.finishLocked(state, event, result, nil)
	r.mu.Unlock()
	r.scheduleRemoval(state, retention)
}

func (r *AsyncScanRunner) publish(state *ScanState, event ProgressEvent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state.Status = event.Status
	state.Progress = event.Progress
	state.lastEvent = event
	for ch := range state.subs {
		select {
		case ch <- event:
		default:
			// 慢客户端只需要最新进度；丢弃最旧事件后补入当前事件。
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- event:
			default:
			}
		}
	}
}

// 根目录等分读取阶段的预算，动态发现新目录时不回退；后续整理仍保留独立阶段。
// 这是界面预估值，不代表剩余文件数或剩余耗时，只有快照发布成功才到 100%。
func estimateScanProgress(event ScanProgress, previous int) int {
	if event.Phase == "smart-grouping" {
		return 99
	}
	const directoryLimit = 95
	rootProgress := directoryLimit * min(event.Processed, event.Total) / max(1, event.Total)
	estimate := (directoryLimit*event.RootIndex + rootProgress) / max(1, event.RootCount)
	return max(previous, min(directoryLimit, estimate))
}

func (r *AsyncScanRunner) finishInterrupted(state *ScanState, status ScanStatus, err error) {
	r.mu.Lock()
	event := state.lastEvent
	event.ScanID = state.ID
	event.Status = status
	event.ElapsedMs = time.Since(state.StartedAt).Milliseconds()
	event.LibraryRevision = 0
	event.Error = ""
	if status == ScanStatusError {
		// 事件里只放机器可读的码和媒体根别名：绝对路径不能进响应，
		// 英文句子由前端翻译成中文（与 phase 的处理方式一致）。
		code, alias := scanFailure(err)
		event.Error = code
		if alias != "" {
			event.CurrentPath = alias
		}
	}
	retention := r.finishLocked(state, event, nil, err)
	r.mu.Unlock()
	r.scheduleRemoval(state, retention)
}

// 扫描失败时写进事件的机器可读错误码。前端据此翻译成中文文案。
const (
	ScanErrorCodeFailed         = "scan_failed"
	ScanErrorCodeRootMissing    = "root_missing"
	ScanErrorCodeRootNotDir     = "root_not_dir"
	ScanErrorCodeRootUnreadable = "root_unreadable"
	ScanErrorCodeRootChanged    = "root_changed"
)

// scanFailure 把扫描错误翻译成 (错误码, 媒体根别名)。
//
// 只返回媒体根的目录名（别名），不返回绝对路径 —— 事件要发给浏览器，
// 不能把本机文件系统路径原样送出去。
func scanFailure(err error) (string, string) {
	var scanErr *ScanError
	if errors.As(err, &scanErr) {
		name := filepath.Base(filepath.Clean(scanErr.Path))
		switch scanErr.Kind {
		case ScanRootMissing:
			return ScanErrorCodeRootMissing, name
		case ScanRootNotDir:
			return ScanErrorCodeRootNotDir, name
		case ScanRootUnreadable:
			return ScanErrorCodeRootUnreadable, name
		case ScanRootChanged:
			return ScanErrorCodeRootChanged, name
		}
	}
	return ScanErrorCodeFailed, ""
}

// finishLocked 更新终态并广播；调用方必须已持有 r.mu。
func (r *AsyncScanRunner) finishLocked(state *ScanState, event ProgressEvent, result *models.ScanResult, err error) time.Duration {
	state.Status = event.Status
	state.Progress = event.Progress
	state.Result = result
	state.Err = err
	state.FinishedAt = time.Now()
	state.lastEvent = event
	if r.activeID == state.ID {
		r.activeID = ""
	}
	for ch := range state.subs {
		select {
		case ch <- event:
		default:
			select {
			case <-ch:
			default:
			}
			ch <- event
		}
		close(ch)
		delete(state.subs, ch)
	}
	retention := r.retention
	return retention
}

func (r *AsyncScanRunner) scheduleRemoval(state *ScanState, retention time.Duration) {
	if retention > 0 {
		time.AfterFunc(retention, func() {
			r.mu.Lock()
			delete(r.states, state.ID)
			r.mu.Unlock()
		})
	}
}

func isActiveScan(status ScanStatus) bool {
	return status == ScanStatusPending || status == ScanStatusRunning
}

func relativeScanPath(path string, roots []string) string {
	owner, relative, matched := pathutil.MostSpecificRoot(path, roots)
	if !matched {
		return ""
	}
	name := filepath.Base(filepath.Clean(owner))
	if relative == "." {
		return name
	}
	return filepath.ToSlash(filepath.Join(name, relative))
}
