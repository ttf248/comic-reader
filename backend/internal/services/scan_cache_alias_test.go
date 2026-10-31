package services

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

func TestScanCacheLoadsEquivalentRootSpellingsWhileOffline(t *testing.T) {
	parent := t.TempDir()
	t.Chdir(parent)
	root := filepath.Join(parent, "photos")
	mkdirAll(t, root)
	touchAll(t, filepath.Join(root, "page.png"))
	result, err := NewScanner().Scan(ScanOptions{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(parent, "scan.json")
	cache := NewScanResultCache(path)
	cache.Set(result)
	if err := cache.Flush(); err != nil {
		t.Fatal(err)
	}
	moveTestRootOffline(t, parent, root)
	aliases := []string{"photos", root}
	if runtime.GOOS == "windows" {
		aliases = append(aliases, strings.ToUpper(root))
	}
	reopened := NewScanResultCache(path)
	mismatch, err := reopened.LoadWithRoots(aliases)
	if err != nil || mismatch || reopened.Get() == nil || reopened.Get().AlbumCount != 1 {
		t.Fatalf("equivalent offline roots lost cache: mismatch=%t result=%+v err=%v", mismatch, reopened.Get(), err)
	}
}

func TestScanCacheRejectsDuplicateOutputWithoutOverwritingDisk(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(t.TempDir(), "scan.json")
	cache := NewScanResultCache(path)
	cache.Set(&models.ScanResult{Roots: []string{root}, AlbumCount: 1})
	if err := cache.Flush(); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	cache.Set(&models.ScanResult{Roots: []string{root, root}, AlbumCount: 2})
	if err := cache.Flush(); err == nil {
		t.Fatal("duplicated root output was persisted")
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("invalid output overwrote healthy disk cache: %v", err)
	}
}

func TestScanCacheRejectsDuplicatedRootIdentity(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(t.TempDir(), "scan.json")
	envelope := scanCacheEnvelope{
		SchemaVersion: scanCacheSchemaVersion,
		RootIDs:       []string{rootIDFor(root), rootIDFor(root)},
		Result:        &models.ScanResult{Roots: []string{root, root}, AlbumCount: 2},
	}
	data, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	cache := NewScanResultCache(path)
	mismatch, err := cache.LoadWithRoots([]string{root, root})
	if err != nil || !mismatch || cache.Get() != nil {
		t.Fatalf("duplicated root cache accepted: mismatch=%t result=%+v err=%v", mismatch, cache.Get(), err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("invalid cache was not removed: %v", err)
	}
}
