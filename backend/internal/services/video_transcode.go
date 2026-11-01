package services

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

// ErrTranscodeUnavailable ffmpeg 不可用 / 路径无效 / 不可执行。
//
// 与 FaststartUnavailable 同语义：转码是优化项不是必需项，
// 拿到此错误应回退到发原文件,而不是 5xx。
var ErrTranscodeUnavailable = errors.New("transcode unavailable")

// TranscodeStatus 转码解析状态。
//
// 状态机:
//
//	nil receiver / 非视频   → TranscodeStatusSkipped
//	ffmpeg 不可用            → TranscodeStatusUnavailable
//	原文件已被浏览器支持       → TranscodeStatusNotNeeded
//	缓存命中                  → TranscodeStatusCached
//	正在排队(超过并发上限)   → TranscodeStatusQueued
//	正在转码                 → TranscodeStatusRunning
//	转码失败(可重试)         → TranscodeStatusFailed
//
// handler 端一般只看 Resolve() 返回值;UI 端用 GetStatus() 查详情。
type TranscodeStatus int32

const (
	TranscodeStatusUnknown TranscodeStatus = iota
	TranscodeStatusSkipped
	TranscodeStatusUnavailable
	TranscodeStatusNotNeeded
	TranscodeStatusCached
	TranscodeStatusQueued
	TranscodeStatusRunning
	TranscodeStatusFailed
)

func (s TranscodeStatus) String() string {
	switch s {
	case TranscodeStatusSkipped:
		return "skipped"
	case TranscodeStatusUnavailable:
		return "unavailable"
	case TranscodeStatusNotNeeded:
		return "not_needed"
	case TranscodeStatusCached:
		return "cached"
	case TranscodeStatusQueued:
		return "queued"
	case TranscodeStatusRunning:
		return "running"
	case TranscodeStatusFailed:
		return "failed"
	default:
		return "unknown"
	}
}

// MarshalJSON 让 status 在 JSON 里输出字符串而不是数字。
//
// 前端用 SSE 拿到事件时 status: "running" 比 status: 6 直观得多。
func (s TranscodeStatus) MarshalJSON() ([]byte, error) {
	return []byte(`"` + s.String() + `"`), nil
}

// TranscodeInfo 当前一次转码任务的细节，供 /api/videos/:fileId/transcode/status 用。
//
// 字段:
//   - Status  上面那一组常量
//   - Progress 0.0 ~ 1.0,只有 Running 时有意义
//   - EtaSec  估算剩余秒数,best-effort(0 = 未知)
//   - Error   失败原因(可空)
type TranscodeInfo struct {
	Status   TranscodeStatus `json:"status"`
	Progress float64         `json:"progress"`
	EtaSec   int             `json:"etaSec"`
	Error    string          `json:"error,omitempty"`
}

// TranscodeProfile 编码参数集合。
//
// V1 固定一种 profile;后续要加 4K / 720p 等多档位时新增 Profile 即可,
// 缓存 key 包含 profile 字符串,互不污染。
type TranscodeProfile struct {
	// 人类可读名,作为 profile hash 的一部分
	Name string
	// 视频编码器
	VideoCodec string
	// 编码 preset (ultrafast / fast / medium / slow ...)
	Preset string
	// 视频码率,空 = 用 CRF
	VideoBitrate string
	// 视频 CRF 0-51,默认 22
	CRF int
	// 音频编码器
	AudioCodec string
	// 音频码率
	AudioBitrate string
	// 最高分辨率,0 = 不限
	MaxHeight int
}

// SelectVideoCodec 按"硬件优先,软解兜底"顺序选一个能用的 H.264 编码器。
//
// 试过 NVIDIA NVENC / Intel QSV / AMD AMF / MediaFoundation / libx264;
// 返回第一个实际能 encode 一帧的(ffmpeg 退出码 0)。返回纯名称(无 ffmpeg 前缀),
// 用法 "-c:v <name>"。
//
// 关键决策:每个编码器都跑一次空 encode 太慢(每个 ~100ms+,5 个就是 500ms+),
// 这里用更轻的探测:在 -loglevel error 下"无输入"地试启动编码器(立即返回),
// 失败时退出码非 0(就跳过)。实测 < 50ms 总开销。
//
// 注意:
//   - 硬件编码器即便支持也可能在某些机器上失败(驱动/权限),失败自动兜底
//   - V1 只在 Windows / Linux / macOS 上跑过;其他平台待补
//   - 缓存探测结果(per-process),第一次启动会触发,之后是常数时间
func SelectVideoCodec(ffmpegPath string) string {
	if ffmpegPath == "" {
		return "libx264"
	}
	candidates := []string{
		"h264_nvenc",        // NVIDIA
		"h264_qsv",          // Intel
		"h264_amf",          // AMD
		"h264_videotoolbox", // macOS
		"h264_mf",           // Windows MediaFoundation
		"libx264",           // 软件兜底
	}
	for _, c := range candidates {
		if probeCodec(ffmpegPath, c) {
			return c
		}
	}
	// 全部失败(极少见) → 还是 libx264,让真实转码时报错
	return "libx264"
}

