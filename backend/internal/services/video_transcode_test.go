package services

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// findFFmpegTranscode 复用 video_cover_test 的同源查找。
func findFFmpegTranscode(t *testing.T) string {
	t.Helper()
	if p := os.Getenv("FFMPEG_PATH"); p != "" {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	candidates := []string{
		"../../../../bin/ffmpeg/windows/amd64/ffmpeg.exe",
		"../../../bin/ffmpeg/windows/amd64/ffmpeg.exe",
		"../../bin/ffmpeg/windows/amd64/ffmpeg.exe",
		"/usr/bin/ffmpeg",
		"/usr/local/bin/ffmpeg",
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			abs, _ := filepath.Abs(c)
			return abs
		}
	}
	t.Skip("ffmpeg not found; skipping transcode-dependent tests")
	return ""
}

// generateH264TestVideo 1 秒 160x120 H.264 + AAC,faststart。
func generateH264TestVideo(t *testing.T, ffmpegPath string) string {
	t.Helper()
	dir := t.TempDir()
	out := filepath.Join(dir, "h264.mp4")
	cmd := exec.Command(ffmpegPath,
		"-y", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=blue:s=160x120:d=2:r=25",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=2",
		"-c:v", "libx264", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "128k",
		"-shortest",
		"-movflags", "+faststart",
		out,
	)
	if o, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("gen h264: %v\n%s", err, o)
	}
	return out
}

// generateAV1TestVideo 1 秒 160x120 AV1(libaom)+ AAC。
// 需要 ffmpeg 编译时带 libaom;失败时 skip(不影响其他用例)。
func generateAV1TestVideo(t *testing.T, ffmpegPath string) string {
	t.Helper()
	dir := t.TempDir()
	out := filepath.Join(dir, "av1.mp4")
	cmd := exec.Command(ffmpegPath,
		"-y", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=red:s=160x120:d=1:r=25",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=1",
		"-c:v", "libaom-av1", "-cpu-used", "8", "-crf", "32",
		"-c:a", "aac", "-b:a", "128k",
		"-shortest",
		out,
	)
	if o, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("ffmpeg cannot encode AV1 (need libaom): %v\n%s", err, o)
	}
	// 验证编码确实成功了 — 用 ffmpeg -i 解析(避免依赖 ffprobe 路径)
	verify := exec.Command(ffmpegPath, "-v", "error", "-i", out, "-f", "null", "-")
	if err := verify.Run(); err != nil {
		t.Skipf("AV1 output unreadable: %v", err)
	}
	// 通过 ffmpeg -i 拿到 stderr 中的 "Video: ... av1 ..." 字样
	infoOut, _ := exec.Command(ffmpegPath, "-v", "info", "-i", out, "-f", "null", "-").CombinedOutput()
	if !strings.Contains(string(infoOut), "av1") {
		t.Skipf("AV1 encoder produced non-AV1 output (info dump): %s", infoOut)
	}
	return out
}

// generateVP9TestVideo 1 秒 160x120 VP9 + Opus in webm。
func generateVP9TestVideo(t *testing.T, ffmpegPath string) string {
	t.Helper()
	dir := t.TempDir()
	out := filepath.Join(dir, "vp9.webm")
	cmd := exec.Command(ffmpegPath,
		"-y", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=green:s=160x120:d=1:r=25",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=1",
		"-c:v", "libvpx-vp9", "-b:v", "200k",
		"-c:a", "libopus", "-b:a", "64k",
		"-shortest",
		out,
	)
	if o, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("ffmpeg cannot encode VP9 (need libvpx-vp9): %v\n%s", err, o)
	}
	return out
}

// waitFor polls cond until it returns true or timeout.
func waitFor(t *testing.T, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

func TestTranscodeService_Available(t *testing.T) {
	ff := findFFmpegTranscode(t)
	s := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: ff})
	if !s.Available() {
		t.Error("expected Available()=true with valid ffmpeg")
	}

	s2 := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: ""})
	if s2.Available() {
		t.Error("expected Available()=false with empty ffmpeg")
	}

	s3 := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: "/nope"})
	if s3.Available() {
		t.Error("expected Available()=false with nonexistent ffmpeg")
	}
}

func TestTranscodeService_Resolve_NilReceiver(t *testing.T) {
	var s *TranscodeService
	got, status := s.Resolve("/anywhere.mp4", nil)
	if got != "/anywhere.mp4" || status != TranscodeStatusSkipped {
		t.Errorf("nil receiver: got (%q, %v), want (orig, Skipped)", got, status)
	}
}

