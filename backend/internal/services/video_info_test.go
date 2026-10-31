package services

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestVideoInfoService_Available(t *testing.T) {
	ff := findFFmpeg(t)
	svc := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ff})
	if !svc.Available() {
		t.Error("expected Available()=true with valid ffmpeg path")
	}

	svc2 := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ""})
	if svc2.Available() {
		t.Error("expected Available()=false with empty path")
	}
}

func TestVideoInfoService_FFprobePath(t *testing.T) {
	ff := findFFmpeg(t)
	svc := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ff})
	got := svc.FFprobePath()
	if got == "" {
		t.Fatal("FFprobePath should derive from ffmpeg path when not given")
	}
	wantSuffix := "ffprobe"
	if filepath.Ext(ff) == ".exe" {
		wantSuffix = "ffprobe.exe"
	}
	if filepath.Base(got) != wantSuffix {
		t.Errorf("FFprobePath = %q, want suffix %q", got, wantSuffix)
	}

	// 显式给 FFprobePath 时优先
	svc2 := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ff, FFprobePath: "/custom/ffprobe.exe"})
	if svc2.FFprobePath() != "/custom/ffprobe.exe" {
		t.Errorf("FFprobePath should honor explicit override, got %q", svc2.FFprobePath())
	}
}

func TestVideoInfoService_Probe_RealVideo(t *testing.T) {
	ff := findFFmpeg(t)
	vidPath := generateTestVideo(t, ff)
	svc := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ff, Timeout: 5 * 1e9})
	meta, err := svc.Probe(vidPath)
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if meta.Width != 320 {
		t.Errorf("width = %d, want 320", meta.Width)
	}
	if meta.Height != 240 {
		t.Errorf("height = %d, want 240", meta.Height)
	}
	// 测试视频 2 秒,允许 ±0.1s 浮点误差
	if meta.DurationSec < 1.9 || meta.DurationSec > 2.1 {
		t.Errorf("duration = %.2f, want ~2.0", meta.DurationSec)
	}
	if meta.Codec == "" {
		t.Error("codec should be non-empty")
	}
	if meta.Container == "" {
		t.Error("container should be non-empty")
	}
}

func TestVideoInfoService_Probe_GarbageFile(t *testing.T) {
	ff := findFFmpeg(t)
	bad := filepath.Join(t.TempDir(), "bad.mp4")
	os.WriteFile(bad, []byte("not a real video"), 0o644)
	svc := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ff, Timeout: 5 * 1e9})
	_, err := svc.Probe(bad)
	if err == nil {
		t.Fatal("expected error for garbage file")
	}
	// 不应返回 ErrProbeUnavailable(ffmpeg 在,只是文件烂)
	if errors.Is(err, ErrProbeUnavailable) {
		t.Errorf("did not expect ErrProbeUnavailable for bad file, got: %v", err)
	}
}

func TestVideoInfoService_Probe_MissingFile(t *testing.T) {
	ff := findFFmpeg(t)
	svc := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ff, Timeout: 5 * 1e9})
	_, err := svc.Probe("/nonexistent/video.mp4")
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestVideoInfoService_NilReceiver(t *testing.T) {
	var svc *VideoInfoService
	if svc.Available() {
		t.Error("nil receiver should not be available")
	}
	if svc.FFprobePath() != "" {
		t.Error("nil receiver should return empty ffprobe path")
	}
	_, err := svc.Probe("/tmp/x.mp4")
	if !errors.Is(err, ErrProbeUnavailable) {
		t.Errorf("nil Probe should return ErrProbeUnavailable, got %v", err)
	}
	svc.ClearCache()
}