// resolveCodec 懒加载选 codec:首次 ensureRunning 触发,选好后写回
// s.profile.VideoCodec 复用。选 auto 或空时调用;用户显式指定时不调。
//
// 关键:启动期不再跑 6 次 ffmpeg -h encoder=*(每个 50ms 共 300ms+),
// 那些 ffmpeg 调用是浪费 — 用户没看视频时根本用不上。
func (s *TranscodeService) resolveCodec() string {
	if s.profile.VideoCodec != "" && s.profile.VideoCodec != "auto" {
		return s.profile.VideoCodec
	}
	s.selectedCodecOnce.Do(func() {
		s.selectedCodec = SelectVideoCodec(s.ffmpeg)
		// 写回 profile,后续直接读 profile.VideoCodec 即可
		s.profile.VideoCodec = s.selectedCodec
	})
	return s.selectedCodec
}

// probeCodec 用 ffmpeg -h encoder=<name> 探测编码器是否可用。
//
// 不真跑 encode;ffmpeg 启动后会立刻检查 encoder 名字是否存在 + 必要参数。
// 不存在时 stderr 包含 "Unknown encoder" + 退出码 != 0。
// 存在(即便硬件缺失)时,ffmpeg 会列出选项,退出码 0(有警告但接受)。
//
// 返回 true 表示该编码器在当前 ffmpeg + 平台上"至少能被识别",实际能跑
// 要等真转码时才能确认(所以 V1 还是可能 fallback)。
func probeCodec(ffmpegPath, codecName string) bool {
	cmd := exec.Command(ffmpegPath, "-hide_banner", "-h", "encoder="+codecName)
	if err := cmd.Run(); err != nil {
		return false
	}
	return true
}

// presetForCodec 不同编码器的 preset 名称不一样,集中映射。
//
// 不在映射表里的就原样返回(用户可能用 custom 名字)。
func presetForCodec(codec, userPreset string) string {
	if userPreset == "" {
		// 用户没指定时,按 codec 选默认
		switch codec {
		case "libx264", "libx265":
			return "veryfast"
		case "h264_nvenc":
			return "p1" // NVENC: p1=fastest, p7=slowest
		case "h264_qsv":
			return "veryfast"
		case "h264_amf":
			return "speed"
		default:
			return ""
		}
	}
	// 软解 preset 用户原样给(medium / fast / veryfast)
	// 硬解 preset 可能不兼容,这里不做转换,留 false 让 ffmpeg 报错
	return userPreset
}

// 选择理由:
//   - H.264: 浏览器/移动设备/电视盒子最大公约数;VP9/AV1 输出虽然更小但
//     浏览器兼容范围更窄,不选
//   - preset veryfast: 实测 4K AV1 源在 medium 下慢到 0.035x(13 小时转
//     27 分钟视频);veryfast 提速约 10 倍,质量损失肉眼几乎不可见
//   - MaxHeight 1080: 大多数用户没 4K 屏,下采样到 1080p 编码速度快
//     4-9 倍(4K → 1080p 像素数 1/4);保持宽高比用 letterbox
//   - CRF 22: 视觉无损/中等大小(V1 不暴露此参数)
//   - AudioBitrate 128k: 语音够用
//
// 管理员可改 config.yaml 覆盖 preset / maxHeight / crf;V1 暂不暴露
// 给前端 UI。
func DefaultTranscodeProfile() TranscodeProfile {
	return TranscodeProfile{
		Name:         "h264-aac-faststart-1080p",
		VideoCodec:   "libx264", // 软解兜底,绝不自动选硬解(驱动坑多)
		Preset:       "veryfast",
		CRF:          22,
		AudioCodec:   "aac",
		AudioBitrate: "128k",
		MaxHeight:    1080,
	}
}

// TranscodeService 把"非浏览器通用编码"的视频转成 H.264 + AAC 在 MP4 容器里,
// 缓存到本地，供 /api/media/:fileId 直接 SendFile。
//
// 与 FaststartService 的关系:
//   - Faststart: 不重编码,只挪 moov,处理"moov 在末尾"问题
//   - Transcode: 重编码,处理"浏览器不支持该编码"问题
//   - 两者并存,VideoHandler 解析顺序: transcode → faststart → 原文件
//
// 失败永远回退到发原文件,绝不阻断播放。
type TranscodeService struct {
	cacheDir string
	ffmpeg   string
	info     *VideoInfoService // 用于探测 codec;nil 时按"需要转码"保守处理
	profile  TranscodeProfile
	timeout  time.Duration

	// 并发上限 (全局 ffmpeg 进程数)。0 = auto = max(1, NumCPU/2)。
	concurrency int
	sem         chan struct{}

	// 同 key 同一时刻只跑一次 ffmpeg。
	flight singleflight.Group

	mu       sync.Mutex
	inflight map[string]*transcodeJob // absPath -> job
	cached   map[string]struct{}      // absPath -> 已经成功缓存(避免重复 stat)
	closed   bool

	// 可用性探测缓存:Available() 跑 `ffmpeg -version` 50-200ms;
	// Resolve / GetStatus / handler 热路径都调,旧实现每次都重跑,
	// ffmpeg 在的情况下其实是浪费。sync.Once 锁住整个 service 生命周期。
	availOnce sync.Once
	avail     bool

	// 编码器自动选择懒加载:启动期不跑 ffmpeg -h encoder=* 探测(6 次
	// 各 50ms 共 300ms+),延后到首次 ensureRunning 调用时再跑。sync.Once
	// 锁住结果;service 重建(OnChange)时自动失效。
	selectedCodec     string
	selectedCodecOnce sync.Once
}