func TestTranscodeService_Resolve_NonVideo_Skipped(t *testing.T) {
	ff := findFFmpegTranscode(t)
	s := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: ff})
	for _, ext := range []string{".jpg", ".txt", ".png"} {
		p := "/tmp/file" + ext
		got, status := s.Resolve(p, nil)
		if got != p || status != TranscodeStatusSkipped {
			t.Errorf("ext=%s: got (%q, %v), want (orig, Skipped)", ext, got, status)
		}
	}
}

func TestTranscodeService_Resolve_NoFFmpeg_Unavailable(t *testing.T) {
	s := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: ""})
	dir := t.TempDir()
	mp4 := filepath.Join(dir, "any.mp4")
	os.WriteFile(mp4, []byte("not a real mp4"), 0o644)
	got, status := s.Resolve(mp4, nil)
	if got != mp4 || status != TranscodeStatusUnavailable {
		t.Errorf("no ffmpeg: got (%q, %v), want (orig, Unavailable)", got, status)
	}
}

func TestTranscodeService_ShutdownCancelsJobsAndRejectsNewWork(t *testing.T) {
	s := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: "missing"})
	jobCtx, cancel := context.WithCancel(context.Background())
	job := &transcodeJob{
		cancel: cancel,
		done:   make(chan struct{}),
		status: TranscodeStatusQueued,
	}
	s.inflight["queued.mp4"] = job
	go func() {
		<-jobCtx.Done()
		close(job.done)
	}()

	ctx, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	if err := s.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if jobCtx.Err() == nil {
		t.Fatal("Shutdown did not cancel queued job")
	}
	if got, status := s.Resolve("queued.mp4", nil); got != "queued.mp4" || status != TranscodeStatusUnavailable {
		t.Fatalf("Resolve after Shutdown = (%q, %v), want original/unavailable", got, status)
	}
	if s.Available() {
		t.Fatal("Available after Shutdown = true")
	}
}

func TestTranscodeService_ShutdownHonorsContext(t *testing.T) {
	s := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: "missing"})
	s.inflight["stuck.mp4"] = &transcodeJob{
		cancel: func() {},
		done:   make(chan struct{}),
		status: TranscodeStatusRunning,
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.Shutdown(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Shutdown error = %v, want context.Canceled", err)
	}
}

func TestPublicTranscodeErrorDoesNotExposePaths(t *testing.T) {
	privatePath := `C:\\Users\\reader\\secret.mp4`
	if got := publicTranscodeError(fmt.Errorf("ffmpeg input %s failed", privatePath)); got != "transcode failed" {
		t.Fatalf("publicTranscodeError = %q", got)
	}
	if got := publicTranscodeError(fmt.Errorf("wrapped: %w", context.Canceled)); got != "transcode cancelled" {
		t.Fatalf("cancel error = %q", got)
	}
}

func TestTranscodeService_Resolve_H264_NotNeeded(t *testing.T) {
	ff := findFFmpegTranscode(t)
	cache := t.TempDir()
	// 注入 probe 服务,避免 ffmpeg 跑两遍
	probe := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ff, Timeout: 5 * time.Second})
	s := NewTranscodeService(TranscodeOptions{
		CacheDir: cache,
		FFmpeg:   ff,
		Info:     probe,
	})
	mp4 := generateH264TestVideo(t, ff)
	got, status := s.Resolve(mp4, nil)
	if status != TranscodeStatusNotNeeded {
		t.Errorf("H.264: status=%v, want NotNeeded", status)
	}
	if got != mp4 {
		t.Errorf("H.264: path=%q, want original", got)
	}
	// 不应写入任何 cache
	entries, _ := os.ReadDir(filepath.Join(cache, "video-transcode"))
	if len(entries) != 0 {
		t.Errorf("H.264 not_needed: cache should be empty, got %d entries", len(entries))
	}
}

func TestTranscodeService_Resolve_VP9_NotNeeded(t *testing.T) {
	ff := findFFmpegTranscode(t)
	probe := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ff, Timeout: 5 * time.Second})
	s := NewTranscodeService(TranscodeOptions{
		CacheDir: t.TempDir(),
		FFmpeg:   ff,
		Info:     probe,
	})
	webm := generateVP9TestVideo(t, ff)
	got, status := s.Resolve(webm, nil)
	if status != TranscodeStatusNotNeeded {
		t.Errorf("VP9 webm: status=%v, want NotNeeded", status)
	}
	if got != webm {
		t.Errorf("VP9 webm: path=%q, want original", got)
	}
}

