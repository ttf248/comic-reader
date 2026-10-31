package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	lru "github.com/hashicorp/golang-lru/v2"
	"golang.org/x/sync/singleflight"
)

// VideoMetadata 视频元数据(从 ffprobe / ffmpeg 解析得到)。
//
// 字段含义参考 ffprobe `-show_streams -show_format` 输出:
//   - Width/Height  : 视频流实际像素尺寸(0 表示没有视频流,纯音频)
//   - DurationSec   : 总时长(秒,0 = 解析失败)
//   - Codec         : 视频编码(avc1 / hev1 / vp9 ...),小写
//   - Container     : 容器格式(mp4 / matroska / mov ...),小写
//   - BitRate       : 容器层比特率(bps;0 = 容器未声明)
//
// 这套字段够前端做:封面尺寸估计、播放前时长显示、"格式不支持"提示。
type VideoMetadata struct {
	Width       int     `json:"width"`
	Height      int     `json:"height"`
	DurationSec float64 `json:"durationSec"`
	Codec       string  `json:"codec"`
	Container   string  `json:"container"`
	BitRate     int64   `json:"bitRate"`
}

// ErrProbeUnavailable 表示没有可用的元数据探测工具。
// 调用方应回退到"不依赖元数据"的展示(由前端 <video> 加载后上报)。
var ErrProbeUnavailable = errors.New("video metadata tools unavailable")

const videoInfoCacheSize = 512

type videoInfoCacheKey struct {
	path     string
	size     int64
	modified int64
}

// VideoInfoService 用 ffprobe / ffmpeg -i 读视频元数据。
//
// 成功结果按文件路径、大小和修改时间缓存；同一指纹的并发查询共享探测。
// 缓存最多 512 项，失败保持可重试。
//
// 失败兜底:ffprobe 不在 / 失败时回退到 ffmpeg -i 解析 stdout。
// 两个都失败时返回错误，由调用方展示基础信息或回退到前端上报。
type VideoInfoService struct {
	ffmpegPath  string
	ffprobePath string
	timeout     time.Duration

	// 工具可用性在服务生命周期内只探测一次；修改工具路径后重启会重建服务。
	availOnce sync.Once
	avail     bool

	cacheMu         sync.Mutex
	cache           *lru.Cache[videoInfoCacheKey, VideoMetadata]
	cacheGeneration uint64
	probes          singleflight.Group
}

// VideoInfoOptions 构造选项。
type VideoInfoOptions struct {
	FFmpegPath  string
	FFprobePath string
	Timeout     time.Duration // 单次查询超时,默认 5s(只读 metadata,通常 100ms 内)
}

// NewVideoInfoService 构造。
func NewVideoInfoService(opts VideoInfoOptions) *VideoInfoService {
	t := opts.Timeout
	if t <= 0 {
		t = 5 * time.Second
	}
	ffprobe := opts.FFprobePath
	if ffprobe == "" && opts.FFmpegPath != "" {
		dir := filepath.Dir(opts.FFmpegPath)
		base := "ffprobe"
		if strings.HasSuffix(strings.ToLower(opts.FFmpegPath), ".exe") {
			base = "ffprobe.exe"
		}
		ffprobe = filepath.Join(dir, base)
	}
	cache, _ := lru.New[videoInfoCacheKey, VideoMetadata](videoInfoCacheSize)
	return &VideoInfoService{
		ffmpegPath:  opts.FFmpegPath,
		ffprobePath: ffprobe,
		timeout:     t,
		cache:       cache,
	}
}

// Available 返回 ffprobe 或 ffmpeg 是否可用，整个服务生命周期只探测一次。
func (s *VideoInfoService) Available() bool {
	if s == nil {
		return false
	}
	s.availOnce.Do(func() {
		for _, path := range []string{s.ffprobePath, s.ffmpegPath} {
			if path == "" {
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), s.timeout)
			err := exec.CommandContext(ctx, path, "-version").Run()
			cancel()
			if err == nil {
				s.avail = true
				return
			}
		}
	})
	return s.avail
}

// FFprobePath 返回构造时设置的 ffprobe 路径(供日志 / 调试用)。
func (s *VideoInfoService) FFprobePath() string {
	if s == nil {
		return ""
	}
	return s.ffprobePath
}

