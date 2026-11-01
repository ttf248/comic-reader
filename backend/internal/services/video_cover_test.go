package services

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// findFFmpeg 探测 ffmpeg 路径: 优先环境变量,否则用 install 脚本的默认位置。
//
// 找不到就 skip 这些测试(对应 ffmpeg 未安装的 CI / 开发机)。
func findFFmpeg(t testing.TB) string {
	t.Helper()
	if p := os.Getenv("FFMPEG_PATH"); p != "" {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	// 1) PATH 里(开发机常见)
	if p, err := exec.LookPath("ffmpeg"); err == nil {
		return p
	}
	// 2) install 脚本默认位置(可能 cwd 是 tests/ 或 services/)
	candidates := []string{
		"../../../../bin/ffmpeg/windows/amd64/ffmpeg.exe", // 来自 services/
		"../../../bin/ffmpeg/windows/amd64/ffmpeg.exe",    // 来自 backend/
		"../../bin/ffmpeg/windows/amd64/ffmpeg.exe",       // 来自 repo root
		"/usr/bin/ffmpeg",
		"/usr/local/bin/ffmpeg",
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			abs, _ := filepath.Abs(c)
			return abs
		}
	}
	t.Skip("ffmpeg not found; skipping ffmpeg-dependent tests")
	return ""
}

// generateTestVideo 用 ffmpeg 生成一个 2 秒的彩色测试视频,返回路径。
// 测试结束后由调用方清理(在 t.TempDir 里的会自动清)。
func generateTestVideo(t testing.TB, ffmpegPath string) string {
	t.Helper()
	dir := t.TempDir()
	out := filepath.Join(dir, "test.mp4")
	// 2 秒, 320x240, 红色;50 帧 @ 25fps 足够给抽帧测试用
	cmd := exec.Command(ffmpegPath,
		"-y", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=red:s=320x240:d=2:r=25",
		"-c:v", "libx264", "-pix_fmt", "yuv420p",
		out,
	)
	if outBytes, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("generate test video: %v\n%s", err, outBytes)
	}
	return out
}

func TestVideoCoverExtractor_Available(t *testing.T) {
	ff := findFFmpeg(t)
	ex := NewVideoCoverExtractor(VideoCoverOptions{FFmpegPath: ff})
	if !ex.Available() {
		t.Errorf("expected Available()=true with valid ffmpeg path")
	}

	ex2 := NewVideoCoverExtractor(VideoCoverOptions{FFmpegPath: ""})
	if ex2.Available() {
		t.Errorf("expected Available()=false with empty ffmpeg path")
	}

	ex3 := NewVideoCoverExtractor(VideoCoverOptions{FFmpegPath: "/nonexistent/ffmpeg.exe"})
	if ex3.Available() {
		t.Errorf("expected Available()=false with nonexistent path")
	}
}

func TestFFmpegAvailableAt(t *testing.T) {
	ff := findFFmpeg(t)
	if !FFmpegAvailableAt(ff) {
		t.Error("FFmpegAvailableAt should return true for valid path")
	}
	if FFmpegAvailableAt("/nonexistent/ffmpeg") {
		t.Error("FFmpegAvailableAt should return false for invalid path")
	}
	if FFmpegAvailableAt("") {
		t.Error("FFmpegAvailableAt should return false for empty path")
	}
}

func TestVideoCoverExtractor_Extract(t *testing.T) {
	ff := findFFmpeg(t)
	vidPath := generateTestVideo(t, ff)
	ex := NewVideoCoverExtractor(VideoCoverOptions{
		FFmpegPath: ff,
		Width:      320,
		Height:     350,
		Quality:    85,
		Timeout:    10 * 1e9, // 10s
	})
	data, err := ex.Extract(vidPath)
	if err != nil {
		t.Fatalf("Extract: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("Extract returned empty data")
	}
	// 必须能解码为 JPEG
	img, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode extracted jpeg: %v", err)
	}
	// 输出尺寸 ≤ 目标(letterbox 行为:scale to fit,然后 pad)
	if img.Bounds().Dx() > 320 {
		t.Errorf("width %d > 320", img.Bounds().Dx())
	}
	if img.Bounds().Dy() > 350 {
		t.Errorf("height %d > 350", img.Bounds().Dy())
	}
}