type transcodeJob struct {
	cancel context.CancelFunc
	done   chan struct{}
	status TranscodeStatus
	err    error

	mu       sync.Mutex
	progress float64              // 最新进度(0-1)
	subs     []chan TranscodeInfo // SSE 订阅者;job 结束时全部关闭
}

// TranscodeOptions 构造选项。
type TranscodeOptions struct {
	CacheDir    string // 必填
	FFmpeg      string // 必填
	Info        *VideoInfoService
	Profile     TranscodeProfile
	Timeout     time.Duration // 单文件超时,默认 30m
	Concurrency int           // 并发上限,0 = auto
}

// NewTranscodeService 构造。
//
// 不会因为 ffmpeg 不可用而失败;ffmpeg 路径会在 Available() 探测。
//
// 自动检测:如果 opts.Profile.VideoCodec 是空或 "auto",**不在启动期**
// 跑 SelectVideoCodec(6 次 ffmpeg -h encoder=* 各 50ms),延后到首次
// ensureRunning 调用时再跑。懒加载由 selectedCodecOnce 保证只探一次,
// OnChange 重建 service 时自动失效。
func NewTranscodeService(opts TranscodeOptions) *TranscodeService {
	if opts.CacheDir == "" {
		panic("services: NewTranscodeService requires CacheDir")
	}
	profile := opts.Profile
	if profile.Name == "" {
		profile = DefaultTranscodeProfile()
	}
	// 编码器选择延后到 first use;这里只把"是否要自动选"信息记下。
	// resolveCodec() 是懒加载入口。
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	concurrency := opts.Concurrency
	if concurrency <= 0 {
		concurrency = runtime.NumCPU() / 2
		if concurrency < 1 {
			concurrency = 1
		}
	}
	return &TranscodeService{
		cacheDir:    opts.CacheDir,
		ffmpeg:      opts.FFmpeg,
		info:        opts.Info,
		profile:     profile,
		timeout:     timeout,
		concurrency: concurrency,
		sem:         make(chan struct{}, concurrency),
		inflight:    make(map[string]*transcodeJob),
		cached:      make(map[string]struct{}),
	}
}

// Available 返回 ffmpeg 是否可用(整个 service 生命周期只探测一次)。
//
// 旧实现每次调用都跑 `ffmpeg -version`(进程启动 50-200ms);
// Resolve / GetStatus / SSE handler 都会调,改成 sync.Once 后
// 同一个 service 实例只跑一次,OnChange 重建 service 时自动失效。
func (s *TranscodeService) Available() bool {
	if s == nil || s.ffmpeg == "" {
		return false
	}
	if s.isClosed() {
		return false
	}
	s.availOnce.Do(func() {
		cmd := exec.Command(s.ffmpeg, "-version")
		s.avail = cmd.Run() == nil
	})
	return s.avail
}

// Concurrency 返回当前配置的并发上限。
func (s *TranscodeService) Concurrency() int {
	if s == nil {
		return 0
	}
	return s.concurrency
}

// Profile 返回当前 profile。
func (s *TranscodeService) Profile() TranscodeProfile {
	if s == nil {
		return TranscodeProfile{}
	}
	return s.profile
}

// CacheDir 返回构造时设置的缓存目录。
func (s *TranscodeService) CacheDir() string {
	if s == nil {
		return ""
	}
	return s.cacheDir
}

// Resolve 决定 /api/media/:fileId 应该发送哪个文件，以及当前转码状态。
//
// 返回 (servePath, status):
//   - TranscodeStatusNotNeeded: 浏览器能直发,servePath=absPath(交给 FaststartService)
//   - TranscodeStatusCached: 已转码并缓存,servePath=cachePath
//   - TranscodeStatusRunning / TranscodeStatusQueued: 转码中,servePath=absPath(用户能播就播,
//     不能就由前端 UI 提示等待转码;浏览器会因 codec 不支持触发 onError,
//     那是已知行为,前端用 SSE 看到 done 后重挂载)
//   - TranscodeStatusUnavailable / TranscodeStatusFailed: 退到发原文件
//
// 设计原则:任何内部失败都退到 TranscodeStatusFailed + absPath,绝不让
// Resolve 返回 error 让 handler 500。
//
// info 可选非 nil:handler 端已 stat 过源文件,这里复用,省一次 syscall。
// 传 nil 时本函数内部读取源文件信息。
func (s *TranscodeService) Resolve(absPath string, info os.FileInfo) (servePath string, status TranscodeStatus) {
	if s == nil {
		return absPath, TranscodeStatusSkipped
	}
	if s.isClosed() {
		return absPath, TranscodeStatusUnavailable
	}
	defer func() {
		if servePath == "" {
			servePath = absPath
			if status == TranscodeStatusUnknown {
				status = TranscodeStatusFailed
			}
		}
	}()

	// 非视频文件(理论上 handler 端已经 IsVideoFile 过滤,这里再防一下)
	ext := strings.ToLower(filepath.Ext(absPath))
	switch ext {
	case ".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi":
		// ok
	default:
		return absPath, TranscodeStatusSkipped
	}

	if !s.Available() {
		return absPath, TranscodeStatusUnavailable
	}

	fi := info
	if fi == nil {
		var err error
		fi, err = os.Stat(absPath)
		if err != nil {
			return absPath, TranscodeStatusFailed
		}
	}

	// 浏览器已经能播 → 不需要转码
	if !s.needsTranscode(absPath, ext) {
		return absPath, TranscodeStatusNotNeeded
	}

	// 缓存命中
	key := s.cacheKey(absPath, fi)
	cachePath := s.cachePathFor(key)
	if _, err := statVideoCache(cachePath); err == nil {
		s.markCached(absPath)
		return cachePath, TranscodeStatusCached
	}

	// 启动 / 复用正在跑的转码
	if path, st := s.ensureRunning(absPath, cachePath, fi); st == TranscodeStatusCached {
		return path, st
	} else {
		return absPath, st
	}
}