// Probe 读视频元数据。
//
// 错误:
//   - ErrProbeUnavailable: ffprobe 不可用,调用方回退
//   - 其它:解析失败 / 文件损坏,调用方一般按"无元数据"处理
func (s *VideoInfoService) Probe(absPath string) (*VideoMetadata, error) {
	if s == nil {
		return nil, ErrProbeUnavailable
	}
	key, err := videoInfoFingerprint(absPath)
	if err != nil {
		return nil, err
	}
	s.cacheMu.Lock()
	generation := s.cacheGeneration
	cached, ok := s.cache.Get(key)
	s.cacheMu.Unlock()
	if ok {
		return &cached, nil
	}

	flightKey := strconv.FormatUint(generation, 10) + "\x00" + key.path + "\x00" + strconv.FormatInt(key.size, 10) + "\x00" + strconv.FormatInt(key.modified, 10)
	value, err, _ := s.probes.Do(flightKey, func() (any, error) {
		// 缓存命中与探测入组之间可能已有其他请求完成。
		s.cacheMu.Lock()
		cached, ok := s.cache.Get(key)
		currentGeneration := s.cacheGeneration
		s.cacheMu.Unlock()
		if ok && currentGeneration == generation {
			return cached, nil
		}
		meta, err := s.probeUncached(key.path)
		if err != nil {
			return nil, err
		}
		if meta == nil {
			return nil, ErrProbeUnavailable
		}
		// 只缓存稳定文件的成功结果；清空前启动的探测不能回填新一代缓存。
		current, statErr := videoInfoFingerprint(key.path)
		if statErr == nil && current == key {
			s.cacheMu.Lock()
			if s.cacheGeneration == generation {
				s.cache.Add(key, *meta)
			}
			s.cacheMu.Unlock()
		}
		return *meta, nil
	})
	if err != nil {
		return nil, err
	}
	meta := value.(VideoMetadata)
	return &meta, nil
}

// ClearCache 清空内存摘要；正在执行的旧探测仍可完成，但不会重新填充缓存。
func (s *VideoInfoService) ClearCache() {
	if s == nil {
		return
	}
	s.cacheMu.Lock()
	s.cacheGeneration++
	s.cache.Purge()
	s.cacheMu.Unlock()
}

func videoInfoFingerprint(path string) (videoInfoCacheKey, error) {
	path = filepath.Clean(path)
	info, err := os.Stat(path)
	if err != nil {
		var pathErr *os.PathError
		if errors.As(err, &pathErr) {
			err = pathErr.Err
		}
		return videoInfoCacheKey{}, fmt.Errorf("read video source: %w", err)
	}
	if !info.Mode().IsRegular() {
		return videoInfoCacheKey{}, errors.New("video source is not a regular file")
	}
	return videoInfoCacheKey{path: path, size: info.Size(), modified: info.ModTime().UnixNano()}, nil
}

func (s *VideoInfoService) probeUncached(absPath string) (*VideoMetadata, error) {
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout)
	defer cancel()

	if s.ffprobePath != "" {
		if m, err := s.probeViaFFprobe(ctx, absPath); err == nil {
			return m, nil
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		// 失败回退到 ffmpeg
	}
	if s.ffmpegPath == "" {
		return nil, ErrProbeUnavailable
	}
	return s.probeViaFFmpeg(ctx, absPath)
}

