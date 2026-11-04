package services

import (
	"path/filepath"
	"testing"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

func TestContentKindPolicyFallsBackToDefault(t *testing.T) {
	policy := NewContentKindPolicy("comic", []string{filepath.Join(t.TempDir(), "media")}, nil)

	if got := policy.KindFor(""); got != models.ContentKindComic {
		t.Fatalf("empty root kind = %q, want comic", got)
	}
	if got := policy.KindFor(filepath.Join(t.TempDir(), "other")); got != models.ContentKindComic {
		t.Fatalf("unconfigured root kind = %q, want comic", got)
	}
}

func TestContentKindPolicyResolvesPerRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "library")
	comicRoot := filepath.Join(t.TempDir(), "comics")
	policy := NewContentKindPolicy(
		"photo",
		[]string{root, comicRoot},
		map[string]string{comicRoot: "comic"},
	)

	if got := policy.KindFor(root); got != models.ContentKindPhoto {
		t.Fatalf("root kind = %q, want photo", got)
	}
	if got := policy.KindFor(comicRoot); got != models.ContentKindComic {
		t.Fatalf("comic root kind = %q, want comic", got)
	}
}

func TestContentKindPolicyIgnoresUnknownRootsAndKinds(t *testing.T) {
	root := filepath.Join(t.TempDir(), "library")
	other := filepath.Join(t.TempDir(), "elsewhere")
	policy := NewContentKindPolicy(
		"photo",
		[]string{root},
		map[string]string{other: "comic", root: "sketch"},
	)

	if got := policy.KindFor(root); got != models.ContentKindPhoto {
		t.Fatalf("invalid kind value should be ignored, got %q", got)
	}
	if got := policy.KindFor(other); got != models.ContentKindPhoto {
		t.Fatalf("root outside mediaRoots should be ignored, got %q", got)
	}
}

func TestApplyContentKindsPrefersAlbumOverride(t *testing.T) {
	photoRoot := filepath.Join(t.TempDir(), "photos")
	comicRoot := filepath.Join(t.TempDir(), "comics")
	photoAlbum := filepath.Join(photoRoot, "trip")
	comicAlbum := filepath.Join(comicRoot, "volume1")

	result := &models.ScanResult{
		Albums: []models.Album{
			{Path: photoAlbum, SourceRoot: photoRoot},
			{Path: comicAlbum, SourceRoot: comicRoot},
		},
	}
	policy := NewContentKindPolicy("photo", []string{photoRoot, comicRoot}, map[string]string{comicRoot: "comic"})

	ApplyContentKinds(result, map[string]models.ContentKind{
		filepath.Clean(photoAlbum): models.ContentKindComic,
	}, policy)

	if result.Albums[0].ContentKind != string(models.ContentKindComic) {
		t.Fatalf("override not applied: %q", result.Albums[0].ContentKind)
	}
	if !result.Albums[0].ContentKindOverridden {
		t.Fatal("override flag not set")
	}
	if result.Albums[1].ContentKind != string(models.ContentKindComic) {
		t.Fatalf("root default not applied: %q", result.Albums[1].ContentKind)
	}
	if result.Albums[1].ContentKindOverridden {
		t.Fatal("album without override must not be flagged as overridden")
	}
}

func TestApplyContentKindsReachesNestedAlbums(t *testing.T) {
	root := filepath.Join(t.TempDir(), "library")
	nested := filepath.Join(root, "2020", "event")
	result := &models.ScanResult{
		Collections: []models.Collection{{
			Path: filepath.Join(root, "2020"),
			Albums: []models.Album{
				{Path: nested, SourceRoot: root},
			},
		}},
		SmartCollections: []models.SmartCollection{{
			Tag:  "tag",
			Albums: []models.Album{
				{Path: nested, SourceRoot: root},
			},
		}},
	}
	policy := NewContentKindPolicy("comic", []string{root}, nil)

	ApplyContentKinds(result, nil, policy)

	if result.Collections[0].Albums[0].ContentKind != string(models.ContentKindComic) {
		t.Fatalf("nested album kind = %q, want comic", result.Collections[0].Albums[0].ContentKind)
	}
	if result.SmartCollections[0].Albums[0].ContentKind != string(models.ContentKindComic) {
		t.Fatalf("smart album kind = %q, want comic", result.SmartCollections[0].Albums[0].ContentKind)
	}
}

func TestContentKindStoreRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "content_kinds.json")
	store := NewContentKindStore(path)
	albumPath := filepath.Join(t.TempDir(), "album")

	if err := store.Set(albumPath, models.ContentKindComic); err != nil {
		t.Fatalf("set: %v", err)
	}
	reloaded := NewContentKindStore(path)
	if err := reloaded.Load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := reloaded.Snapshot()[filepath.Clean(albumPath)]; got != models.ContentKindComic {
		t.Fatalf("reloaded kind = %q, want comic", got)
	}
	if err := reloaded.Clear(albumPath); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if len(reloaded.Snapshot()) != 0 {
		t.Fatalf("expected empty snapshot, got %v", reloaded.Snapshot())
	}
}
