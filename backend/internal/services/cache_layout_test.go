package services

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureCacheLayoutCreatesCurrentLayoutAndLeavesLegacyEntries(t *testing.T) {
	root := t.TempDir()
	legacyState := map[string]string{
		"scan_cache.json":      `{"schemaVersion":3}`,
		"web_settings.json":    `{"theme":"dark"}`,
		"activity.json":        `{"version":1,"activities":[]}`,
		"cover_overrides.json": `{"covers":{}}`,
	}
	for name, content := range legacyState {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	legacyThumb := filepath.Join(root, "0123456789abcdef0123456789abcdef.jpg")
	if err := os.WriteFile(legacyThumb, []byte("thumb"), 0o644); err != nil {
		t.Fatal(err)
	}
	unknown := filepath.Join(root, "user-note.jpg")
	if err := os.WriteFile(unknown, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}

	layout, err := EnsureCacheLayout(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{layout.StateDir, layout.DerivedDir, layout.TempDir, layout.ThumbnailDir, layout.MetadataDir} {
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			t.Errorf("current cache directory missing: %s (%v)", dir, err)
		}
	}
	if filepath.Dir(layout.AIJobsPath) != layout.StateDir || filepath.Dir(layout.MetadataDir) != layout.DerivedDir {
		t.Fatalf("AI task data crossed state/derived boundary: jobs=%q metadata=%q", layout.AIJobsPath, layout.MetadataDir)
	}
	for name := range legacyState {
		if _, err := os.Stat(filepath.Join(root, name)); err != nil {
			t.Errorf("legacy state %s should remain untouched: %v", name, err)
		}
	}
	if _, err := os.Stat(legacyThumb); err != nil {
		t.Fatalf("legacy thumbnail should remain untouched: %v", err)
	}
	if _, err := os.Stat(unknown); err != nil {
		t.Fatalf("unknown cache-root file must be preserved: %v", err)
	}
}

func TestThumbnailClearNeverDeletesUnknownFiles(t *testing.T) {
	dir := t.TempDir()
	svc, err := NewThumbnailService(ThumbnailOptions{CacheDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	thumb := filepath.Join(dir, "0123456789abcdef0123456789abcdef.jpg")
	state := filepath.Join(dir, "web_settings.json")
	unknownImage := filepath.Join(dir, "family-photo.jpg")
	for path, content := range map[string]string{thumb: "thumb", state: "{}", unknownImage: "photo"} {
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	deleted, _, err := svc.ClearThumbnails()
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 1 {
		t.Fatalf("deleted=%d, want 1", deleted)
	}
	if _, err := os.Stat(thumb); !os.IsNotExist(err) {
		t.Fatalf("thumbnail should be deleted, stat=%v", err)
	}
	for _, path := range []string{state, unknownImage} {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("non-cache file should be preserved: %s: %v", filepath.Base(path), err)
		}
	}
}
