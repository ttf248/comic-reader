package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newTranscodeVersionFixture(t *testing.T) (*TranscodeService, string) {
	t.Helper()
	src := filepath.Join(t.TempDir(), "source.mp4")
	if err := os.WriteFile(src, []byte("version-one"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: "capability-prechecked", Concurrency: 1})
	s.availOnce.Do(func() { s.avail = true })
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := s.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	return s, src
}

func changeTranscodeSourceVersion(t *testing.T, src, mode string) {
	t.Helper()
	if mode == "size" {
		previous := mustStat(t, src).ModTime()
		if err := os.WriteFile(src, []byte("version-two-with-new-size"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(src, previous, previous); err != nil {
			t.Fatal(err)
		}
		return
	}
	future := mustStat(t, src).ModTime().Add(time.Minute)
	if err := os.Chtimes(src, future, future); err != nil {
		t.Fatal(err)
	}
}

func TestTranscodeOldFailureDoesNotHideCurrentCache(t *testing.T) {
	for _, version := range []string{"same", "mtime", "size"} {
		t.Run(version, func(t *testing.T) {
			s, src := newTranscodeVersionFixture(t)
			s.Resolve(src, nil)
			s.mu.Lock()
			old := s.inflight[src]
			s.mu.Unlock()
			select {
			case <-old.done:
			case <-time.After(time.Second):
				t.Fatal("initial failure did not finish")
			}
			if version != "same" {
				changeTranscodeSourceVersion(t, src, version)
			}
			cachePath := s.cachePathFor(s.cacheKey(src, mustStat(t, src)))
			if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(cachePath, []byte("published-current-cache"), 0o644); err != nil {
				t.Fatal(err)
			}
			if info := s.GetStatus(src); info.Status != TranscodeStatusCached {
				t.Errorf("old failure hid current cache: %+v", info)
			}
			events, cancel := s.Subscribe(src)
			defer cancel()
			assertTranscodeTerminalReplay(t, events, TranscodeInfo{Status: TranscodeStatusCached, Progress: 1})
		})
	}
}

func TestTranscodeChangedSourceDoesNotReuseQueuedJob(t *testing.T) {
	for _, version := range []string{"mtime", "size"} {
		t.Run(version, func(t *testing.T) {
			s, src := newTranscodeVersionFixture(t)
			s.sem <- struct{}{} // 保持排队，避免启动外部进程。
			s.Resolve(src, nil)
			s.mu.Lock()
			old := s.inflight[src]
			s.mu.Unlock()
			changeTranscodeSourceVersion(t, src, version)
			// 新版本尚未开始转码：状态是 pending（不是失败）。
			if info := s.GetStatus(src); info.Status != TranscodeStatusPending || info.Error != "" {
				t.Errorf("old version remained visible: %+v", info)
			}
			// 新版本尚未启动，订阅也不能挂在旧排队任务上。
			events, cancel := s.Subscribe(src)
			assertTranscodeTerminalReplay(t, events, TranscodeInfo{Status: TranscodeStatusPending})
			cancel()
			s.Resolve(src, nil)
			s.mu.Lock()
			current := s.inflight[src]
			s.mu.Unlock()
			if current == old {
				t.Fatal("new version reused the old queued job")
			}
			select {
			case <-old.done:
			case <-time.After(time.Second):
				t.Fatal("superseded queued job was not cancelled")
			}
		})
	}
}

func TestTranscodeChangedQueuedSourceIsNotPublished(t *testing.T) {
	s, src := newTranscodeVersionFixture(t)
	s.sem <- struct{}{}
	fi := mustStat(t, src)
	cachePath := s.cachePathFor(s.cacheKey(src, fi))
	s.Resolve(src, fi)
	s.mu.Lock()
	job := s.inflight[src]
	s.mu.Unlock()
	changeTranscodeSourceVersion(t, src, "mtime")
	<-s.sem
	select {
	case <-job.done:
	case <-time.After(time.Second):
		t.Fatal("stale queued job did not finish")
	}
	if got := publicTranscodeError(job.err); got != "video source changed" {
		t.Errorf("stale input was sent to ffmpeg: %s", got)
	}
	if _, err := os.Stat(cachePath); !os.IsNotExist(err) {
		t.Errorf("stale job published a cache: %v", err)
	}
}

func TestTranscodeStaleRequestCannotReplaceNewerTask(t *testing.T) {
	s, src := newTranscodeVersionFixture(t)
	s.sem <- struct{}{}
	oldInfo := mustStat(t, src)
	oldCache := s.cachePathFor(s.cacheKey(src, oldInfo))
	changeTranscodeSourceVersion(t, src, "mtime")
	s.Resolve(src, nil)
	s.mu.Lock()
	current := s.inflight[src]
	s.mu.Unlock()
	if _, status := s.ensureRunning(src, oldCache, oldInfo); status != TranscodeStatusFailed {
		t.Errorf("stale request started work: %v", status)
	}
	// 入口复用调用方的 Stat 时，也不能用过期信息取消当前任务。
	s.Resolve(src, oldInfo)
	s.mu.Lock()
	after := s.inflight[src]
	s.mu.Unlock()
	if after != current {
		t.Fatal("stale request replaced the current task")
	}
	select {
	case <-current.done:
		t.Fatal("stale request cancelled the current task")
	case <-time.After(20 * time.Millisecond):
	}
}

func TestTranscodeShutdownWaitsForSupersededJob(t *testing.T) {
	s, src := newTranscodeVersionFixture(t)
	s.sem <- struct{}{}
	s.Resolve(src, nil)
	s.mu.Lock()
	old := s.inflight[src]
	s.mu.Unlock()
	old.mu.Lock() // 让已取消的旧 worker 暂时停在终态写入前。
	locked := true
	defer func() {
		if locked {
			old.mu.Unlock()
		}
	}()
	changeTranscodeSourceVersion(t, src, "mtime")
	resolved := make(chan struct{})
	go func() {
		s.Resolve(src, nil)
		close(resolved)
	}()
	select {
	case <-resolved:
	case <-time.After(time.Second):
		t.Fatal("new version waited for the old task lock")
	}
	s.mu.Lock()
	current := s.inflight[src]
	s.mu.Unlock()
	if current == old {
		t.Fatal("old task was not superseded")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := s.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Shutdown stopped waiting for superseded worker: %v", err)
	}
	old.mu.Unlock()
	locked = false
	ctx, finish := context.WithTimeout(context.Background(), time.Second)
	defer finish()
	if err := s.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-old.done:
	default:
		t.Fatal("Shutdown returned before the superseded worker exited")
	}
}