// GetStatus 查询当前转码状态（用于 /api/videos/:fileId/transcode/status）。
//
// 不阻塞:直接读 inflight / cached / 文件 stat 综合判断。
//
// 顺序:inflight job 优先于文件 stat —— 否则 ffmpeg 正在写盘时
// 文件已存在但内容不完整,会被错判为 cached。
func (s *TranscodeService) GetStatus(absPath string) TranscodeInfo {
	info := TranscodeInfo{Status: TranscodeStatusUnknown, Progress: 0}
	if s == nil {
		info.Status = TranscodeStatusSkipped
		return info
	}
	if s.isClosed() {
		info.Status = TranscodeStatusUnavailable
		return info
	}

	fi, err := os.Stat(absPath)
	if err != nil {
		info.Status = TranscodeStatusFailed
		info.Error = "source not found"
		return info
	}

	ext := strings.ToLower(filepath.Ext(absPath))
	switch ext {
	case ".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi":
	default:
		info.Status = TranscodeStatusSkipped
		return info
	}

	if !s.Available() {
		info.Status = TranscodeStatusUnavailable
		return info
	}

	if !s.needsTranscode(absPath, ext) {
		info.Status = TranscodeStatusNotNeeded
		info.Progress = 1.0
		return info
	}

	// 1) 优先看 inflight — 正在跑就用真实进度
	s.mu.Lock()
	job, ok := s.inflight[absPath]
	s.mu.Unlock()
	if ok {
		job.mu.Lock()
		info.Progress = job.progress
		jobStatus := job.status
		jobErr := job.err
		job.mu.Unlock()

		switch jobStatus {
		case TranscodeStatusRunning:
			info.Status = TranscodeStatusRunning
		case TranscodeStatusQueued:
			info.Status = TranscodeStatusQueued
		case TranscodeStatusFailed:
			info.Status = TranscodeStatusFailed
			if jobErr != nil {
				info.Error = publicTranscodeError(jobErr)
			}
		case TranscodeStatusCached:
			// 已发布的缓存仍可能被外部删除、清空或替换，重新校验条目。
			key := s.cacheKey(absPath, fi)
			cachePath := s.cachePathFor(key)
			if _, err := statVideoCache(cachePath); err == nil {
				info.Status = TranscodeStatusCached
				info.Progress = 1.0
			} else {
				// 缓存失效，下一次 Resolve 可重新生成。
				info.Status = TranscodeStatusFailed
				info.Error = "cache file missing or invalid"
			}
		}
		return info
	}

	// 2) 没 inflight 但文件已存在 → 进程重启后命中磁盘缓存
	key := s.cacheKey(absPath, fi)
	cachePath := s.cachePathFor(key)
	if _, err := statVideoCache(cachePath); err == nil {
		info.Status = TranscodeStatusCached
		info.Progress = 1.0
		s.markCached(absPath)
		return info
	}

	// 3) 都没在跑 → 算 failed(可能是上次失败留下的状态,或从未启动)
	info.Status = TranscodeStatusFailed
	info.Error = "transcode not started"
	return info
}

// Cancel 取消正在跑的转码(同一 path)。
//
// 临时输出由生成流程清理，已发布缓存不受影响。
// 取消后任务状态变为 TranscodeStatusFailed，前端可以再次触发。
func (s *TranscodeService) Cancel(absPath string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	job, ok := s.inflight[absPath]
	s.mu.Unlock()
	if ok && job.cancel != nil {
		job.cancel()
	}
}

