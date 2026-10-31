package services

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func moveTestRootOffline(t *testing.T, parent, root string) {
	t.Helper()
	if !filepath.IsAbs(root) || filepath.Dir(root) != parent {
		t.Fatal("test root escaped temporary parent")
	}
	destination := filepath.Join(parent, filepath.Base(root)+"-offline")
	if filepath.Dir(destination) != parent {
		t.Fatal("test destination escaped temporary parent")
	}
	if err := os.Rename(root, destination); err != nil {
		t.Fatal(err)
	}
}

func TestDirectoryScanStopsWorkersWhenRootDisappears(t *testing.T) {
	for _, duringRead := range []bool{false, true} {
		t.Run(fmt.Sprintf("during-read=%t", duringRead), func(t *testing.T) {
			parent := t.TempDir()
			path := filepath.Join(parent, "root")
			for index := range 64 {
				child := filepath.Join(path, fmt.Sprintf("album-%02d", index))
				mkdirAll(t, child)
				touchAll(t, filepath.Join(child, "page.png"))
			}
			roots, err := prepareScanRoots(ScanOptions{Roots: []string{path}})
			if err != nil {
				t.Fatal(err)
			}
			if !duringRead {
				moveTestRootOffline(t, parent, path)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			scanner := NewScanner()
			scanner.ctx = ctx
			done := make(chan error, 1)
			go func() {
				var moveErr error
				records, warnings, scanErr := scanner.scanDirectoryTree(roots[0], 0, DefaultExclude(), func(event ScanProgress) {
					if duringRead && event.CurrentPath == path {
						moveErr = os.Rename(path, filepath.Join(parent, "root-offline"))
					}
				})
				if moveErr != nil {
					done <- moveErr
					return
				}
				var rootErr *ScanError
				if !errors.As(scanErr, &rootErr) || rootErr.Kind != ScanRootMissing || records != nil || warnings != nil {
					done <- fmt.Errorf("root loss returned records=%d warnings=%d err=%v", len(records), len(warnings), scanErr)
					return
				}
				done <- nil
			}()
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(5 * time.Second):
				cancel()
				select {
				case <-done:
				case <-time.After(time.Second):
					t.Fatal("directory workers remained blocked after cancellation")
				}
				t.Fatal("root failure did not release directory workers")
			}
		})
	}
}

func TestScanKeepsChildReadFailureAsWarning(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "root")
	child := filepath.Join(root, "unavailable")
	mkdirAll(t, child)
	touchAll(t, filepath.Join(root, "page.png"), filepath.Join(child, "page.png"))
	scanner := NewScanner()
	scanner.workers = 1
	result, err := scanner.ScanWithHook(ScanOptions{Roots: []string{root}}, func(event ScanProgress) {
		if event.Phase == "scanning" && event.CurrentPath == root {
			if err := os.Rename(child, filepath.Join(parent, "child-offline")); err != nil {
				t.Fatal(err)
			}
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.AlbumCount != 1 || len(result.Warnings) != 1 {
		t.Fatalf("child failure discarded readable media: %+v", result)
	}
	warning := result.Warnings[0]
	if warning.Code != "directory_unreadable" || warning.Path != "root/unavailable" {
		t.Fatalf("unexpected child warning: %+v", warning)
	}
}

func TestScanRootValidationAcceptsEmptyAndUnchangedRoots(t *testing.T) {
	root := t.TempDir()
	roots, err := prepareScanRoots(ScanOptions{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	// 内容增删不是根身份变化，正常重扫仍可以发现新增或删除的媒体。
	touchAll(t, filepath.Join(root, "new.png"))
	if err := validateScanRoots(roots); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "new.png")); err != nil {
		t.Fatal(err)
	}
	result, err := NewScanner().Scan(ScanOptions{Roots: []string{root}})
	if err != nil || result == nil || result.AlbumCount != 0 || len(result.Roots) != 1 {
		t.Fatalf("empty readable root rejected: result=%+v err=%v", result, err)
	}
}

func TestScanRejectsRootChangesAfterInitialValidation(t *testing.T) {
	cases := []struct {
		name                    string
		triggerRoot, targetRoot int
		phase, replacement      string
		kind                    ScanErrorKind
	}{
		{"upcoming-missing", 0, 1, "scanning", "", ScanRootMissing},
		{"upcoming-file", 0, 1, "scanning", "file", ScanRootNotDir},
		{"upcoming-replaced", 0, 1, "scanning", "directory", ScanRootChanged},
		{"completed-root-missing", 1, 0, "scanning", "", ScanRootMissing},
		{"current-root-missing", 1, 1, "scanning", "", ScanRootMissing},
		{"grouping-root-missing", 1, 0, "smart-grouping", "", ScanRootMissing},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			parent := t.TempDir()
			roots := []string{filepath.Join(parent, "first"), filepath.Join(parent, "second")}
			for _, root := range roots {
				mkdirAll(t, root)
				touchAll(t, filepath.Join(root, "page.png"))
			}
			changed := false
			result, err := NewScanner().ScanWithHook(ScanOptions{Roots: roots}, func(event ScanProgress) {
				if changed || event.Phase != item.phase || event.RootIndex != item.triggerRoot {
					return
				}
				changed = true
				target := roots[item.targetRoot]
				moveTestRootOffline(t, parent, target)
				switch item.replacement {
				case "file":
					if err := os.WriteFile(target, []byte("not a directory"), 0o644); err != nil {
						t.Fatal(err)
					}
				case "directory":
					mkdirAll(t, target)
				}
			})
			if !changed {
				t.Fatal("root change was not injected")
			}
			if err == nil || result != nil {
				t.Fatalf("root changed but scan returned result=%v err=%v", result != nil, err)
			}
			var scanErr *ScanError
			if !errors.As(err, &scanErr) || scanErr.Kind != item.kind {
				t.Fatalf("unexpected root error: %v", err)
			}
		})
	}
}