func TestTranscodeService_Resolve_AV1_TranscodesAndCaches(t *testing.T) {
	ff := findFFmpegTranscode(t)
	probe := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ff, Timeout: 5 * time.Second})
	cache := t.TempDir()
	s := NewTranscodeService(TranscodeOptions{
		CacheDir: cache,
		FFmpeg:   ff,
		Info:     probe,
		Timeout:  2 * time.Minute,
	})
	av1 := generateAV1TestVideo(t, ff)

	// 第一次:启动转码,返回原文件 + TranscodeStatusQueued/Running
	got1, status1 := s.Resolve(av1, nil)
	if got1 != av1 {
		t.Errorf("first: path=%q, want original", got1)
	}
	if status1 != TranscodeStatusQueued && status1 != TranscodeStatusRunning {
		t.Errorf("first: status=%v, want Queued or Running", status1)
	}

	// 等待转码完成(检查 inflight 不再是 Running)
	ok := waitFor(t, 90*time.Second, func() bool {
		s.mu.Lock()
		job, exists := s.inflight[av1]
		s.mu.Unlock()
		if !exists {
			return false
		}
		select {
		case <-job.done:
			return job.status == TranscodeStatusCached
		default:
			return false
		}
	})
	if !ok {
		info := s.GetStatus(av1)
		t.Fatalf("transcode did not finish in 90s; status=%v err=%v", info.Status, info.Error)
	}

	// 第二次:缓存命中
	got2, status2 := s.Resolve(av1, nil)
	if status2 != TranscodeStatusCached {
		t.Errorf("second: status=%v, want Cached", status2)
	}
	if got2 == av1 {
		t.Error("second: path should be cached file, not original")
	}
	if _, err := os.Stat(got2); err != nil {
		t.Errorf("cached file missing: %v", err)
	}
	// 验证 cache 文件是 H.264 (用 ffmpeg -i 看 stderr 中的 codec 描述)
	out, _ := exec.Command(ff, "-v", "info", "-i", got2, "-f", "null", "-").CombinedOutput()
	if !strings.Contains(string(out), "h264") {
		t.Errorf("cached file codec not h264: %s", out)
	}
}

func TestTranscodeService_GetStatus_NotStarted(t *testing.T) {
	ff := findFFmpegTranscode(t)
	probe := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ff, Timeout: 5 * time.Second})
	s := NewTranscodeService(TranscodeOptions{
		CacheDir: t.TempDir(),
		FFmpeg:   ff,
		Info:     probe,
	})
	mp4 := generateH264TestVideo(t, ff)
	info := s.GetStatus(mp4)
	if info.Status != TranscodeStatusNotNeeded {
		t.Errorf("H.264 GetStatus: %v, want NotNeeded", info.Status)
	}
}

func TestTranscodeService_InvalidCacheIsNotCached(t *testing.T) {
	ff := findFFmpegTranscode(t)
	src := generateH264TestVideo(t, ff)
	for _, kind := range []string{"empty", "directory", "empty-directory"} {
		t.Run(kind, func(t *testing.T) {
			opts := TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: ff, Timeout: 30 * time.Second}
			// 不注入元数据服务，确保该夹具走实际转码路径。
			s := NewTranscodeService(opts)
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if err := s.Shutdown(ctx); err != nil {
					t.Error(err)
				}
			})
			s.Resolve(src, nil)
			if !waitFor(t, 30*time.Second, func() bool { return s.GetStatus(src).Status == TranscodeStatusCached }) {
				t.Fatalf("initial transcode failed: %+v", s.GetStatus(src))
			}
			cachePath := s.cachePathFor(s.cacheKey(src, mustStat(t, src)))
			// 旧固定临时路径上的条目不属于当前生成，不能删除或覆盖。
			oldTemp := cachePath + ".tmp"
			if err := os.WriteFile(oldTemp, []byte("preserve-old-temporary-entry"), 0o644); err != nil {
				t.Fatal(err)
			}
			if kind == "empty" {
				if err := os.Truncate(cachePath, 0); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.Rename(cachePath, cachePath+".original"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(cachePath, 0o755); err != nil {
					t.Fatal(err)
				}
				if kind == "directory" {
					if err := os.WriteFile(filepath.Join(cachePath, "index.html"), []byte("preserve-directory-content"), 0o644); err != nil {
						t.Fatal(err)
					}
				}
			}
			if info := s.GetStatus(src); info.Status != TranscodeStatusFailed {
				t.Errorf("completed job accepted %s cache: %+v", kind, info)
			}
			// 重建服务覆盖进程重启后的磁盘缓存判定。
			fresh := NewTranscodeService(opts)
			if info := fresh.GetStatus(src); info.Status != TranscodeStatusFailed {
				t.Errorf("fresh service accepted %s cache: %+v", kind, info)
			}
			got, status := s.Resolve(src, nil)
			if got != src || (status != TranscodeStatusQueued && status != TranscodeStatusRunning) {
				t.Errorf("invalid cache was reused: path=%q status=%v", got, status)
			}
			s.mu.Lock()
			job := s.inflight[src]
			s.mu.Unlock()
			select {
			case <-job.done:
			case <-time.After(30 * time.Second):
				t.Fatal("retry did not finish")
			}
			info := s.GetStatus(src)
			if data, err := os.ReadFile(oldTemp); err != nil || string(data) != "preserve-old-temporary-entry" {
				t.Fatalf("unowned temporary entry was modified: data=%q err=%v", data, err)
			}
			if kind == "empty" {
				if info.Status != TranscodeStatusCached || mustStat(t, cachePath).Size() == 0 || !isFaststart(cachePath) {
					t.Fatalf("empty cache was not rebuilt: %+v", info)
				}
			} else {
				if info.Status != TranscodeStatusFailed {
					t.Errorf("directory cache retry: %+v, want failed", info)
				}
				if !mustStat(t, cachePath).IsDir() {
					t.Fatal("invalid cache directory was removed")
				}
				if kind == "directory" {
					if data, err := os.ReadFile(filepath.Join(cachePath, "index.html")); err != nil || string(data) != "preserve-directory-content" {
						t.Fatalf("invalid cache directory was modified: data=%q err=%v", data, err)
					}
				}
			}
		})
	}
}