// Shutdown 拒绝新转码、取消所有排队或运行中的 ffmpeg，并等待任务回收。
func (s *TranscodeService) Shutdown(ctx context.Context) error {
	if s == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	s.mu.Lock()
	s.closed = true
	jobs := make([]*transcodeJob, 0, len(s.inflight))
	for _, job := range s.inflight {
		jobs = append(jobs, job)
	}
	s.mu.Unlock()

	for _, job := range jobs {
		if job.cancel != nil {
			job.cancel()
		}
	}
	for _, job := range jobs {
		select {
		case <-job.done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

// Subscribe 订阅一次转码任务的进度事件(用于 SSE 推送)。
//
// 返回值:
//   - events:  每次进度更新 / 状态变更就 emit 一个 TranscodeInfo;
//     任务结束时 channel 关闭
//   - cancel: 取消订阅(handler 端 SSE 断开时调用,防止 channel 泄漏)
//
// 多次订阅同一个 absPath 时，每个订阅者独立收到事件。
// 排队或运行中的任务在锁内注册并发送当前快照；其他情况复用 GetStatus
// 校验当前缓存与能力，发送一次终态快照后关闭，不保留已结束任务的订阅。
// cancel 可重复调用，移除订阅并关闭对应通道。
func (s *TranscodeService) Subscribe(absPath string) (<-chan TranscodeInfo, func()) {
	events := make(chan TranscodeInfo, 8)
	for {
		if s != nil {
			s.mu.Lock()
			job, ok := s.inflight[absPath]
			if ok && !s.closed {
				job.mu.Lock()
				if job.status == TranscodeStatusQueued || job.status == TranscodeStatusRunning {
					job.subs = append(job.subs, events)
					events <- TranscodeInfo{Status: job.status, Progress: job.progress}
					job.mu.Unlock()
					s.mu.Unlock()
					return events, func() {
						job.mu.Lock()
						defer job.mu.Unlock()
						for i, ch := range job.subs {
							if ch == events {
								job.subs = slices.Delete(job.subs, i, i+1)
								close(events)
								return
							}
						}
					}
				}
				job.mu.Unlock()
			}
			s.mu.Unlock()
		}

		// 探测和磁盘检查在锁外执行。检查期间出现活动任务时，回到锁内
		// 注册，避免把一个活动快照当作终态发出并遗漏后续进度。
		info := s.GetStatus(absPath)
		if info.Status == TranscodeStatusQueued || info.Status == TranscodeStatusRunning {
			continue
		}
		events <- info
		close(events)
		return events, func() {}
	}
}

// ClearCache 清空整个转码缓存目录,返回删除文件数和释放字节数。
//
// 与 VideoFaststartService.ClearCache / ThumbnailService.ClearAll 对齐:
// 即使目录为空也返回 (0, 0, nil),前端能拿到确定的"无操作"结果。
//
// 关键差异:除了删盘,还要清掉内存 cached map(已 transcode 完成的
// 路径集合,避免下次访问时 stat 命中后被误判为"已缓存"而读不到文件
// ——stat 是会读盘,但 cached 命中跳过 stat 也可能踩到刚删的窗口)。
func (s *TranscodeService) ClearCache() (deleted int, freedBytes int64, err error) {
	if s == nil || s.cacheDir == "" {
		return 0, 0, nil
	}
	dir := filepath.Join(s.cacheDir, "video-transcode")
	if _, statErr := os.Stat(dir); os.IsNotExist(statErr) {
		return 0, 0, nil
	}
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() {
			return nil
		}
		fi, infoErr := d.Info()
		if infoErr != nil {
			return nil
		}
		freedBytes += fi.Size()
		deleted++
		return nil
	})
	s.mu.Lock()
	s.cached = make(map[string]struct{})
	s.mu.Unlock()
	if rmErr := os.RemoveAll(dir); rmErr != nil {
		return deleted, freedBytes, rmErr
	}
	return deleted, freedBytes, nil
}

// CacheStats 当前转码缓存的占用快照(给前端 / 调试用)。
type CacheStats struct {
	Path       string `json:"path"`
	TotalBytes int64  `json:"totalBytes"`
	FileCount  int    `json:"fileCount"`
}

// CacheStats 返回当前 video-transcode 子目录的占用。
//
// 复用 walkDir 遍历(同 cache_stats.go 的实现);maxAgeDays=0 表示不过滤。
// 实际查哪些文件是 "过期" 留给 Evict 决定,这里只统计总占用。
func (s *TranscodeService) CacheStats() CacheStats {
	stats := CacheStats{Path: filepath.Join(s.cacheDir, "video-transcode")}
	if s == nil || s.cacheDir == "" {
		return stats
	}
	_ = filepath.WalkDir(stats.Path, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		fi, ferr := d.Info()
		if ferr != nil {
			return nil
		}
		stats.TotalBytes += fi.Size()
		stats.FileCount++
		return nil
	})
	return stats
}

