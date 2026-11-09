package services

import (
	"context"
	"errors"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// CacheRebuildStatus 是缓存重建任务的状态。
//
// 取值与扫描任务一致（pending/running/complete/cancelled/error），
// 前端一套 SSE 处理逻辑两处都能用。
type CacheRebuildStatus string

const (
	RebuildStatusPending   CacheRebuildStatus = "pending"
	RebuildStatusRunning   CacheRebuildStatus = "running"
	RebuildStatusComplete  CacheRebuildStatus = "complete"
	RebuildStatusCancelled CacheRebuildStatus = "cancelled"
	RebuildStatusError     CacheRebuildStatus = "error"
)

// 重建范围。与缓存清理的 scope 语义对齐，但只覆盖可以离线批量重建的两类。
const (
	// CacheScopeThumbs 缩略图（渲染档位）重建。
	CacheScopeThumbs = "thumbs"
	// CacheScopePreviews 预览图重建。
	CacheScopePreviews = "previews"
)

// DefaultRebuildThumbWidth 缩略图重建使用的档位宽度。
//
// 取 640 而不是最小档 320：640 是照片墙常见瓦片宽度，重建完用户翻到
// 照片墙时多半已经命中缓存。
const DefaultRebuildThumbWidth = 640

// DefaultRebuildPreviewWidth 预览图重建使用的档位宽度。
//
// 取 1280：够沉浸式查看器在 2 倍屏上用，又不至于把磁盘撑爆
// （13829 项 × 1280 宽 q85 约 1.4GB）。
const DefaultRebuildPreviewWidth = 1280

// CacheRebuildProgress 是重建任务的进度快照。
type CacheRebuildProgress struct {
	JobID string `json:"jobId"`
	// Status 任务状态。
	Status CacheRebuildStatus `json:"status"`
	// Scopes 本次重建覆盖的范围。
	Scopes []string `json:"scopes"`
	// Total 需要处理的媒体项总数。
	Total int `json:"total"`
	// Done 已完成（含失败）的媒体项数。
	Done int `json:"done"`
	// Failed 处理失败的媒体项数。
	Failed int `json:"failed"`
	// ElapsedMs 已耗时（毫秒）。
	ElapsedMs int64 `json:"elapsedMs"`
	// Error 失败原因（机器可读的错误码或空）。
	Error string `json:"error,omitempty"`
}

// cacheRebuildState 是单个重建任务的状态。
type cacheRebuildState struct {
	id        string
	ctx       context.Context
	cancel    context.CancelFunc
	status    CacheRebuildStatus
	scopes    []string
	startedAt time.Time
	total     int
	done      int
	failed    int
	err       error
	lastEvent CacheRebuildProgress
	subs      map[chan CacheRebuildProgress]struct{}
}

// CacheRebuildService 负责「清空后重建」的批量重建任务。
//
// 为什么要有它：渲染图是懒生成的 —— 清空缓存后第一次打开每一页都要在
// HTTP 请求里同步重算，用户看到的是整页图片卡住。把重建搬到后台任务里，
// 有进度、可取消，就不会占住浏览路径。
//
// 全进程同一时间只跑一个重建任务：它们都在抢同一份解码预算与磁盘 IO，
// 并行跑只会互相拖慢。
type CacheRebuildService struct {
	mu       sync.Mutex
	states   map[string]*cacheRebuildState
	activeID string

	catalog *ResourceCatalog
	thumbs  *ThumbnailService

	closed bool
}

// NewCacheRebuildService 创建重建服务。
func NewCacheRebuildService(catalog *ResourceCatalog, thumbs *ThumbnailService) *CacheRebuildService {
	return &CacheRebuildService{
		states:  make(map[string]*cacheRebuildState),
		catalog: catalog,
		thumbs:  thumbs,
	}
}

// Start 启动一次重建。已有任务在跑时复用它。
//
// scopes 是要重建的范围（thumbs / previews）；previewWidth 是预览图档位。
func (s *CacheRebuildService) Start(scopes []string, previewWidth int) (string, bool, error) {
	cleaned := normalizeRebuildScopes(scopes)
	if len(cleaned) == 0 {
		return "", false, errors.New("no rebuild scope selected")
	}
	if previewWidth <= 0 {
		previewWidth = DefaultRebuildPreviewWidth
	}
	previewWidth = SnapRenditionWidth(previewWidth)

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return "", false, errors.New("cache rebuild service is shutting down")
	}
	if active := s.states[s.activeID]; active != nil && isActiveRebuild(active.status) {
		id := active.id
		s.mu.Unlock()
		return id, true, nil
	}

	id := uuid.New().String()
	ctx, cancel := context.WithCancel(context.Background())
	state := &cacheRebuildState{
		id:        id,
		ctx:       ctx,
		cancel:    cancel,
		status:    RebuildStatusPending,
		scopes:    cleaned,
		startedAt: time.Now(),
		subs:      make(map[chan CacheRebuildProgress]struct{}),
	}
	state.lastEvent = s.progressLocked(state)
	s.states[id] = state
	s.activeID = id
	s.mu.Unlock()

	go s.run(state, previewWidth)
	return id, false, nil
}

