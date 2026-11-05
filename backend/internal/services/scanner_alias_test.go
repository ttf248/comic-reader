package services

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

func TestScanEquivalentRootSpellingsProduceOneLibrary(t *testing.T) {
	parent := t.TempDir()
	t.Chdir(parent)
	root := filepath.Join(parent, "photos")
	mkdirAll(t, root)
	touchAll(t, filepath.Join(root, "page.png"))
	paths := []string{"photos", root, filepath.Join(root, "."), "./photos"}
	if runtime.GOOS == "windows" {
		paths = append(paths, strings.ToUpper(root))
	}
	result, err := NewScanner().ScanWithHook(ScanOptions{Roots: paths}, func(event ScanProgress) {
		if event.RootCount != 1 || event.RootIndex != 0 {
			t.Errorf("equivalent roots scanned repeatedly: %d/%d", event.RootIndex, event.RootCount)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Roots) != 1 || result.Roots[0] != root || result.AlbumCount != 1 {
		t.Fatalf("aliases duplicated library: roots=%v albums=%d", result.Roots, result.AlbumCount)
	}
	catalog := NewResourceCatalog()
	catalog.SetContentKindPolicy(NewContentKindPolicy([]RootKind{
		{Path: root, Kind: models.ContentKindComic},
	}))
	catalog.Publish(result, paths)
	manifest, err := BuildLibraryManifest(catalog.Acquire())
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Statistics.RootCount != 1 || manifest.Statistics.AlbumCount != 1 {
		t.Fatalf("aliases duplicated manifest: %+v", manifest.Statistics)
	}
	page, err := PageLibraryChildren(catalog.Acquire(), manifest.Roots[0].ID, LibraryKindComic, "", 10)
	if err != nil || page.Total != 1 || len(page.Items) != 1 {
		t.Fatalf("aliases duplicated children: total=%d items=%d err=%v", page.Total, len(page.Items), err)
	}
}