// Evict 按 (modTime ASC) 顺序删 cache 文件,直到当前总大小 <= maxBytes。
//
// 参数:
//   - maxBytes: 目标上限(字节);0 = 不限制
//   - maxAgeDays: 删掉比这更老的文件;0 = 不按年龄
//
// 至少一个 > 0 才有意义;两个都给 0 就是 noop。
//
// 返回值:删了几个文件、释放多少字节、出错信息(非致命,继续尝试后面的)。
//
// 设计:
//   - LRU(modTime 近似访问时间;其实 ffmpeg -c copy 后 mtime = 转码完成时间;
//     实际经验上用户重新访问后会从 cache 加载,效果是"长时间没用的先删")
//   - 不持锁做 IO,只锁 inflight 短暂查询
//   - 单次最多删 maxFilesPerCall 文件,避免一个请求卡很久(默认 200,
//     大概 5s 内能完)
func (s *TranscodeService) Evict(maxBytes int64, maxAgeDays int) (deleted int, freedBytes int64, err error) {
	if s == nil || s.cacheDir == "" {
		return 0, 0, nil
	}
	if maxBytes <= 0 && maxAgeDays <= 0 {
		return 0, 0, nil
	}
	dir := filepath.Join(s.cacheDir, "video-transcode")
	if _, serr := os.Stat(dir); os.IsNotExist(serr) {
		return 0, 0, nil
	}

	// 收集所有文件 + mtime
	type entry struct {
		path string
		size int64
		mod  time.Time
	}
	var entries []entry
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() {
			return nil
		}
		fi, ferr := d.Info()
		if ferr != nil {
			return nil
		}
		entries = append(entries, entry{path: p, size: fi.Size(), mod: fi.ModTime()})
		return nil
	})

	// 1) 按 maxAgeDays 删
	if maxAgeDays > 0 {
		cutoff := time.Now().Add(-time.Duration(maxAgeDays) * 24 * time.Hour)
		for _, e := range entries {
			if e.mod.Before(cutoff) {
				if rerr := os.Remove(e.path); rerr == nil {
					deleted++
					freedBytes += e.size
				}
			}
		}
	}

	// 重新收集(删过的就跳过)
	if deleted > 0 {
		entries = entries[:0]
		_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil || d.IsDir() {
				return nil
			}
			fi, ferr := d.Info()
			if ferr != nil {
				return nil
			}
			entries = append(entries, entry{path: p, size: fi.Size(), mod: fi.ModTime()})
			return nil
		})
	}

	// 2) 按 maxBytes 删(从最老开始)
	if maxBytes > 0 {
		// 当前总大小
		var total int64
		for _, e := range entries {
			total += e.size
		}
		if total > maxBytes {
			// 排序:最老(小 modTime)在前
			sort.Slice(entries, func(i, j int) bool {
				return entries[i].mod.Before(entries[j].mod)
			})
			for _, e := range entries {
				if total <= maxBytes {
					break
				}
				if rerr := os.Remove(e.path); rerr == nil {
					deleted++
					freedBytes += e.size
					total -= e.size
				}
			}
		}
	}

	// 清理 in-memory cache(可能指向被删的文件)
	if deleted > 0 {
		s.mu.Lock()
		s.cached = make(map[string]struct{})
		s.mu.Unlock()
	}

	return deleted, freedBytes, nil
}

// ---- 内部 ----

// needsTranscode 判断"浏览器原生是否能播这个文件"。
//
// V1 保守策略:不在"已知支持列表"里的就转。判定表见
// docs/ARCHITECTURE.md §2.4.1。
func (s *TranscodeService) needsTranscode(absPath, ext string) bool {
	// 没 info service 就保守按"需要转"
	if s.info == nil || !s.info.Available() {
		return true
	}
	meta, err := s.info.Probe(absPath)
	if err != nil || meta == nil {
		// 探测失败:保守按"需要转"
		return true
	}
	codec := strings.ToLower(meta.Codec)
	container := strings.ToLower(meta.Container)

	// 已知浏览器可播的组合(2026 年中)
	switch codec {
	case "h264":
		// H.264 在 mp4/m4v/mov/mkv 上基本都行
		return false
	case "vp8", "vp9":
		// WebM 容器原生支持,mp4 容器里 VP9 也能播
		return false
	case "av1":
		// AV1 在 webm 上是默认组合,mp4 上浏览器支持不一
		// 保守:mp4/m4v/mov 里要转,webm 不用
		if strings.Contains(container, "webm") {
			return false
		}
		return true
	case "hevc", "h265":
		// Safari 支持,Chrome/Edge 不行
		return true
	case "prores":
		return true
	default:
		// 未知 codec:保守按需要转
		return true
	}
}

// cacheKey 派生缓存 key(profile 名称参与,不同 profile 互不污染)。
func (s *TranscodeService) cacheKey(absPath string, fi os.FileInfo) string {
	h := md5.New()
	fmt.Fprintf(h, "tx:%s|%d|%d|%s",
		absPath, fi.ModTime().UnixNano(), fi.Size(), s.profile.Name)
	return hex.EncodeToString(h.Sum(nil))
}

// cachePathFor 缓存文件绝对路径。
func (s *TranscodeService) cachePathFor(key string) string {
	return filepath.Join(s.cacheDir, "video-transcode", key+".mp4")
}

// markCached 记录已成功缓存(纯内存,避免重复 stat)。
func (s *TranscodeService) markCached(absPath string) {
	s.mu.Lock()
	s.cached[absPath] = struct{}{}
	s.mu.Unlock()
}