// Cancel 取消进行中的重建。
func (s *CacheRebuildService) Cancel(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.states[id]
	if state == nil {
		return false
	}
	if !isActiveRebuild(state.status) {
		return false
	}
	state.cancel()
	return true
}

// Status 返回任务当前快照。
func (s *CacheRebuildService) Status(id string) (CacheRebuildProgress, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.states[id]
	if state == nil {
		return CacheRebuildProgress{}, false
	}
	return s.progressLocked(state), true
}

// Subscribe 为每个 SSE 客户端创建独立缓冲通道，并立即发送最新快照。
func (s *CacheRebuildService) Subscribe(id string) (<-chan CacheRebuildProgress, func(), bool) {
	s.mu.Lock()
	state := s.states[id]
	if state == nil {
		s.mu.Unlock()
		return nil, func() {}, false
	}
	ch := make(chan CacheRebuildProgress, 8)
	ch <- s.progressLocked(state)
	if isActiveRebuild(state.status) {
		state.subs[ch] = struct{}{}
	} else {
		close(ch)
	}
	s.mu.Unlock()

	cancel := func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if current := s.states[id]; current != nil {
			if _, ok := current.subs[ch]; ok {
				delete(current.subs, ch)
				close(ch)
			}
		}
	}
	return ch, cancel, true
}

// Close 取消所有任务并停止接受新任务。
func (s *CacheRebuildService) Close() {
	s.mu.Lock()
	s.closed = true
	for _, state := range s.states {
		if isActiveRebuild(state.status) {
			state.cancel()
		}
	}
	s.mu.Unlock()
}

func (s *CacheRebuildService) run(state *cacheRebuildState, previewWidth int) {
	defer state.cancel()
	s.mu.Lock()
	state.status = RebuildStatusRunning
	s.mu.Unlock()
	s.publish(state, s.progressWithStatus(state, RebuildStatusRunning))

	files := s.mediaFiles()
	s.mu.Lock()
	state.total = len(files)
	s.mu.Unlock()
	s.publish(state, s.progressWithStatus(state, RebuildStatusRunning))

	// 并行重建：渲染图的解码与缩放是 CPU 密集的，单线程跑整个库要半小时。
	// 并行度跟着核数走，ThumbnailService 自己的解码预算仍会兜住内存。
	workers := rebuildWorkerCount()
	queue := make(chan rebuildTarget)
	var wg sync.WaitGroup
	var failed atomic.Int64
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for target := range queue {
				if state.ctx.Err() != nil {
					continue
				}
				if err := s.rebuildOne(target, state.scopes, previewWidth); err != nil {
					failed.Add(1)
				}
				s.mu.Lock()
				state.done++
				s.mu.Unlock()
			}
		}()
	}

	for _, target := range files {
		if state.ctx.Err() != nil {
			break
		}
		queue <- target
	}
	close(queue)
	wg.Wait()

	if state.ctx.Err() != nil {
		s.finish(state, RebuildStatusCancelled, context.Canceled)
		return
	}
	s.mu.Lock()
	state.failed = int(failed.Load())
	s.mu.Unlock()
	s.finish(state, RebuildStatusComplete, nil)
}

// rebuildTarget 是一个待重建的媒体文件。
type rebuildTarget struct {
	path string
	// cover 是相册封面。封面会出现在侧栏、搜索结果这类小位上，
	// 需要最小档；其它照片只在照片墙里出现，取中档就够。
	cover bool
}

