package services

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMaintainDerivedCachePreservesStateAndTemporaryFiles(t *testing.T) {
	layout, err := EnsureCacheLayout(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	paths := []string{
		filepath.Join(layout.ThumbnailDir, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg"),
		filepath.Join(layout.DerivedDir, "video-transcode", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp4"),
		filepath.Join(layout.DerivedDir, "video-transcode", "cccccccccccccccccccccccccccccccc.mp4.tmp"),
		layout.ActivityPath,
	}
	old := time.Now().Add(-48 * time.Hour)
	for _, path := range paths {
		os.MkdirAll(filepath.Dir(path), 0o700)
		if err := os.WriteFile(path, []byte("fixture"), 0o600); err != nil {
			t.Fatal(err)
		}
		os.Chtimes(path, old, old)
	}
	deleted, err := MaintainDerivedCache(context.Background(), layout, 1, 30)
	if err != nil || deleted != 2 {
		t.Fatalf("deleted=%d err=%v", deleted, err)
	}
	for _, path := range paths[2:] {
		if _, err := os.Stat(path); err != nil {
			t.Fatal("removed protected file", err)
		}
	}
	if err := os.WriteFile(paths[0], []byte("fresh"), 0o600); err != nil {
		t.Fatal(err)
	}
	deleted, err = MaintainDerivedCache(context.Background(), layout, 1, 30)
	if err != nil || deleted != 0 {
		t.Fatalf("fresh deleted=%d err=%v", deleted, err)
	}
}

func TestCacheMaintenanceCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		RunCacheMaintenance(ctx, time.Hour, func(context.Context) error { cancel(); return nil })
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("maintenance did not stop")
	}
}
