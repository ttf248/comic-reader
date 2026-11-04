package services

import (
	"path/filepath"
	"testing"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

func TestAlbumOpenedUsesContentKindSpecificActivity(t *testing.T) {
	comic := LibraryNodeSummary{
		ID: "a_comic", Kind: string(ResourceAlbum), ImageCount: 10,
		ContentKind: string(models.ContentKindComic),
	}
	photo := LibraryNodeSummary{
		ID: "a_photo", Kind: string(ResourceAlbum), ImageCount: 10,
		ContentKind: string(models.ContentKindPhoto),
	}

	started := StartedAlbums{
		Image: map[string]struct{}{},
		Photo: map[string]struct{}{"a_photo": {}},
		Video: map[string]struct{}{},
	}

	if albumOpened(comic, started) {
		t.Fatal("photo activity must not mark a comic album as opened")
	}
	if !albumOpened(photo, started) {
		t.Fatal("photo activity should mark a photo album as opened")
	}

	started.Image["a_comic"] = struct{}{}
	if !albumOpened(comic, started) {
		t.Fatal("comic activity should mark a comic album as opened")
	}
}

func TestAlbumOpenedAcceptsLegacyImageActivityForPhotoAlbums(t *testing.T) {
	// 拆分两种用途之前，所有相册都用 image 活动记录位置。
	// 那批记录属于用户已经翻过的相册，不能因为拆分就重新变成未读。
	photo := LibraryNodeSummary{
		ID: "a_photo", Kind: string(ResourceAlbum), ImageCount: 10,
		ContentKind: string(models.ContentKindPhoto),
	}
	started := StartedAlbums{
		Image: map[string]struct{}{"a_photo": {}},
		Photo: map[string]struct{}{},
		Video: map[string]struct{}{},
	}
	if !albumOpened(photo, started) {
		t.Fatal("legacy image activity should keep a photo album opened")
	}
}

func TestAlbumOpenedUsesVideoActivityForVideoOnlyAlbums(t *testing.T) {
	video := LibraryNodeSummary{
		ID: "a_video", Kind: string(ResourceAlbum), VideoCount: 3,
		ContentKind: string(models.ContentKindPhoto),
	}
	started := StartedAlbums{
		Image: map[string]struct{}{},
		Photo: map[string]struct{}{},
		Video: map[string]struct{}{"a_video": {}},
	}
	if !albumOpened(video, started) {
		t.Fatal("video activity should mark a video-only album as opened")
	}
}

func TestContentKindStorePersistsAcrossReloads(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "state", "content_kinds.json")
	store := NewContentKindStore(path)
	albumPath := filepath.Join(root, "album")

	if err := store.Set(albumPath, models.ContentKindComic); err != nil {
		t.Fatalf("set: %v", err)
	}
	reloaded := NewContentKindStore(path)
	if err := reloaded.Load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := reloaded.Snapshot()[filepath.Clean(albumPath)]; got != models.ContentKindComic {
		t.Fatalf("kind = %q, want comic", got)
	}
}