// rebuildOne 为一个媒体项生成所需档位的渲染图。
func (s *CacheRebuildService) rebuildOne(target rebuildTarget, scopes []string, previewWidth int) error {
	ext := strings.ToLower(filepath.Ext(target.path))
	switch ext {
	case ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tif", ".tiff", ".heic", ".heif":
	default:
		// 视频封面要靠 ffmpeg 抽帧，成本高且收益小，不参与批量重建。
		return nil
	}
	if s.thumbs == nil {
		return nil
	}

	var firstErr error
	for _, scope := range scopes {
		switch scope {
		case CacheScopeThumbs:
			for _, width := range rebuildThumbWidths(target.cover) {
				if _, err := s.thumbs.GetOrCreate(target.path, width); err != nil && firstErr == nil {
					firstErr = err
				}
			}
		case CacheScopePreviews:
			if _, err := s.thumbs.GetOrCreatePreview(target.path, previewWidth); err != nil && firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

// mediaFiles 列出需要重建的媒体文件（绝对路径，只在服务端内部使用）。
//
// cover 为 true 的项是相册封面：封面要额外生成最小档。
func (s *CacheRebuildService) mediaFiles() []rebuildTarget {
	if s.catalog == nil {
		return nil
	}
	snapshot := s.catalog.Acquire()
	result := snapshot.Result()
	if result == nil {
		return nil
	}
	seen := make(map[string]struct{})
	files := make([]rebuildTarget, 0, 1024)
	covers := make(map[string]struct{})
	appendAlbum := func(album models.Album) {
		if album.CoverImage != "" {
			covers[album.CoverImage] = struct{}{}
		}
		for _, path := range album.ImageFiles {
			if path == "" {
				continue
			}
			if _, ok := seen[path]; ok {
				continue
			}
			seen[path] = struct{}{}
			_, isCover := covers[path]
			files = append(files, rebuildTarget{path: path, cover: isCover})
		}
	}
	// 相册可以嵌在集合里（集合 → 子集合 → 相册），只扫顶层会漏掉大半。
	var visitCollection func(collection models.Collection)
	visitCollection = func(collection models.Collection) {
		for i := range collection.Albums {
			appendAlbum(collection.Albums[i])
		}
		for i := range collection.Collections {
			visitCollection(collection.Collections[i])
		}
	}
	for i := range result.Albums {
		appendAlbum(result.Albums[i])
	}
	for i := range result.Collections {
		visitCollection(result.Collections[i])
	}
	return files
}

// rebuildThumbWidths 缩略图重建要生成的档位。
//
// 封面多生成最小档：它出现在侧栏、搜索结果、标签页这些小位上，
// 48px 的槽位配 640 宽的图是白下载。其它照片只在照片墙里出现，
// 640 一档就够 —— 再往上（1280/1920）按需生成即可，全库预生成
// 1280 会多花一倍磁盘，而多数照片本来就没有那么宽。
func rebuildThumbWidths(cover bool) []int {
	if cover {
		return []int{RenditionWidths[0], RenditionWidths[1]}
	}
	return []int{RenditionWidths[1]}
}

// rebuildWorkerCount 重建任务的并行度。
//
// 跟随核数，但不超过 12：渲染是 CPU 密集的，太多并发只会让每个任务
// 更慢，还把内存峰值推高。
func rebuildWorkerCount() int {
	return min(12, runtime.NumCPU())
}

func (s *CacheRebuildService) finish(state *cacheRebuildState, status CacheRebuildStatus, err error) {
	s.mu.Lock()
	state.status = status
	state.err = err
	s.mu.Unlock()
	event := s.progressWithStatus(state, status)
	if err != nil && status == RebuildStatusError {
		event.Error = err.Error()
	}
	s.publish(state, event)
	s.mu.Lock()
	for ch := range state.subs {
		close(ch)
		delete(state.subs, ch)
	}
	s.mu.Unlock()
}

func (s *CacheRebuildService) publish(state *cacheRebuildState, event CacheRebuildProgress) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state.lastEvent = event
	for ch := range state.subs {
		select {
		case ch <- event:
		default:
			// 客户端来不及消费时丢弃这一条：进度是快照，下一条会覆盖它。
		}
	}
}

func (s *CacheRebuildService) progressLocked(state *cacheRebuildState) CacheRebuildProgress {
	return CacheRebuildProgress{
		JobID:     state.id,
		Status:    state.status,
		Scopes:    state.scopes,
		Total:     state.total,
		Done:      state.done,
		Failed:    state.failed,
		ElapsedMs: time.Since(state.startedAt).Milliseconds(),
	}
}

func (s *CacheRebuildService) progressWithStatus(state *cacheRebuildState, status CacheRebuildStatus) CacheRebuildProgress {
	event := s.progressLocked(state)
	event.Status = status
	return event
}

// normalizeRebuildScopes 归一化重建范围：去重、只保留认识的范围、保序。
func normalizeRebuildScopes(scopes []string) []string {
	seen := make(map[string]struct{}, len(scopes))
	out := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		switch scope {
		case CacheScopeThumbs, CacheScopePreviews:
		default:
			continue
		}
		if _, ok := seen[scope]; ok {
			continue
		}
		seen[scope] = struct{}{}
		out = append(out, scope)
	}
	return out
}

func isActiveRebuild(status CacheRebuildStatus) bool {
	return status == RebuildStatusPending || status == RebuildStatusRunning
}

// rebuildTargetName 供日志与界面显示的范围名称。
func rebuildTargetName(scope string) string {
	switch scope {
	case CacheScopeThumbs:
		return "缩略图"
	case CacheScopePreviews:
		return "预览图"
	default:
		return scope
	}
}