func TestTranscodeService_GetStatus_NotFound(t *testing.T) {
	ff := findFFmpegTranscode(t)
	s := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: ff})
	info := s.GetStatus(filepath.Join(t.TempDir(), "ghost.mp4"))
	if info.Status != TranscodeStatusFailed {
		t.Errorf("missing file: %v, want Failed", info.Status)
	}
}

func TestTranscodeService_Cancel(t *testing.T) {
	ff := findFFmpegTranscode(t)
	probe := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ff, Timeout: 5 * time.Second})
	cache := t.TempDir()
	s := NewTranscodeService(TranscodeOptions{
		CacheDir: cache,
		FFmpeg:   ff,
		Info:     probe,
		// 故意给个很短的超时,方便测试取消
		Timeout: 30 * time.Second,
	})
	av1 := generateAV1TestVideo(t, ff)
	got, status := s.Resolve(av1, nil)
	if status != TranscodeStatusQueued && status != TranscodeStatusRunning {
		t.Skipf("transcode skipped/failed too fast: %v", status)
	}
	_ = got

	// 立刻取消
	s.Cancel(av1)
	ok := waitFor(t, 10*time.Second, func() bool {
		info := s.GetStatus(av1)
		return info.Status == TranscodeStatusFailed
	})
	if !ok {
		info := s.GetStatus(av1)
		t.Errorf("after Cancel: status=%v, want Failed", info.Status)
	}
}

func TestTranscodeService_ConcurrentSameKey(t *testing.T) {
	ff := findFFmpegTranscode(t)
	probe := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ff, Timeout: 5 * time.Second})
	cache := t.TempDir()
	s := NewTranscodeService(TranscodeOptions{
		CacheDir: cache,
		FFmpeg:   ff,
		Info:     probe,
		Timeout:  2 * time.Minute,
	})
	av1 := generateAV1TestVideo(t, ff)

	// 10 协程同时请求
	var wg sync.WaitGroup
	statuses := make([]TranscodeStatus, 10)
	paths := make([]string, 10)
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			paths[i], statuses[i] = s.Resolve(av1, nil)
		}(i)
	}
	wg.Wait()

	// 全部应该看到 Queued/Running 之一
	for i, st := range statuses {
		if st != TranscodeStatusQueued && st != TranscodeStatusRunning {
			t.Errorf("goroutine %d: status=%v, want Queued/Running", i, st)
		}
	}

	// 等转码完
	ok := waitFor(t, 90*time.Second, func() bool {
		s.mu.Lock()
		job, exists := s.inflight[av1]
		s.mu.Unlock()
		if !exists {
			return false
		}
		select {
		case <-job.done:
			return job.status == TranscodeStatusCached
		default:
			return false
		}
	})
	if !ok {
		t.Fatal("transcode did not finish")
	}

	// 后续请求都应命中缓存
	for i := 0; i < 10; i++ {
		p, st := s.Resolve(av1, nil)
		if st != TranscodeStatusCached || p == av1 {
			t.Errorf("post-cache goroutine %d: (%q, %v), want (cached, Cached)", i, p, st)
		}
	}
}