// generateShortTestVideo 生成一段极短视频(默认 0.3s):定位点若按默认的 1s
// 会落到画面之外,ffmpeg 解不出任何帧。
func generateShortTestVideo(t testing.TB, ffmpegPath string) string {
	t.Helper()
	dir := t.TempDir()
	out := filepath.Join(dir, "short.mp4")
	cmd := exec.Command(ffmpegPath,
		"-y", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=blue:s=320x240:d=0.3:r=10",
		"-c:v", "libx264", "-pix_fmt", "yuv420p",
		out,
	)
	if outBytes, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("generate short test video: %v\n%s", err, outBytes)
	}
	return out
}

func TestVideoCoverExtractor_SeekPosition(t *testing.T) {
	ex := NewVideoCoverExtractor(VideoCoverOptions{FFmpegPath: "ffmpeg"})
	cases := []struct {
		name     string
		duration float64
		want     float64
	}{
		{"未知时长按默认 1s", 0, 1},
		{"短视频落在画面之外时取片头帧", 0.3, 0},
		{"刚好等于时长也取片头帧", 1, 0},
		{"常规视频取时长的 10%", 20, 2},
		{"时长比例不足 1s 时抬到 1s", 5, 1},
		{"时长比例超过 3s 时压到 3s", 120, 3},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ex.seekPosition(tc.duration); got != tc.want {
				t.Errorf("seekPosition(%v) = %v, want %v", tc.duration, got, tc.want)
			}
		})
	}
}

