package services

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func TestScanMultiRootProgressKeepsCumulativeAlbumCount(t *testing.T) {
	roots := []string{t.TempDir(), t.TempDir(), t.TempDir()}
	for rootIndex, count := range []int{3, 0, 2} {
		for index := range count {
			directory := filepath.Join(roots[rootIndex], itoa(index))
			mkdirAll(t, directory)
			touchAll(t, filepath.Join(directory, "page.png"))
		}
	}
	previous := 0
	events := 0
	result, err := NewScanner().ScanWithHook(ScanOptions{Roots: roots}, func(event ScanProgress) {
		events++
		if event.RootCount != len(roots) {
			t.Errorf("root count=%d want %d", event.RootCount, len(roots))
		}
		if event.RootIndex < 0 || event.RootIndex >= event.RootCount {
			t.Errorf("invalid current root index: %d/%d", event.RootIndex, event.RootCount)
		}
		if event.AlbumsFound < previous {
			t.Errorf("album count decreased: %d -> %d during %s", previous, event.AlbumsFound, event.Phase)
		}
		previous = event.AlbumsFound
	})
	if err != nil {
		t.Fatal(err)
	}
	if events < 4 || result.AlbumCount != 5 || previous != 5 {
		t.Fatalf("events=%d result=%d last=%d", events, result.AlbumCount, previous)
	}
}

func TestScanMultiRootProgressNormalizesRootsAndCountsVirtualAlbums(t *testing.T) {
	first, second := t.TempDir(), t.TempDir()
	parent := filepath.Join(first, "mixed")
	child := filepath.Join(parent, "child")
	mkdirAll(t, child)
	touchAll(t, filepath.Join(parent, "page.png"), filepath.Join(child, "page.jpg"), filepath.Join(second, "clip.mp4"))
	seenRoots := make(map[int]bool)
	result, err := NewScanner().ScanWithHook(ScanOptions{Roots: []string{first, " ", first, second}}, func(event ScanProgress) {
		if event.RootCount != 2 {
			t.Errorf("root count=%d want 2", event.RootCount)
		}
		if event.Phase != "scanning" {
			return
		}
		seenRoots[event.RootIndex] = true
		if event.RootIndex == 1 && event.AlbumsFound < 2 {
			t.Errorf("second root lost virtual or descendant albums: %+v", event)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.AlbumCount != 3 || !seenRoots[0] || !seenRoots[1] || len(seenRoots) != 2 {
		t.Fatalf("albums=%d roots=%v", result.AlbumCount, seenRoots)
	}
}

func TestScanProgressCancellationDoesNotEnterLaterPhase(t *testing.T) {
	for _, cancelRoot := range []int{0, 1} {
		t.Run(itoa(cancelRoot), func(t *testing.T) {
			roots := []string{t.TempDir(), t.TempDir()}
			for _, root := range roots {
				touchAll(t, filepath.Join(root, "page.png"))
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			seenCancelledRoot := false
			result, err := NewScanner().ScanWithContext(ctx, ScanOptions{Roots: roots}, func(event ScanProgress) {
				if seenCancelledRoot {
					t.Errorf("progress after cancellation: %+v", event)
				}
				if event.RootIndex == cancelRoot {
					seenCancelledRoot = true
					cancel()
				}
			})
			if !errors.Is(err, context.Canceled) || result != nil || !seenCancelledRoot {
				t.Fatalf("cancel root=%d seen=%v result=%v err=%v", cancelRoot, seenCancelledRoot, result != nil, err)
			}
		})
	}
}

func TestScanProgressEstimateDoesNotResetAsWorkIsDiscovered(t *testing.T) {
	events := []ScanProgress{
		{RootCount: 2, RootIndex: 0, Processed: 2, Total: 5},
		{RootCount: 2, RootIndex: 0, Processed: 3, Total: 20},
		{RootCount: 2, RootIndex: 0, Processed: 20, Total: 20},
		{RootCount: 2, RootIndex: 1, Processed: 1, Total: 10},
		{RootCount: 2, RootIndex: 1, Processed: 2, Total: 100},
		{RootCount: 2, RootIndex: 1, Processed: 100, Total: 100},
	}
	previous := 0
	for index, event := range events {
		value := estimateScanProgress(event, previous)
		if value < previous || value > 95 {
			t.Fatalf("event %d progress changed from %d to %d", index, previous, value)
		}
		if event.RootIndex == 0 && value >= 50 {
			t.Fatalf("first root consumed later root budget: %d", value)
		}
		previous = value
	}
	if previous != 95 {
		t.Fatalf("directory phase ended at %d want 95", previous)
	}
	if value := estimateScanProgress(ScanProgress{Phase: "smart-grouping"}, previous); value != 99 {
		t.Fatalf("grouping progress=%d want 99", value)
	}
}