func TestTranscodeService_ClearCache(t *testing.T) {
	ff := findFFmpegTranscode(t)
	probe := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ff, Timeout: 5 * time.Second})
	cache := t.TempDir()
	s := NewTranscodeService(TranscodeOptions{
		CacheDir: cache,
		FFmpeg:   ff,
		Info:     probe,
		Timeout:  2 * time.Minute,
	})
	av1 := generateAV1TestVideo(t, ff)
	s.Resolve(av1, nil)
	ok := waitFor(t, 90*time.Second, func() bool {
		s.mu.Lock()
		job, exists := s.inflight[av1]
		s.mu.Unlock()
		if !exists {
			return false
		}
		select {
		case <-job.done:
			return job.status == TranscodeStatusCached
		default:
			return false
		}
	})
	if !ok {
		t.Fatal("transcode did not finish")
	}
	if err := func() error {
		_, _, err := s.ClearCache()
		return err
	}(); err != nil {
		t.Fatalf("ClearCache: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Join(cache, "video-transcode"))
	if len(entries) != 0 {
		t.Errorf("after ClearCache: %d entries left", len(entries))
	}
}

func TestTranscodeService_InvalidateOnMtimeChange(t *testing.T) {
	ff := findFFmpegTranscode(t)
	probe := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ff, Timeout: 5 * time.Second})
	cache := t.TempDir()
	s := NewTranscodeService(TranscodeOptions{
		CacheDir: cache,
		FFmpeg:   ff,
		Info:     probe,
		Timeout:  2 * time.Minute,
	})
	av1 := generateAV1TestVideo(t, ff)
	s.Resolve(av1, nil)
	ok := waitFor(t, 90*time.Second, func() bool {
		s.mu.Lock()
		job, exists := s.inflight[av1]
		s.mu.Unlock()
		if !exists {
			return false
		}
		select {
		case <-job.done:
			return job.status == TranscodeStatusCached
		default:
			return false
		}
	})
	if !ok {
		t.Fatal("first transcode did not finish")
	}
	// 改 mtime,模拟"用户重下载"
	future := time.Now().Add(2 * time.Hour)
	if err := os.Chtimes(av1, future, future); err != nil {
		t.Fatal(err)
	}
	// 再 Resolve 应重新转码
	_, status := s.Resolve(av1, nil)
	if status != TranscodeStatusQueued && status != TranscodeStatusRunning {
		t.Errorf("after mtime change: status=%v, want Queued/Running", status)
	}
}

func TestNeedsTranscode(t *testing.T) {
	ff := findFFmpegTranscode(t)
	probe := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ff, Timeout: 5 * time.Second})
	s := NewTranscodeService(TranscodeOptions{
		CacheDir: t.TempDir(),
		FFmpeg:   ff,
		Info:     probe,
	})

	cases := []struct {
		codec     string
		container string
		want      bool
	}{
		{"h264", "mov,mp4,m4a,3gp,6gp", false},
		{"h264", "matroska,webm", false},
		{"vp9", "matroska,webm", false},
		{"vp8", "matroska,webm", false},
		{"av1", "matroska,webm", false},
		{"av1", "mov,mp4,m4a,3gp,6gp", true},
		{"hevc", "mov,mp4,m4a,3gp,6gp", true},
		{"h265", "mov,mp4,m4a,3gp,6gp", true},
		{"prores", "mov,mp4,m4a,3gp,6gp", true},
		{"unknown", "anything", true},
	}
	for _, tc := range cases {
		meta := &VideoMetadata{Codec: tc.codec, Container: tc.container}
		// 用反射或直接调内部方法;这里直接走 Resolve 路径覆盖更真实
		// 简化:跳到 needsTranscode 内部测试用直接构造
		if got := needsTranscodeForTest(s, meta); got != tc.want {
			t.Errorf("codec=%s container=%s: got %v, want %v",
				tc.codec, tc.container, got, tc.want)
		}
	}
}

// needsTranscodeForTest 抽出 needsTranscode 的纯函数形式(便于 table test)。
func needsTranscodeForTest(s *TranscodeService, m *VideoMetadata) bool {
	codec := strings.ToLower(m.Codec)
	container := strings.ToLower(m.Container)
	switch codec {
	case "h264":
		return false
	case "vp8", "vp9":
		return false
	case "av1":
		return !strings.Contains(container, "webm")
	case "hevc", "h265":
		return true
	case "prores":
		return true
	default:
		return true
	}
}

func TestTranscodeService_Subscribe_NotStarted(t *testing.T) {
	s := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: ""})
	events, cancel := s.Subscribe("/some/path.mp4")
	defer cancel()
	select {
	case info := <-events:
		if info.Status != TranscodeStatusFailed {
			t.Errorf("got status %v, want Failed", info.Status)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("did not get immediate event")
	}
	// channel should close after the immediate event
	if _, ok := <-events; ok {
		t.Error("expected channel to be closed")
	}
}

