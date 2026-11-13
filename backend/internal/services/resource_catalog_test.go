package services

import (
	"path/filepath"
	"testing"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

func TestResourceCatalogIndexesOpaqueResourceIDs(t *testing.T) {
	root := t.TempDir()
	albumPath := filepath.Join(root, "album")
	filePath := filepath.Join(albumPath, "page.jpg")
	result := &models.ScanResult{
		Roots: []string{root},
		Albums: []models.Album{{
			Type:       "album",
			Path:       albumPath,
			SourceRoot: root,
			ImageFiles: []string{filePath},
			CoverImage: filePath,
		}},
	}
	catalog := NewResourceCatalog()
	if catalog.Ready() {
		t.Fatal("new catalog should not be ready")
	}
	catalog.Publish(result, []string{root})
	if !catalog.Ready() {
		t.Fatal("rebuilt catalog should be ready")
	}

	albumID := catalog.ExternalID(albumPath, ResourceAlbum)
	if len(albumID) < 3 || albumID[:2] != "a_" {
		t.Fatalf("album id=%q", albumID)
	}
	fileID := catalog.ExternalID(filePath, ResourceFile)
	resolved, ok := catalog.Resolve(fileID)
	if !ok || resolved != filePath {
		t.Fatalf("Resolve()=(%q,%v), want %q", resolved, ok, filePath)
	}
}

func TestResourceCatalog_RejectsOutsideRoot(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.jpg")
	result := &models.ScanResult{Roots: []string{root}, Albums: []models.Album{{
		Path:       filepath.Join(root, "album"),
		CoverImage: outside,
	}}}
	catalog := NewResourceCatalog()
	catalog.Publish(result, []string{root})
	if got := catalog.ExternalID(outside, ResourceFile); got != "" {
		t.Fatalf("outside path received id %q", got)
	}
}

func TestResourceCatalog_VirtualAlbumAndCollectionSharePhysicalPath(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "mixed")
	file := filepath.Join(directory, "page.jpg")
	result := &models.ScanResult{
		Roots: []string{root},
		Collections: []models.Collection{{
			Type: "collection", Path: directory,
			Albums: []models.Album{{
				Type: "album", Path: directory, Virtual: true,
				ImageFiles: []string{file}, CoverImage: file,
			}},
		}},
	}
	catalog := NewResourceCatalog()
	catalog.Publish(result, []string{root})

	albumID := catalog.ExternalID(directory, ResourceAlbum)
	collectionID := catalog.ExternalID(directory, ResourceCollection)
	if albumID == "" || collectionID == "" || albumID == collectionID {
		t.Fatalf("albumID=%q collectionID=%q", albumID, collectionID)
	}
	for _, id := range []string{albumID, collectionID} {
		resolved, ok := catalog.Resolve(id)
		if !ok || resolved != directory {
			t.Fatalf("Resolve(%q)=(%q,%v), want %q", id, resolved, ok, directory)
		}
	}
}

func TestResourceCatalog_PhotoCountDeduplicatesVirtualAlbums(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "album")
	first := filepath.Join(directory, "1.jpg")
	second := filepath.Join(directory, "2.jpg")
	video := filepath.Join(directory, "clip.mp4")

	catalog := NewResourceCatalog()
	catalog.Publish(&models.ScanResult{
		Roots: []string{root},
		Albums: []models.Album{
			{Path: directory, ImageFiles: []string{first, second}, VideoFiles: []string{video}},
			// 虚拟相册指向同一批文件，不去重会算成四张。
			{Path: directory, Virtual: true, ImageFiles: []string{first, second}},
		},
	}, []string{root})

	if got := catalog.Acquire().PhotoCount(); got != 2 {
		t.Fatalf("PhotoCount()=%d, want 2", got)
	}
}

func TestResourceCatalog_AcquiredSnapshotRemainsVersionConsistent(t *testing.T) {
	rootA := t.TempDir()
	rootB := t.TempDir()
	albumA := filepath.Join(rootA, "album-a")
	fileA := filepath.Join(albumA, "1.jpg")
	albumB := filepath.Join(rootB, "album-b")
	fileB := filepath.Join(albumB, "1.jpg")

	catalog := NewResourceCatalog()
	revisionA := catalog.Publish(&models.ScanResult{
		Roots:  []string{rootA},
		Albums: []models.Album{{Path: albumA, ImageFiles: []string{fileA}, CoverImage: fileA}},
	}, []string{rootA})
	snapshotA := catalog.Acquire()
	albumAID := snapshotA.ExternalID(albumA, ResourceAlbum)

	revisionB := catalog.Publish(&models.ScanResult{
		Roots:  []string{rootB},
		Albums: []models.Album{{Path: albumB, ImageFiles: []string{fileB}, CoverImage: fileB}},
	}, []string{rootB})
	snapshotB := catalog.Acquire()

	if revisionB <= revisionA || snapshotA.Revision() != revisionA || snapshotB.Revision() != revisionB {
		t.Fatalf("revisions A=%d/%d B=%d/%d", revisionA, snapshotA.Revision(), revisionB, snapshotB.Revision())
	}
	if path, ok := snapshotA.Resolve(albumAID); !ok || path != albumA {
		t.Fatalf("pinned snapshot lost album A: (%q, %v)", path, ok)
	}
	if _, ok := snapshotB.Resolve(albumAID); ok {
		t.Fatal("new snapshot unexpectedly resolves removed album A")
	}
	if got := snapshotA.Result(); got == nil || len(got.Albums) != 1 || got.Albums[0].Path != albumA {
		t.Fatalf("snapshot A result drifted: %+v", got)
	}
}

func TestResourceCatalog_ClearInvalidatesPublishedIDs(t *testing.T) {
	root := t.TempDir()
	album := filepath.Join(root, "album")
	catalog := NewResourceCatalog()
	catalog.Publish(&models.ScanResult{
		Roots: []string{root}, Albums: []models.Album{{Path: album}},
	}, []string{root})
	id := catalog.ExternalID(album, ResourceAlbum)
	pinned := catalog.Acquire()

	clearRevision := catalog.Clear()
	if catalog.Ready() || catalog.Acquire().Revision() != clearRevision {
		t.Fatal("catalog should expose an empty revision after Clear")
	}
	if _, ok := catalog.Resolve(id); ok {
		t.Fatal("old id remained available after Clear")
	}
	if path, ok := pinned.Resolve(id); !ok || path != album {
		t.Fatal("an already acquired request snapshot must remain immutable")
	}
}