// ensureRunning 启动或复用一次转码任务。
//
// 并发闸:
//  1. sem 槽位空 → 立刻开 ffmpeg 进程
//  2. sem 满   → 状态 TranscodeStatusQueued,等前面的让出槽位
//
// singleflight 防止同一 key 在 10 个并发请求下启动 10 个 ffmpeg 进程。
// 第一次调用开 ffmpeg,后续调用复用同一个 inflight job。
//
// 注意:已完成(成功或失败)的 inflight entry 不能复用 —— 调用方
// 应该走 Resolve() 顶部的 cache hit / file mtime 改变路径。
// 如果到这里发现 inflight 已 done,等价于没有 inflight,直接开新任务。
func (s *TranscodeService) ensureRunning(absPath, cachePath string, fi os.FileInfo) (string, TranscodeStatus) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return absPath, TranscodeStatusUnavailable
	}
	if job, ok := s.inflight[absPath]; ok {
		// 已结束?清掉重新开(防止 mtime 变了之后用旧 job 误导状态)
		select {
		case <-job.done:
			delete(s.inflight, absPath)
		default:
			job.mu.Lock()
			status := job.status
			job.mu.Unlock()
			s.mu.Unlock()
			return absPath, status
		}
	}
	s.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), s.timeout)
	// 占位(防止 race:两个 ensureRunning 同时进来都会拿到 inflight=nil)
	job := &transcodeJob{
		cancel: cancel,
		done:   make(chan struct{}),
		status: TranscodeStatusQueued,
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		cancel()
		return absPath, TranscodeStatusUnavailable
	}
	if existing, ok := s.inflight[absPath]; ok {
		s.mu.Unlock()
		cancel()
		existing.mu.Lock()
		status := existing.status
		existing.mu.Unlock()
		return absPath, status
	}
	s.inflight[absPath] = job
	s.mu.Unlock()

	// 异步执行
	go func() {
		defer cancel()
		defer close(job.done)
		defer s.broadcast(job)

		// 等 sem 槽位
		select {
		case s.sem <- struct{}{}:
		case <-ctx.Done():
			job.mu.Lock()
			job.status = TranscodeStatusFailed
			job.err = ctx.Err()
			job.mu.Unlock()
			return
		}
		defer func() { <-s.sem }()

		// 拿到槽位,开始转码
		job.mu.Lock()
		job.status = TranscodeStatusRunning
		job.mu.Unlock()
		s.broadcast(job) // 状态变 Running,推给订阅者
		// 懒加载:首次转码时再选编码器
		_ = s.resolveCodec()
		err := s.transcode(ctx, absPath, cachePath, fi, job)
		if err != nil {
			job.mu.Lock()
			job.status = TranscodeStatusFailed
			job.err = err
			job.mu.Unlock()
		} else {
			job.mu.Lock()
			job.status = TranscodeStatusCached
			job.mu.Unlock()
			s.markCached(absPath)
		}
		// 进度置 1.0 让 GetStatus / SSE 看到完成
		job.mu.Lock()
		job.progress = 1.0
		job.mu.Unlock()
	}()

	// 第一次进来:从 job 拿当前 status
	job.mu.Lock()
	status := job.status
	job.mu.Unlock()
	if status == TranscodeStatusQueued {
		return absPath, TranscodeStatusQueued
	}
	return absPath, TranscodeStatusRunning
}

func (s *TranscodeService) isClosed() bool {
	if s == nil {
		return true
	}
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	return closed
}

// transcode 跑 ffmpeg 真正转码。
//
// progress 通过 -progress pipe:1 走 stdout,ffmpeg 每隔 ~0.5s 输出一行
// progress=continue / out_time_ms=N;V1 只取 out_time_ms / duration 算比值,
// 写回 job.progress 字段并广播给订阅者(SSE)。
//
// 使用独占临时文件，校验成功后在同目录原子发布；失败只清理本次临时文件，
// 不删除或改写最终路径上的其他条目。
func (s *TranscodeService) transcode(
	ctx context.Context,
	srcPath, dstPath string,
	fi os.FileInfo,
	job *transcodeJob,
) error {
	tmpPath, err := newVideoCacheTemp(dstPath)
	if err != nil {
		return fmt.Errorf("create transcode temporary file: %w", err)
	}
	// 成功 rename 后为 no-op；取消、超时或 ffmpeg 失败时清理半成品。
	defer os.Remove(tmpPath)

	// 估算总时长,用于算 progress
	var totalDurNS float64
	if s.info != nil && s.info.Available() {
		if meta, err := s.info.Probe(srcPath); err == nil && meta != nil && meta.DurationSec > 0 {
			totalDurNS = meta.DurationSec
		}
	}

	// 构造 ffmpeg 参数
	preset := presetForCodec(s.profile.VideoCodec, s.profile.Preset)
	args := []string{
		"-hide_banner",
		"-nostdin",
		"-loglevel", "error",
		"-y", // 覆盖
		"-i", srcPath,
		"-c:v", s.profile.VideoCodec,
	}
	if preset != "" {
		args = append(args, "-preset", preset)
	}
	args = append(args,
		"-crf", fmt.Sprintf("%d", s.profile.CRF),
		"-pix_fmt", "yuv420p",
		"-c:a", s.profile.AudioCodec,
		"-b:a", s.profile.AudioBitrate,
		"-movflags", "+faststart",
		"-progress", "pipe:1",
		"-f", "mp4",
		tmpPath, // 先写 .tmp,成功后原子 rename 到 dstPath
	)
	if s.profile.VideoBitrate != "" {
		// CRF + bitrate 同时给 ffmpeg 时,bitrate 是目标上限;V1 简化,
		// 留 -crf 就行,profile 里有 bitrate 也不强制用
	}
	if s.profile.MaxHeight > 0 {
		// scale 滤镜:保持比例缩到 maxHeight 以内
		args = append(args, "-vf", fmt.Sprintf("scale='trunc(ih*dar/2)*2':'min(ih,%d)':force_original_aspect_ratio=decrease", s.profile.MaxHeight))
	}

	cmd := exec.CommandContext(ctx, s.ffmpeg, args...)

	// stdout = -progress 输出,stderr = ffmpeg 错误信息
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		// 进程没起来 → unavailable 类
		return fmt.Errorf("%w: %s", ErrTranscodeUnavailable, err.Error())
	}

	// 解析 -progress 输出。必须等待读取协程退出后才能发布终态并关闭
	// subscriber，否则最后一条进度可能向已关闭 channel 发送。
	progressDone := make(chan struct{})
	go func() {
		defer close(progressDone)
		buf := make([]byte, 4096)
		var carry strings.Builder
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				carry.Write(buf[:n])
				for {
					line, rest, ok := splitLine(carry.String())
					if !ok {
						break
					}
					carry.Reset()
					carry.WriteString(rest)
					parseProgressLine(line, totalDurNS, job, s)
				}
			}
			if err != nil {
				return
			}
		}
	}()

	err = cmd.Wait()
	<-progressDone
	if err != nil {
		if ctx.Err() != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return fmt.Errorf("transcode timeout: %w", ctx.Err())
			}
			return fmt.Errorf("transcode cancelled: %w", ctx.Err())
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("transcode failed: %s", msg)
	}

	// 校验输出文件
	if _, err := statVideoCache(tmpPath); err != nil {
		return fmt.Errorf("transcode produced invalid output: %w", err)
	}
	// 原子 rename:dstPath 只会以完整形式出现,不会被读到半截文件
	if err := os.Rename(tmpPath, dstPath); err != nil {
		return fmt.Errorf("rename transcode output: %w", err)
	}
	return nil
}