type ffprobeOutput struct {
	Streams []struct {
		CodecType string `json:"codec_type"`
		CodecName string `json:"codec_name"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
	} `json:"streams"`
	Format struct {
		FormatName string `json:"format_name"`
		Duration   string `json:"duration"`
		BitRate    string `json:"bit_rate"`
	} `json:"format"`
}

func (s *VideoInfoService) probeViaFFprobe(ctx context.Context, absPath string) (*VideoMetadata, error) {
	if s.ffprobePath == "" {
		return nil, ErrProbeUnavailable
	}
	cmd := exec.CommandContext(ctx, s.ffprobePath,
		"-v", "error",
		"-show_format",
		"-show_streams",
		"-of", "json",
		absPath,
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		// 进程没启动(exec 阶段失败:路径找不到 / 权限不足)→ ErrProbeUnavailable
		// 进程跑了但 exit != 0(文件损坏 / 容器不识别) → 具体错误
		if cmd.ProcessState == nil {
			return nil, fmt.Errorf("%w: %s", ErrProbeUnavailable, err.Error())
		}
		errStr := strings.TrimSpace(stderr.String())
		if errStr == "" {
			errStr = err.Error()
		}
		return nil, fmt.Errorf("ffprobe: %s", errStr)
	}
	var out ffprobeOutput
	if err := json.Unmarshal(stdout.Bytes(), &out); err != nil {
		return nil, fmt.Errorf("ffprobe: parse json: %w", err)
	}
	meta := &VideoMetadata{Container: strings.ToLower(out.Format.FormatName)}
	// 取第一个视频流
	for _, st := range out.Streams {
		if st.CodecType == "video" {
			meta.Width = st.Width
			meta.Height = st.Height
			meta.Codec = strings.ToLower(st.CodecName)
			break
		}
	}
	if duration, ok := metadataNumber(out.Format.Duration); ok {
		meta.DurationSec = duration
	}
	if bitRate, err := strconv.ParseInt(out.Format.BitRate, 10, 64); err == nil && bitRate >= 0 {
		meta.BitRate = bitRate
	}
	return meta, nil
}

// probeViaFFmpeg 是 ffprobe 不可用时的回退，解析 ffmpeg -i 的标准错误输出。
//
// ffmpeg -i 在没有指定输出文件时 exit code = 1,但 stderr 仍包含完整
// metadata。所以这里忽略 exit code,只解析输出。
func (s *VideoInfoService) probeViaFFmpeg(ctx context.Context, absPath string) (*VideoMetadata, error) {
	if s.ffmpegPath == "" {
		return nil, ErrProbeUnavailable
	}
	cmd := exec.CommandContext(ctx, s.ffmpegPath, "-hide_banner", "-i", absPath)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil && cmd.ProcessState == nil {
		return nil, ErrProbeUnavailable
	}
	return parseFFmpegInfoOutput(out.String())
}

// parseFFmpegInfoOutput 从 `ffmpeg -i <file>` 的输出中解析元数据。
// 无法提取有效字段时返回脱敏错误，不能将工具输出中的文件路径带入响应或日志。
func parseFFmpegInfoOutput(s string) (*VideoMetadata, error) {
	meta := &VideoMetadata{}
	videoSeen, durationSeen := false, false
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Input #0, ") && meta.Container == "" {
			formats, _, ok := strings.Cut(strings.TrimPrefix(line, "Input #0, "), ", from ")
			if ok {
				meta.Container = strings.ToLower(strings.TrimSpace(formats))
			}
		}
		if strings.HasPrefix(line, "Duration:") && !durationSeen {
			durationSeen = true
			clock, rest, _ := strings.Cut(strings.TrimSpace(strings.TrimPrefix(line, "Duration:")), ",")
			meta.DurationSec = ffmpegDuration(clock)
			if _, rate, ok := strings.Cut(rest, "bitrate:"); ok {
				meta.BitRate = ffmpegBitRate(rate)
			}
		}
		if !videoSeen && strings.HasPrefix(line, "Stream #0:") {
			_, video, ok := strings.Cut(line, ": Video:")
			if !ok {
				continue
			}
			videoSeen = true
			fields := strings.Fields(video)
			if len(fields) > 0 {
				meta.Codec = strings.ToLower(strings.TrimSuffix(fields[0], ","))
			}
			for _, field := range fields {
				w, h, ok := strings.Cut(strings.Trim(field, ","), "x")
				if !ok {
					continue
				}
				width, widthErr := strconv.Atoi(w)
				height, heightErr := strconv.Atoi(h)
				if widthErr == nil && heightErr == nil && width > 0 && height > 0 {
					meta.Width, meta.Height = width, height
					break
				}
			}
		}
	}
	if meta.Width == 0 && meta.Height == 0 && meta.DurationSec == 0 {
		return nil, errors.New("no video metadata parsed from tool output")
	}
	return meta, nil
}

func metadataNumber(value string) (float64, bool) {
	number, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	return number, err == nil && number >= 0 && !math.IsNaN(number) && !math.IsInf(number, 0)
}

func ffmpegDuration(value string) float64 {
	parts := strings.Split(strings.TrimSpace(value), ":")
	if len(parts) != 3 {
		return 0
	}
	hours, hourErr := strconv.ParseUint(parts[0], 10, 32)
	minutes, minuteErr := strconv.ParseUint(parts[1], 10, 8)
	seconds, ok := metadataNumber(parts[2])
	if hourErr != nil || minuteErr != nil || minutes >= 60 || !ok || seconds >= 60 {
		return 0
	}
	return float64(hours)*3600 + float64(minutes)*60 + seconds
}

func ffmpegBitRate(value string) int64 {
	fields := strings.Fields(value)
	if len(fields) < 2 {
		return 0
	}
	rate, ok := metadataNumber(fields[0])
	if !ok {
		return 0
	}
	switch strings.ToLower(strings.TrimSuffix(fields[1], ",")) {
	case "kb/s":
		rate *= 1000
	case "mb/s":
		rate *= 1000000
	case "b/s":
	default:
		return 0
	}
	if math.IsInf(rate, 0) || rate >= math.MaxInt64 {
		return 0
	}
	return int64(rate)
}