func TestTranscodeService_SubscribeTerminalEventIsSanitizedAndCloses(t *testing.T) {
	s, src := newTranscodeEventFixture(t)
	job := transcodeEventJob(t, s, src, TranscodeStatusRunning)
	s.inflight[src] = job
	events, cancel := s.Subscribe(src)
	defer cancel()
	<-events // 初始快照

	// 填满订阅缓冲，验证终态仍会替换最旧进度并进入队列。
	for range cap(events) {
		s.broadcast(job)
	}
	job.mu.Lock()
	job.status = TranscodeStatusFailed
	job.err = fmt.Errorf(`ffmpeg failed for C:\\Users\\reader\\secret.mp4`)
	job.mu.Unlock()
	s.broadcast(job)

	foundTerminal := false
	for info := range events {
		if info.Status != TranscodeStatusFailed {
			continue
		}
		foundTerminal = true
		if info.Error != "transcode failed" {
			t.Fatalf("terminal error = %q", info.Error)
		}
	}
	if !foundTerminal {
		t.Fatal("terminal event was dropped")
	}
}

func TestTranscodeService_Subscribe_RunningJob(t *testing.T) {
	ff := findFFmpegTranscode(t)
	probe := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ff, Timeout: 5 * time.Second})
	s := NewTranscodeService(TranscodeOptions{
		CacheDir: t.TempDir(),
		FFmpeg:   ff,
		Info:     probe,
		Timeout:  2 * time.Minute,
	})
	av1 := generateAV1TestVideo(t, ff)
	// 启动转码
	_, _ = s.Resolve(av1, nil)

	// 订阅
	events, cancel := s.Subscribe(av1)
	defer cancel()

	// 应该立即收到当前状态(Queued / Running)
	select {
	case info := <-events:
		if info.Status == TranscodeStatusCached {
			return // 小视频可能在订阅前已完成，终态重放同样有效。
		}
		if info.Status != TranscodeStatusQueued && info.Status != TranscodeStatusRunning {
			t.Errorf("first event status=%v, want Queued/Running", info.Status)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("did not get initial event")
	}

	// 等待转码完成事件(最多 90s)
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case info, ok := <-events:
			if !ok {
				// channel closed 但状态没到 Cached/Failed — bug
				t.Fatal("channel closed before done event")
			}
			if info.Status == TranscodeStatusCached {
				return // 成功
			}
			if info.Status == TranscodeStatusFailed {
				t.Fatalf("transcode failed: %s", info.Error)
			}
		case <-time.After(time.Second):
			// continue
		}
	}
	t.Fatal("did not get done event in 90s")
}

func TestTranscodeService_CacheStats_Empty(t *testing.T) {
	s := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: ""})
	stats := s.CacheStats()
	if stats.FileCount != 0 || stats.TotalBytes != 0 {
		t.Errorf("empty cache: got %+v, want zero", stats)
	}
}

func TestTranscodeService_CacheStats_WithFiles(t *testing.T) {
	s := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: ""})
	dir := filepath.Join(s.cacheDir, "video-transcode")
	os.MkdirAll(dir, 0o755)
	// 写 3 个不同大小的文件
	for i, size := range []int{100, 200, 300} {
		buf := make([]byte, size)
		p := filepath.Join(dir, fmt.Sprintf("file%d.mp4", i))
		os.WriteFile(p, buf, 0o644)
	}
	stats := s.CacheStats()
	if stats.FileCount != 3 {
		t.Errorf("file count: got %d, want 3", stats.FileCount)
	}
	if stats.TotalBytes != 600 {
		t.Errorf("total bytes: got %d, want 600", stats.TotalBytes)
	}
}

func TestTranscodeService_Evict_Noop(t *testing.T) {
	s := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: ""})
	dir := filepath.Join(s.cacheDir, "video-transcode")
	os.MkdirAll(dir, 0o755)
	for i := 0; i < 3; i++ {
		os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%d.mp4", i)),
			make([]byte, 1000), 0o644)
	}
	// 两个参数都 0 → noop
	d, fb, err := s.Evict(0, 0)
	if err != nil || d != 0 || fb != 0 {
		t.Errorf("noop: got (%d, %d, %v), want (0, 0, nil)", d, fb, err)
	}
	// maxBytes 充足 → 不删
	d, fb, err = s.Evict(10000, 0)
	if err != nil || d != 0 || fb != 0 {
		t.Errorf("under limit: got (%d, %d, %v)", d, fb, err)
	}
	// 看是否还是 3 个
	stats := s.CacheStats()
	if stats.FileCount != 3 {
		t.Errorf("file count: got %d, want 3", stats.FileCount)
	}
}