// splitLine 取第一行 + 剩余 buffer,没换行就返回 ok=false 让外层继续累积。
func splitLine(s string) (line, rest string, ok bool) {
	idx := strings.IndexByte(s, '\n')
	if idx < 0 {
		return "", s, false
	}
	return s[:idx], s[idx+1:], true
}

// parseProgressLine 解析 ffmpeg -progress 输出的一行,写回 job.progress
// 并通过 service.broadcast 推给所有订阅者。
//
// ffmpeg -progress 格式是 key=value 块,块之间有空行 + progress=continue/end。
// 例:
//
//	frame=123
//	fps=24.5
//	out_time_ms=5120000  ← 微秒
//	progress=continue
func parseProgressLine(line string, totalDurSec float64, job *transcodeJob, svc *TranscodeService) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "out_time_ms=") {
		return
	}
	raw := strings.TrimPrefix(line, "out_time_ms=")
	// ffmpeg 偶尔会输出 N/A,跳过
	if raw == "N/A" || raw == "" {
		return
	}
	// 解析为微秒整数
	var us int64
	if _, err := fmt.Sscanf(raw, "%d", &us); err != nil {
		return
	}
	var ratio float64
	if totalDurSec <= 0 {
		// 没有总时长,无法算精确 progress,给个"在跑"的占位值
		ratio = 0.5
	} else {
		cur := float64(us) / 1_000_000
		ratio = cur / totalDurSec
		if ratio < 0 {
			ratio = 0
		}
		if ratio > 1 {
			ratio = 1
		}
	}
	// 写回 job + 广播(给 SSE 订阅者)
	job.mu.Lock()
	job.progress = ratio
	job.mu.Unlock()
	svc.broadcast(job)
}

// broadcast 把当前 job 状态发到所有订阅者,非阻塞。
//
// 设计:
//   - 每次状态变更(Queued→Running→Cached/Failed)调一次
//   - 每次 progress 更新也调一次(频次 = ffmpeg -progress 输出频次,约 0.5s)
//   - 订阅者 channel 容量 8,满了就丢;订阅者慢不会拖慢 ffmpeg
//   - 任务结束(cached / failed)后 defer broadcast 还会跑一次,
//     broadcast 内部判断 job.done 关闭后会关掉所有 sub channel
func (s *TranscodeService) broadcast(job *transcodeJob) {
	job.mu.Lock()
	info := TranscodeInfo{
		Status:   job.status,
		Progress: job.progress,
	}
	if job.status == TranscodeStatusFailed && job.err != nil {
		info.Error = publicTranscodeError(job.err)
	}
	isTerminal := info.Status == TranscodeStatusCached || info.Status == TranscodeStatusFailed
	if isTerminal {
		// 终态投递和关闭都在 job 锁内完成，Subscribe/取消订阅无法与之
		// 交错。缓冲区满时丢弃最旧进度，保证终态一定进入队列。
		for _, ch := range job.subs {
			select {
			case ch <- info:
			default:
				select {
				case <-ch:
				default:
				}
				ch <- info
			}
			close(ch)
		}
		job.subs = nil
		job.mu.Unlock()
		return
	}

	// 进度发送同样持有 job 锁，避免终态或取消关闭通道后再发送。
	for _, ch := range job.subs {
		select {
		case ch <- info:
		default:
			// 订阅者慢,丢掉这次更新;下次更新会覆盖
		}
	}
	job.mu.Unlock()
}

// publicTranscodeError 将内部命令错误映射为稳定且不包含本地路径的公开文案。
func publicTranscodeError(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "transcode cancelled"
	case errors.Is(err, context.DeadlineExceeded):
		return "transcode timeout"
	case errors.Is(err, ErrTranscodeUnavailable):
		return "transcode unavailable"
	default:
		return "transcode failed"
	}
}
