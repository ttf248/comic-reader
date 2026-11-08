package store

import (
	"encoding/base64"
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

func batchAlbumID(index int) string {
	return "a_" + base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf("%016d", index)))
}

func TestBatchFavoritesValidatesEntireBatchAndPreservesExisting(t *testing.T) {
	s := NewPrefsStore(filepath.Join(t.TempDir(), "prefs.json"))
	first, second := batchAlbumID(1), batchAlbumID(2)
	_, _, err := s.BatchFavorites([]string{first}, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.BatchFavorites([]string{second, "invalid"}, true); err == nil {
		t.Fatal("invalid batch accepted")
	}
	p, _ := s.Get()
	if len(p.Favorites) != 1 {
		t.Fatal("invalid batch partially committed")
	}
	list, changed, err := s.BatchFavorites([]string{first, second, second, "smart:C++ 字面%2F"}, true)
	if err != nil || changed != 2 || len(list) != 3 {
		t.Fatalf("dedup: %v %d %v", list, changed, err)
	}
	list, changed, err = s.BatchFavorites([]string{first, first}, false)
	if err != nil || changed != 1 || len(list) != 2 {
		t.Fatalf("remove: %v %d %v", list, changed, err)
	}
	ids := make([]string, 501)
	for i := range ids {
		ids[i] = batchAlbumID(i + 100)
	}
	if _, _, err = s.BatchFavorites(ids, true); !errors.Is(err, ErrFavoriteLimit) {
		t.Fatalf("limit: %v", err)
	}
	p, _ = s.Get()
	if len(p.Favorites) != 2 {
		t.Fatal("limit evicted existing favorites")
	}
}

func TestDeleteBatchIsAtomicAndKeepsVideoActivity(t *testing.T) {
	s := NewActivityStore(filepath.Join(t.TempDir(), "activity.json"))
	id := batchAlbumID(1)
	image := models.Activity{AlbumID: id, MediaKind: models.MediaKindImage, PageCount: 3, PageIndex: 1}
	video := models.Activity{AlbumID: id, MediaKind: models.MediaKindVideo, ItemID: "f_AAAAAAAAAAAAAAAAAAAAAA", DurationMS: 1000, PositionMS: 500}
	if err := s.SetBatch([]models.Activity{image, video}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DeleteBatch([]models.ActivityIdentity{image.Identity(), {AlbumID: "bad", MediaKind: models.MediaKindImage}}); err == nil {
		t.Fatal("invalid batch accepted")
	}
	if _, exists, _ := s.Get(image.Identity()); !exists {
		t.Fatal("invalid batch partially deleted")
	}
	count, err := s.DeleteBatch([]models.ActivityIdentity{image.Identity(), image.Identity()})
	if err != nil || count != 1 {
		t.Fatalf("delete: %d %v", count, err)
	}
	if _, exists, _ := s.Get(video.Identity()); !exists {
		t.Fatal("image reset deleted playback")
	}
	count, err = s.DeleteBatch([]models.ActivityIdentity{image.Identity()})
	if err != nil || count != 0 {
		t.Fatalf("idempotence: %d %v", count, err)
	}
}