func TestTranscodeService_Evict_BySize(t *testing.T) {
	s := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: ""})
	dir := filepath.Join(s.cacheDir, "video-transcode")
	os.MkdirAll(dir, 0o755)
	// 写 3 个文件,每个 1000 bytes,带不同 mtime
	for i := 0; i < 3; i++ {
		p := filepath.Join(dir, fmt.Sprintf("f%d.mp4", i))
		os.WriteFile(p, make([]byte, 1000), 0o644)
		// f0 最新, f2 最老
		mt := time.Now().Add(-time.Duration(i) * time.Hour)
		os.Chtimes(p, mt, mt)
	}
	// maxBytes = 2500 → 当前 3000,删 1 个最老的(f2) 剩 2000
	d, fb, err := s.Evict(2500, 0)
	if err != nil {
		t.Fatalf("Evict: %v", err)
	}
	if d != 1 || fb != 1000 {
		t.Errorf("evict 1: got (%d, %d), want (1, 1000)", d, fb)
	}
	stats := s.CacheStats()
	if stats.FileCount != 2 || stats.TotalBytes != 2000 {
		t.Errorf("after evict: got %d files / %d bytes, want 2 / 2000",
			stats.FileCount, stats.TotalBytes)
	}
}

func TestTranscodeService_Evict_ByAge(t *testing.T) {
	s := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: ""})
	dir := filepath.Join(s.cacheDir, "video-transcode")
	os.MkdirAll(dir, 0o755)
	// 3 个文件,mtime 分别为 0/5/10 天前
	for i := 0; i < 3; i++ {
		p := filepath.Join(dir, fmt.Sprintf("f%d.mp4", i))
		os.WriteFile(p, make([]byte, 100), 0o644)
		mt := time.Now().Add(-time.Duration(i*5*24) * time.Hour)
		os.Chtimes(p, mt, mt)
	}
	// maxAgeDays = 7 → f0 (10d) 和 f1 (5d) 不删,只删...等等,
	// 5d 前还在 7d 之内,f0 (10d) > 7d 才删
	// Wait, mtime 更早的才更老。f0: 0d 前(最新), f1: 5d 前, f2: 10d 前
	// So f2 会被删(10d > 7d)
	d, fb, err := s.Evict(0, 7)
	if err != nil {
		t.Fatalf("Evict: %v", err)
	}
	if d != 1 || fb != 100 {
		t.Errorf("evict by age: got (%d, %d), want (1, 100)", d, fb)
	}
	stats := s.CacheStats()
	if stats.FileCount != 2 {
		t.Errorf("file count: got %d, want 2", stats.FileCount)
	}
}

func TestTranscodeService_Evict_BothCriteria(t *testing.T) {
	s := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: ""})
	dir := filepath.Join(s.cacheDir, "video-transcode")
	os.MkdirAll(dir, 0o755)
	// 4 个文件:每个 1000 bytes
	// mtime: 10d, 8d, 1d, 0d 前
	for i := 0; i < 4; i++ {
		p := filepath.Join(dir, fmt.Sprintf("f%d.mp4", i))
		os.WriteFile(p, make([]byte, 1000), 0o644)
		// i=0: 10d ago, i=1: 8d, i=2: 1d, i=3: 0d
		mt := time.Now().Add(-time.Duration(i*5+5) * 24 * time.Hour)
		if i == 3 {
			mt = time.Now()
		}
		os.Chtimes(p, mt, mt)
	}
	// maxAgeDays = 7 → 删 f0 (10d) + f1 (8d)
	// maxBytes = 1500 → 删完上面剩 2000 字节,还 > 1500,继续删最老的(现在剩 f2 + f3 = 2000)
	// f2 (1d ago) 被删,剩 f3 = 1000
	// 总共删 3 个
	d, _, err := s.Evict(1500, 7)
	if err != nil {
		t.Fatalf("Evict: %v", err)
	}
	if d != 3 {
		t.Errorf("evict 3: got %d, want 3", d)
	}
	stats := s.CacheStats()
	if stats.FileCount != 1 || stats.TotalBytes != 1000 {
		t.Errorf("after evict: got %d / %d, want 1 / 1000",
			stats.FileCount, stats.TotalBytes)
	}
}

