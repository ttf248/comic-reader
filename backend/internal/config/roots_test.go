package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestRootsCanonicalizeEquivalentSpellingsWithoutFilesystemAccess(t *testing.T) {
	parent := t.TempDir()
	t.Chdir(parent)
	root := filepath.Join(parent, "offline-library")
	paths := []string{"", " ", "offline-library", root, "./offline-library"}
	if runtime.GOOS == "windows" {
		paths = append(paths, strings.ToUpper(root))
	}
	cfg := &Config{MediaRoots: paths}
	roots := cfg.Roots()
	if len(roots) != 1 || roots[0] != root {
		t.Fatalf("roots were not canonicalized: %v", roots)
	}
	if cfg.MediaRoots[2] != "offline-library" {
		t.Fatal("reading roots mutated configuration")
	}
}

func TestRootAliasesPersistAsOneCanonicalYAMLRoot(t *testing.T) {
	parent := t.TempDir()
	t.Chdir(parent)
	root := filepath.Join(parent, "photos")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(parent, "config.yaml")
	cfg := Default()
	cfg.MediaRoots = []string{root}
	manager := NewManagerWith(cfg, path)
	aliases := []string{"photos", root}
	if runtime.GOOS == "windows" {
		aliases = append(aliases, strings.ToUpper(root))
	}
	if _, err := manager.Update(ConfigPatch{MediaRoots: aliases, MediaRootsSet: true}); err != nil {
		t.Fatal(err)
	}
	reloaded, err := LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(reloaded.MediaRoots) != 1 || reloaded.MediaRoots[0] != root {
		t.Fatalf("YAML retained duplicate or relative roots: %v", reloaded.MediaRoots)
	}
}
