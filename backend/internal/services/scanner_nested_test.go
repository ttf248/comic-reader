package services

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/pathutil"
)

func TestNestedRootsScanEachDirectoryOnceWithSpecificOwnership(t *testing.T) {
	for _, order := range [][]int{{0, 1, 2}, {2, 0, 1}, {1, 0, 2}} {
		t.Run(itoa(order[0]), func(t *testing.T) {
			parent := t.TempDir()
			child := filepath.Join(parent, "series")
			grandchild := filepath.Join(child, "archive")
			owners := map[string]string{
				parent: parent, filepath.Join(parent, "keep"): parent, filepath.Join(parent, "series-backup"): parent,
				child: child, filepath.Join(child, "leaf"): child, filepath.Join(child, "leaf", "deep"): child,
				grandchild: grandchild, filepath.Join(grandchild, "deep"): grandchild,
			}
			for directory := range owners {
				mkdirAll(t, directory)
				touchAll(t, filepath.Join(directory, "page.png"))
			}
			allRoots := []string{parent, child, grandchild}
			roots := []string{allRoots[order[0]], allRoots[order[1]], allRoots[order[2]]}
			reads := make(map[string]int)
			previous := 0
			result, err := NewScanner().ScanWithHook(ScanOptions{Roots: roots}, func(event ScanProgress) {
				if event.RootCount != len(roots) || event.AlbumsFound < previous {
					t.Errorf("nested root progress inconsistent: %+v", event)
				}
				previous = event.AlbumsFound
				if event.Phase == "scanning" {
					reads[event.CurrentPath]++
					if owners[event.CurrentPath] != roots[event.RootIndex] {
						t.Errorf("directory was read through a less specific root: %s", event.CurrentPath)
					}
				}
			})
			if err != nil {
				t.Fatal(err)
			}
			if result.AlbumCount != len(owners) || previous != len(owners) || result.CollectionCount != 1 || len(result.Warnings) != 0 {
				t.Fatalf("nested roots duplicated counts: albums=%d collections=%d last=%d warnings=%v", result.AlbumCount, result.CollectionCount, previous, result.Warnings)
			}
			seen := make(map[string]bool)
			checkAlbum := func(album models.Album) {
				key := pathutil.RootKey(album.Path)
				if seen[key] || album.SourceRoot != owners[album.Path] || reads[album.Path] != 1 {
					t.Errorf("album duplicated or owned incorrectly: %+v reads=%d", album, reads[album.Path])
				}
				seen[key] = true
			}
			var checkCollections func([]models.Collection)
			checkCollections = func(collections []models.Collection) {
				for _, collection := range collections {
					for _, album := range collection.Albums {
						checkAlbum(album)
					}
					checkCollections(collection.Collections)
				}
			}
			for _, album := range result.Albums {
				checkAlbum(album)
			}
			checkCollections(result.Collections)
			if len(seen) != len(owners) || len(reads) != len(owners) {
				t.Fatalf("nested root scan lost directories: albums=%d reads=%d", len(seen), len(reads))
			}
		})
	}
}

func TestNestedRootFailureDoesNotFallBackToParent(t *testing.T) {
	base := t.TempDir()
	parent := filepath.Join(base, "photos")
	child := filepath.Join(parent, "series")
	mkdirAll(t, child)
	touchAll(t, filepath.Join(parent, "page.png"), filepath.Join(child, "page.png"))
	changed := false
	result, err := NewScanner().ScanWithHook(ScanOptions{Roots: []string{parent, child}}, func(event ScanProgress) {
		if !changed && event.Phase == "scanning" && event.CurrentPath == parent {
			changed = true
			if err := os.Rename(child, filepath.Join(base, "offline")); err != nil {
				t.Fatal(err)
			}
		}
	})
	var rootErr *ScanError
	if !changed || result != nil || !errors.As(err, &rootErr) || rootErr.Kind != ScanRootMissing {
		t.Fatalf("missing nested root fell back to partial scan: changed=%t result=%v err=%v", changed, result != nil, err)
	}
}

func TestNestedRootDelegationRespectsIndependentDepthBudgets(t *testing.T) {
	parent := t.TempDir()
	bridge := filepath.Join(parent, "bridge")
	child := filepath.Join(bridge, "series")
	leaf := filepath.Join(child, "leaf")
	for _, directory := range []string{parent, bridge, child, leaf} {
		mkdirAll(t, directory)
		touchAll(t, filepath.Join(directory, "page.png"))
	}
	scanner := NewScanner()
	result, err := scanner.Scan(ScanOptions{Roots: []string{parent, child}, MaxDepth: 1})
	if err != nil || result == nil || result.AlbumCount != 4 || len(result.Warnings) != 0 {
		t.Fatalf("delegated root lost independent depth budget: result=%+v err=%v", result, err)
	}
	// 同一个 Scanner 再次扫描父根时，不能残留上一轮的委派边界。
	result, err = scanner.Scan(ScanOptions{Roots: []string{parent}})
	if err != nil || result == nil || result.AlbumCount != 4 {
		t.Fatalf("nested-root policy leaked into next scan: result=%+v err=%v", result, err)
	}
}

func TestScanProgressPathUsesMostSpecificRoot(t *testing.T) {
	parent := t.TempDir()
	child := filepath.Join(parent, "series")
	for _, roots := range [][]string{{parent, child}, {child, parent}} {
		if got := relativeScanPath(filepath.Join(child, "album"), roots); got != "series/album" {
			t.Fatalf("nested root label=%q", got)
		}
		if got := relativeScanPath(child, roots); got != "series" {
			t.Fatalf("nested root itself labeled=%q", got)
		}
		if got := relativeScanPath(filepath.Join(parent, "series-backup"), roots); got != filepath.Base(parent)+"/series-backup" {
			t.Fatalf("neighboring prefix claimed by nested root: %q", got)
		}
		if got := relativeScanPath("", roots); got != "" {
			t.Fatalf("empty progress path labeled=%q", got)
		}
	}
}