func TestVideoCoverExtractor_Extract_ShortClip(t *testing.T) {
	ff := findFFmpeg(t)
	vidPath := generateShortTestVideo(t, ff)
	ex := NewVideoCoverExtractor(VideoCoverOptions{
		FFmpegPath: ff,
		Width:      320,
		Height:     350,
		Quality:    85,
		Timeout:    10 * 1e9, // 10s
	})
	// 0.3s 的片段:定位点必须落在画面之内,否则服务端抽帧拿不到任何帧,
	// 只能退回浏览器抽帧(前端会先空轮询 20s,封面一直是坏的)。
	data, err := ex.Extract(vidPath)
	if err != nil {
		t.Fatalf("Extract short clip: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("Extract returned empty data for short clip")
	}
	if _, err := jpeg.Decode(bytes.NewReader(data)); err != nil {
		t.Fatalf("decode extracted jpeg: %v", err)
	}
}

func TestVideoCoverExtractor_Extract_NotFound(t *testing.T) {
	ff := findFFmpeg(t)
	ex := NewVideoCoverExtractor(VideoCoverOptions{FFmpegPath: ff})
	_, err := ex.Extract("/nonexistent/video.mp4")
	if err == nil {
		t.Fatal("expected error for nonexistent file")
	}
	// 不应返回 ErrFFmpegUnavailable(ffmpeg 在,只是文件没)
	if errors.Is(err, ErrFFmpegUnavailable) {
		t.Errorf("did not expect ErrFFmpegUnavailable for missing file, got: %v", err)
	}
}

func TestVideoCoverExtractor_Extract_GarbageData(t *testing.T) {
	ff := findFFmpeg(t)
	dir := t.TempDir()
	badPath := filepath.Join(dir, "garbage.mp4")
	if err := os.WriteFile(badPath, []byte("not a real video"), 0o644); err != nil {
		t.Fatal(err)
	}
	ex := NewVideoCoverExtractor(VideoCoverOptions{
		FFmpegPath: ff,
		Width:      320,
		Height:     350,
		Timeout:    5 * 1e9,
	})
	_, err := ex.Extract(badPath)
	if err == nil {
		t.Fatal("expected error for garbage video file")
	}
	// 也不应是 ErrFFmpegUnavailable(ffmpeg 在,只是文件烂)
	if errors.Is(err, ErrFFmpegUnavailable) {
		t.Errorf("did not expect ErrFFmpegUnavailable, got: %v", err)
	}
}

func TestVideoCoverExtractor_Unavailable(t *testing.T) {
	// 路径不存在的 ffmpeg:用相对于 t.TempDir 的不存在路径
	// (绝对 /nonexistent 在 Windows 上可能因权限问题行为不同)
	nonexist := filepath.Join(t.TempDir(), "no-such-ffmpeg.exe")
	ex := NewVideoCoverExtractor(VideoCoverOptions{FFmpegPath: nonexist})
	if ex.Available() {
		t.Skip("ffmpeg happens to exist at this path")
	}
	_, err := ex.Extract("/tmp/whatever.mp4")
	if !errors.Is(err, ErrFFmpegUnavailable) {
		t.Errorf("expected ErrFFmpegUnavailable, got %v", err)
	}
}

// 集成:thumbnail 服务注入 ffmpeg 后,GetOrCreate 一个真实视频,
// 应返回缩略图 JPEG(不再 ErrVideoCoverMissing)。
func TestThumbnailService_WithFFmpeg_VideoCover(t *testing.T) {
	ff := findFFmpeg(t)
	vidPath := generateTestVideo(t, ff)

	// ffprobe 也能找到(同目录)
	ffprobe := filepath.Join(filepath.Dir(ff), "ffprobe.exe")
	if _, err := os.Stat(ffprobe); err != nil {
		ffprobe = filepath.Join(filepath.Dir(ff), "ffprobe")
		if _, err := os.Stat(ffprobe); err != nil {
			ffprobe = ""
		}
	}

	ex := NewVideoCoverExtractor(VideoCoverOptions{
		FFmpegPath:  ff,
		FFprobePath: ffprobe,
		Width:       320,
		Height:      350,
		Timeout:     10 * 1e9,
	})
	svc, err := NewThumbnailService(ThumbnailOptions{
		CacheDir:   t.TempDir(),
		Width:      320,
		Height:     350,
		MaxAgeDays: 30,
		LRUSize:    100,
		VideoCover: ex,
	})
	if err != nil {
		t.Fatal(err)
	}
	data, err := svc.GetOrCreate(vidPath)
	if err != nil {
		t.Fatalf("GetOrCreate with FFmpeg: %v", err)
	}
	img, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if img.Bounds().Dx() > 320 || img.Bounds().Dy() > 350 {
		t.Errorf("thumbnail too large: %dx%d", img.Bounds().Dx(), img.Bounds().Dy())
	}
	// 二次访问应命中磁盘缓存(LRU 验证:不依赖 ffmpeg 第二次)
	data2, err := svc.GetOrCreate(vidPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, data2) {
		t.Error("second GetOrCreate should return same bytes (cache hit)")
	}
}

// 兼容性:没注入 ffmpeg 时,视频首次访问仍返回 ErrVideoCoverMissing
// (原契约),前端继续走浏览器抽帧 + 上传。
func TestThumbnailService_WithoutFFmpeg_VideoCoverStillMissing(t *testing.T) {
	svc, err := NewThumbnailService(ThumbnailOptions{
		CacheDir:   t.TempDir(),
		Width:      320,
		Height:     350,
		MaxAgeDays: 30,
		// VideoCover 故意不传
	})
	if err != nil {
		t.Fatal(err)
	}
	vidPath := filepath.Join(t.TempDir(), "v.mp4")
	os.WriteFile(vidPath, []byte("fake"), 0o644)
	_, err = svc.GetOrCreate(vidPath)
	if !errors.Is(err, ErrVideoCoverMissing) {
		t.Errorf("expected ErrVideoCoverMissing, got %v", err)
	}
}

// 验证 image 包的 import 不被无意删除(防止误删 import 触发编译错误)
var _ image.Image = (*image.RGBA)(nil)
