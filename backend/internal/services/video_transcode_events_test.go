package services

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func newTranscodeEventFixture(t *testing.T) (*TranscodeService, string) {
	t.Helper()
	src := filepath.Join(t.TempDir(), "source.mp4")
	if err := os.WriteFile(src, []byte("source-video"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: "capability-prechecked"})
	s.availOnce.Do(func() { s.avail = true })
	return s, src
}

func transcodeEventJob(t *testing.T, s *TranscodeService, src string, status TranscodeStatus) *transcodeJob {
	t.Helper()
	return &transcodeJob{cachePath: s.cachePathFor(s.cacheKey(src, mustStat(t, src))), done: make(chan struct{}), status: status}
}

func TestTranscodeSubscriptionReplaysCurrentTerminalStatus(t *testing.T) {
	for _, state := range []string{"cached-job", "failed-job", "empty-cache", "directory-cache", "missing-cache", "disk-cache", "not-started", "closed"} {
		t.Run(state, func(t *testing.T) {
			src := filepath.Join(t.TempDir(), "video.mp4")
			if err := os.WriteFile(src, []byte("source-video"), 0o644); err != nil {
				t.Fatal(err)
			}
			s := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: "capability-prechecked"})
			// 此组只验证状态与订阅，不运行转码进程。
			s.availOnce.Do(func() { s.avail = true })
			cachePath := s.cachePathFor(s.cacheKey(src, mustStat(t, src)))
			if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err != nil {
				t.Fatal(err)
			}
			switch state {
			case "cached-job", "disk-cache":
				if err := os.WriteFile(cachePath, []byte("published-video-cache"), 0o644); err != nil {
					t.Fatal(err)
				}
			case "empty-cache":
				if err := os.WriteFile(cachePath, nil, 0o644); err != nil {
					t.Fatal(err)
				}
			case "directory-cache":
				if err := os.Mkdir(cachePath, 0o755); err != nil {
					t.Fatal(err)
				}
			case "closed":
				s.closed = true
			}
			var job *transcodeJob
			if state != "disk-cache" && state != "not-started" && state != "closed" {
				job = &transcodeJob{cachePath: cachePath, done: make(chan struct{}), status: TranscodeStatusCached, progress: 1}
				if state == "failed-job" {
					job.status = TranscodeStatusFailed
					job.err = fmt.Errorf("ffmpeg failed for %s", src)
				}
				close(job.done)
				s.inflight[src] = job
				// 任务广播已经结束，迟到的订阅不能依赖未来广播来关闭。
				s.broadcast(job)
			}
			want := s.GetStatus(src)
			wantStatus := TranscodeStatusFailed
			switch state {
			case "cached-job", "disk-cache":
				wantStatus = TranscodeStatusCached
			case "closed":
				wantStatus = TranscodeStatusUnavailable
			}
			if want.Status != wantStatus {
				t.Fatalf("status fixture: got %+v, want %v", want, wantStatus)
			}
			for range 3 {
				events, cancel := s.Subscribe(src)
				assertTranscodeTerminalReplay(t, events, want)
				cancel()
				cancel()
			}
			if job != nil && len(job.subs) != 0 {
				t.Errorf("completed job retained %d subscribers", len(job.subs))
			}
		})
	}
}

func TestTranscodeSubscriptionNilServiceReplaysSkipped(t *testing.T) {
	var s *TranscodeService
	events, cancel := s.Subscribe("video.mp4")
	defer cancel()
	assertTranscodeTerminalReplay(t, events, s.GetStatus("video.mp4"))
}

func TestTranscodeSubscriptionDoesNotLoseConcurrentCompletion(t *testing.T) {
	src := filepath.Join(t.TempDir(), "source.mp4")
	if err := os.WriteFile(src, []byte("source"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewTranscodeService(TranscodeOptions{CacheDir: t.TempDir(), FFmpeg: "capability-prechecked"})
	s.availOnce.Do(func() { s.avail = true })
	cachePath := s.cachePathFor(s.cacheKey(src, mustStat(t, src)))
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err != nil {
		t.Fatal(err)
	}
	for range 20 {
		if err := os.Remove(cachePath); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
		job := &transcodeJob{cachePath: cachePath, done: make(chan struct{}), status: TranscodeStatusRunning}
		s.inflight[src] = job
		var subscribers sync.WaitGroup
		start := make(chan struct{})
		for range 16 {
			subscribers.Add(1)
			go func() {
				defer subscribers.Done()
				<-start
				events, cancel := s.Subscribe(src)
				defer cancel()
				terminalCount := 0
				deadline := time.After(time.Second)
				for {
					select {
					case info, ok := <-events:
						if !ok {
							if terminalCount != 1 {
								t.Errorf("subscription closed after %d cached events", terminalCount)
							}
							return
						}
						if info.Status == TranscodeStatusCached {
							terminalCount++
						} else if info.Status != TranscodeStatusRunning {
							t.Errorf("unexpected event: %+v", info)
						}
					case <-deadline:
						t.Error("concurrent subscription lost completion")
						return
					}
				}
			}()
		}
		close(start)
		if err := os.WriteFile(cachePath, []byte("published-cache"), 0o644); err != nil {
			t.Fatal(err)
		}
		job.mu.Lock()
		job.status = TranscodeStatusCached
		job.progress = 1
		job.mu.Unlock()
		s.broadcast(job)
		subscribers.Wait()
	}
}

func assertTranscodeTerminalReplay(t *testing.T, events <-chan TranscodeInfo, want TranscodeInfo) {
	t.Helper()
	select {
	case got, ok := <-events:
		if !ok || got != want {
			t.Errorf("replay=%+v open=%v, status query=%+v", got, ok, want)
		}
	case <-time.After(time.Second):
		t.Fatal("terminal snapshot was not sent")
	}
	select {
	case _, ok := <-events:
		if ok {
			t.Error("terminal replay contained more than one event")
		}
	case <-time.After(100 * time.Millisecond):
		t.Error("terminal subscription did not close")
	}
}

func TestTranscodeBroadcastAndCancellationAreSerialized(t *testing.T) {
	s, src := newTranscodeEventFixture(t)
	for range 100 {
		job := transcodeEventJob(t, s, src, TranscodeStatusRunning)
		s.inflight[src] = job
		var releases []func()
		for range 8 {
			_, release := s.Subscribe(src)
			releases = append(releases, release)
		}
		var workers sync.WaitGroup
		start := make(chan struct{})
		for range 3 {
			workers.Add(1)
			go func() {
				defer workers.Done()
				<-start
				for range 100 {
					s.broadcast(job)
				}
			}()
		}
		close(start)
		for _, release := range releases[:4] {
			release()
		}
		job.mu.Lock()
		job.status = TranscodeStatusFailed
		job.mu.Unlock()
		s.broadcast(job)
		workers.Wait()
		for _, release := range releases {
			release()
		}
		if len(job.subs) != 0 {
			t.Fatalf("terminal broadcast retained %d subscribers", len(job.subs))
		}
	}
}
