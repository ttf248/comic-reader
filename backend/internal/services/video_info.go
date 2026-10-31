package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

// ErrProbeUnavailable 表示 ffprobe 不可用(可执行文件不存在 / 解析失败)。
// 调用方应回退到"不依赖元数据"的展示(由前端 <video> 加载后上报)。
var ErrProbeUnavailable = errors.New("ffprobe unavailable")

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

// Available 返回 ffprobe 是否可用(整个 service 生命周期只探测一次)。
func (s *VideoInfoService) Available() bool {
	if s == nil || s.ffprobePath == "" {
		return false
	}
	s.availOnce.Do(func() {
		cmd := exec.Command(s.ffprobePath, "-version")
		s.avail = cmd.Run() == nil
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
	if out.Format.Duration != "" {
		var d float64
		if _, err := fmt.Sscanf(out.Format.Duration, "%f", &d); err == nil {
			meta.DurationSec = d
		}
	}
	if out.Format.BitRate != "" {
		var br int64
		if _, err := fmt.Sscanf(out.Format.BitRate, "%d", &br); err == nil {
			meta.BitRate = br
		}
	}
	return meta, nil
}

// probeViaFFmpeg 是 ffprobe 不可用时的回退:跑 `ffmpeg -i` 解析 stdout。
//
// ffmpeg -i 在没有指定输出文件时 exit code = 1,但 stderr 仍包含完整
// metadata。所以这里忽略 exit code,只解析输出。
func (s *VideoInfoService) probeViaFFmpeg(ctx context.Context, absPath string) (*VideoMetadata, error) {
	if s.ffmpegPath == "" {
		return nil, ErrProbeUnavailable
	}
	cmd := exec.CommandContext(ctx, s.ffmpegPath, "-i", absPath)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	_ = cmd.Run()
	return parseFFmpegInfoOutput(out.String())
}

// parseFFmpegInfoOutput 从 `ffmpeg -i <file>` 的输出中解析元数据。
// 失败返回 ErrProbeUnavailable(格式异常时调用方应忽略,继续展示).
func parseFFmpegInfoOutput(s string) (*VideoMetadata, error) {
	meta := &VideoMetadata{}
	// Duration: 00:00:12.34
	if idx := strings.Index(s, "Duration:"); idx >= 0 {
		rest := s[idx+len("Duration:"):]
		if c := strings.Index(rest, ","); c > 0 {
			rest = rest[:c]
		}
		rest = strings.TrimSpace(rest)
		var h, m, sec float64
		if _, err := fmt.Sscanf(rest, "%f:%f:%f", &h, &m, &sec); err == nil {
			meta.DurationSec = h*3600 + m*60 + sec
		}
	}
	// Video: h264 (High) ... 1920x1080 [... ... ...]
	// 取第一个 "Video:" 段和形如 "1920x1080" 的尺寸
	if idx := strings.Index(s, "Video:"); idx >= 0 {
		rest := s[idx+len("Video:"):]
		// 截到换行
		if nl := strings.Index(rest, "\n"); nl > 0 {
			rest = rest[:nl]
		}
		// 找 "NxN" 模式
		var w, h int
		if _, err := fmt.Sscanf(rest, "%*s%*s%d%*s%d", &w, &h); err == nil && w > 0 && h > 0 {
			meta.Width = w
			meta.Height = h
		}
		// codec 在 "Video:" 之后第一个词
		fields := strings.Fields(rest)
		if len(fields) > 0 {
			meta.Codec = strings.ToLower(fields[0])
		}
	}
	// Input #0, matroska,webm, ... → container
	if idx := strings.Index(s, "Input #"); idx >= 0 {
		rest := s[idx:]
		if c := strings.Index(rest, ","); c > 0 {
			rest = rest[:c]
		}
		rest = strings.TrimPrefix(rest, "Input #0, ")
		rest = strings.TrimSpace(rest)
		meta.Container = strings.ToLower(strings.SplitN(rest, ",", 2)[0])
	}
	// bitrate: "bitrate: 1234 kb/s" 出现在 Stream 行
	if idx := strings.Index(s, "bitrate:"); idx >= 0 {
		rest := s[idx+len("bitrate:"):]
		if nl := strings.Index(rest, "\n"); nl > 0 {
			rest = rest[:nl]
		}
		rest = strings.TrimSpace(rest)
		// "1234 kb/s" / "1.5 Mb/s"
		var br float64
		var unit string
		if _, err := fmt.Sscanf(rest, "%f %s", &br, &unit); err == nil {
			switch strings.ToLower(unit) {
			case "kb/s":
				meta.BitRate = int64(br * 1000)
			case "mb/s":
				meta.BitRate = int64(br * 1000 * 1000)
			case "b/s":
				meta.BitRate = int64(br)
			}
		}
	}
	if meta.Width == 0 && meta.Height == 0 && meta.DurationSec == 0 {
		// 完全没解析出任何元数据 → 视为"探测失败"但非"工具不可用",
		// 区别于 ErrProbeUnavailable(ffmpeg/ffprobe 自己坏掉)。
		// 调用方一般按"无元数据"处理:不展示时长,不报错。
		return nil, errors.New("ffprobe: no metadata parsed from output")
	}
	return meta, nil
}
