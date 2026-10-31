package services

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

func duplicatedNestedResult(parent, child string) *models.ScanResult {
	album := models.Album{Path: filepath.Join(child, "album"), SourceRoot: parent}
	return &models.ScanResult{
		Roots: []string{parent, child}, Albums: []models.Album{album}, AlbumCount: 2, CollectionCount: 1,
		Collections: []models.Collection{{Path: child, SourceRoot: parent, Albums: []models.Album{album}}},
	}
}

func TestScanCacheRejectsRepeatedPhysicalNodes(t *testing.T) {
	for _, kind := range []string{"album", "collection"} {
		t.Run(kind, func(t *testing.T) {
			parent := t.TempDir()
			child := filepath.Join(parent, "series")
			result := duplicatedNestedResult(parent, child)
			if kind == "collection" {
				result.Albums = nil
				result.Collections[0].Albums = nil
				result.Collections = append(result.Collections, result.Collections[0])
			}
			path := filepath.Join(t.TempDir(), "scan.json")
			data, err := json.Marshal(scanCacheEnvelope{
				SchemaVersion: scanCacheSchemaVersion, RootIDs: []string{rootIDFor(parent), rootIDFor(child)}, Result: result,
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, data, 0o644); err != nil {
				t.Fatal(err)
			}
			cache := NewScanResultCache(path)
			mismatch, err := cache.LoadWithRoots([]string{parent, child})
			if err != nil || !mismatch || cache.Get() != nil {
				t.Fatalf("repeated %s nodes restored: mismatch=%t result=%v err=%v", kind, mismatch, cache.Get() != nil, err)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("invalid repeated-node cache remained on disk: %v", err)
			}
		})
	}
}

func TestScanCacheDoesNotOverwriteDiskWithRepeatedPhysicalNodes(t *testing.T) {
	parent := t.TempDir()
	child := filepath.Join(parent, "series")
	path := filepath.Join(t.TempDir(), "scan.json")
	cache := NewScanResultCache(path)
	cache.Set(&models.ScanResult{Roots: []string{parent, child}, AlbumCount: 1})
	if err := cache.Flush(); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	cache.Set(duplicatedNestedResult(parent, child))
	if err := cache.Flush(); err == nil {
		t.Fatal("repeated physical nodes were persisted")
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("repeated physical nodes overwrote healthy cache: %v", err)
	}
}

func TestScanCacheAllowsVirtualAlbumAndRepeatedTagViews(t *testing.T) {
	root := t.TempDir()
	mixed := filepath.Join(root, "mixed")
	album := models.Album{Path: mixed, SourceRoot: root, Virtual: true}
	result := &models.ScanResult{
		Roots: []string{root}, AlbumCount: 1, CollectionCount: 1,
		Collections: []models.Collection{{Path: mixed, SourceRoot: root, Albums: []models.Album{album}}},
		SmartCollections: []models.SmartCollection{
			{Tag: "first", Albums: []models.Album{album}}, {Tag: "second", Albums: []models.Album{album}},
		},
	}
	path := filepath.Join(t.TempDir(), "scan.json")
	cache := NewScanResultCache(path)
	cache.Set(result)
	if err := cache.Flush(); err != nil {
		t.Fatal(err)
	}
	loaded := NewScanResultCache(path)
	mismatch, err := loaded.LoadWithRoots([]string{root})
	if err != nil || mismatch || loaded.Get() == nil || loaded.Get().AlbumCount != 1 || len(loaded.Get().SmartCollections) != 2 {
		t.Fatalf("valid virtual/tag views were rejected: mismatch=%t err=%v", mismatch, err)
	}
}