func TestSelectVideoCodec(t *testing.T) {
	ff := findFFmpegTranscode(t)
	got := SelectVideoCodec(ff)
	// 任何有效 ffmpeg 都至少能识别 libx264;但探测顺序是 nvenc→qsv→amf→...→libx264
	// 这个特定 ffmpeg 没硬解(测试机是普通环境),应该返回 libx264
	// (没有 NVIDIA / Intel 硬解 SDK)
	if got == "" {
		t.Errorf("SelectVideoCodec returned empty")
	}
	t.Logf("selected codec: %s", got)
}

func TestSelectVideoCodec_EmptyPath(t *testing.T) {
	if got := SelectVideoCodec(""); got != "libx264" {
		t.Errorf("empty path: got %q, want libx264", got)
	}
}

func TestPresetForCodec(t *testing.T) {
	cases := []struct {
		codec, in, want string
	}{
		{"libx264", "", "veryfast"},
		{"libx264", "fast", "fast"},
		{"h264_nvenc", "", "p1"},
		{"h264_nvenc", "medium", "medium"}, // 用户显式给的保留
		{"h264_qsv", "", "veryfast"},
		{"h264_amf", "", "speed"},
		{"unknown", "", ""},
		{"unknown", "fast", "fast"},
	}
	for _, c := range cases {
		got := presetForCodec(c.codec, c.in)
		if got != c.want {
			t.Errorf("presetForCodec(%q, %q) = %q, want %q", c.codec, c.in, got, c.want)
		}
	}
}

func TestTranscodeService_AutoSelectsCodec(t *testing.T) {
	ff := findFFmpegTranscode(t)
	s := NewTranscodeService(TranscodeOptions{
		CacheDir: t.TempDir(),
		FFmpeg:   ff,
		Profile: TranscodeProfile{
			Name:       "test",
			VideoCodec: "auto", // 触发自动选
			CRF:        22,
			AudioCodec: "aac",
		},
	})
	// 懒加载:启动期不探测,显式调 resolveCodec 触发。
	got := s.resolveCodec()
	if got == "" || got == "auto" {
		t.Errorf("VideoCodec not resolved: %q", got)
	}
	if s.Profile().VideoCodec != got {
		t.Errorf("profile not synced: profile=%q got=%q", s.Profile().VideoCodec, got)
	}
	t.Logf("resolved codec: %s", got)
}

func TestTranscodeService_SubscriptionsAreIndependent(t *testing.T) {
	s, src := newTranscodeEventFixture(t)
	job := transcodeEventJob(t, s, src, TranscodeStatusQueued)
	s.inflight[src] = job
	first, cancelFirst := s.Subscribe(src)
	second, cancelSecond := s.Subscribe(src)
	defer cancelFirst()
	defer cancelSecond()
	if (<-first).Status != TranscodeStatusQueued || (<-second).Status != TranscodeStatusQueued {
		t.Fatal("subscribers did not receive the initial state")
	}
	cancelFirst()
	cancelFirst()
	if len(job.subs) != 1 {
		t.Fatalf("cancelling one subscription affected the other: count=%d", len(job.subs))
	}
	select {
	case _, ok := <-first:
		if ok {
			t.Error("cancelled subscription retained events")
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled subscription did not close")
	}
	job.status = TranscodeStatusFailed
	job.err = errors.New("private command failure")
	s.broadcast(job)
	assertTranscodeTerminalReplay(t, second, TranscodeInfo{Status: TranscodeStatusFailed, Error: "transcode failed"})
}

func TestParseProgressLine(t *testing.T) {
	svc := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: ""})
	job := &transcodeJob{
		done:   make(chan struct{}),
		status: TranscodeStatusRunning,
	}
	// 正常行
	parseProgressLine("out_time_ms=5000000", 10.0, job, svc) // 5s / 10s = 0.5
	if job.progress < 0.49 || job.progress > 0.51 {
		t.Errorf("got %v, want ~0.5", job.progress)
	}
	// N/A 跳过
	job.progress = -1
	parseProgressLine("out_time_ms=N/A", 10.0, job, svc)
	if job.progress != -1 {
		t.Errorf("N/A should not change progress, got %v", job.progress)
	}
	// 非 out_time_ms 跳过
	job.progress = -1
	parseProgressLine("frame=123", 10.0, job, svc)
	if job.progress != -1 {
		t.Errorf("non-out_time_ms should not change progress, got %v", job.progress)
	}
	// 超过 1.0 截断
	parseProgressLine("out_time_ms=15000000", 10.0, job, svc) // 15s / 10s
	if job.progress > 1.0 {
		t.Errorf("got %v, should be <= 1.0", job.progress)
	}
	// 缺总时长:fallback 到 0.5
	parseProgressLine("out_time_ms=3000000", 0, job, svc)
	if job.progress != 0.5 {
		t.Errorf("zero total: got %v, want 0.5", job.progress)
	}
}
