package store

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

func testFileID(n int) string {
	return "f_" + testIDDigits(n)
}

func testIDDigits(n int) string {
	const width = 22
	value := []byte("0000000000000000000000")
	for i := width - 1; n > 0 && i >= 0; i-- {
		value[i] = byte('0' + n%10)
		n /= 10
	}
	return string(value)
}

func newTestActivityStore(t *testing.T) (*ActivityStore, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "activity.json")
	return NewActivityStore(path), path
}

func imageActivity(album int, page, count int) models.Activity {
	return models.Activity{
		AlbumID:   testAlbumID(album),
		MediaKind: models.MediaKindImage,
		PageIndex: page,
		PageCount: count,
		Updated:   time.Date(2026, 1, 1, 0, 0, album, 0, time.UTC),
	}
}

func TestActivityStorePersistsIndependentImageAndVideoActivities(t *testing.T) {
	store, path := newTestActivityStore(t)
	image := imageActivity(1, 3, 10)
	video := models.Activity{
		AlbumID:    testAlbumID(1),
		MediaKind:  models.MediaKindVideo,
		ItemID:     testFileID(1),
		PositionMS: 20_000,
		DurationMS: 100_000,
		Updated:    time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC),
	}
	if err := store.SetBatch([]models.Activity{image, video}); err != nil {
		t.Fatal(err)
	}

	reopened := NewActivityStore(path)
	got, err := reopened.Query([]models.ActivityIdentity{image.Identity(), video.Identity()})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].PageIndex != 3 || got[1].PositionMS != 20_000 {
		t.Fatalf("unexpected persisted activities: %+v", got)
	}
	if got[0].Status != models.ActivityInProgress || got[1].Status != models.ActivityInProgress {
		t.Fatalf("status was not derived: %+v", got)
	}
}

func TestActivityStoreBatchRejectsAllWhenOneItemIsInvalid(t *testing.T) {
	store, _ := newTestActivityStore(t)
	valid := imageActivity(1, 1, 4)
	invalid := imageActivity(2, 4, 4)
	if err := store.SetBatch([]models.Activity{valid, invalid}); err == nil {
		t.Fatal("invalid batch was accepted")
	}
	if _, exists, err := store.Get(valid.Identity()); err != nil || exists {
		t.Fatalf("invalid batch partially committed: exists=%v err=%v", exists, err)
	}
}

func TestActivityStoreDoesNotOverwriteNewerActivity(t *testing.T) {
	store, _ := newTestActivityStore(t)
	newer := imageActivity(1, 7, 10)
	newer.Updated = time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	older := imageActivity(1, 2, 10)
	older.Updated = newer.Updated.Add(-time.Second)
	if err := store.Set(newer); err != nil {
		t.Fatal(err)
	}
	if err := store.Set(older); err != nil {
		t.Fatal(err)
	}
	got, exists, err := store.Get(newer.Identity())
	if err != nil || !exists || got.PageIndex != newer.PageIndex {
		t.Fatalf("older activity overwrote newer value: activity=%+v exists=%v err=%v", got, exists, err)
	}
}

func TestActivityStoreStartedAlbumIDsSeparatesImageAndVideo(t *testing.T) {
	store, _ := newTestActivityStore(t)
	image := imageActivity(1, 1, 3)
	video := models.Activity{
		AlbumID:    testAlbumID(2),
		MediaKind:  models.MediaKindVideo,
		ItemID:     testFileID(2),
		PositionMS: 10_000,
		DurationMS: 20_000,
	}
	if err := store.SetBatch([]models.Activity{image, video}); err != nil {
		t.Fatal(err)
	}
	ids, videoIDs, _, err := store.StartedAlbumIDsSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 {
		t.Fatalf("image IDs=%v", ids)
	}
	if _, ok := ids[image.AlbumID]; !ok {
		t.Fatalf("missing image album ID %q", image.AlbumID)
	}
	if len(videoIDs) != 1 {
		t.Fatalf("video IDs=%v", videoIDs)
	}
	if _, ok := videoIDs[video.AlbumID]; !ok {
		t.Fatalf("missing video album ID %q", video.AlbumID)
	}
}

func TestActivityStoreStartedAlbumIDsSnapshotTracksActivityRevision(t *testing.T) {
	store, _ := newTestActivityStore(t)
	ids, _, initialRevision, err := store.StartedAlbumIDsSnapshot()
	if err != nil || initialRevision != 0 || len(ids) != 0 {
		t.Fatalf("initial snapshot=(ids=%v revision=%d err=%v)", ids, initialRevision, err)
	}

	video := models.Activity{
		AlbumID:    testAlbumID(2),
		MediaKind:  models.MediaKindVideo,
		ItemID:     testFileID(2),
		PositionMS: 10_000,
		DurationMS: 20_000,
	}
	if err := store.Set(video); err != nil {
		t.Fatal(err)
	}
	ids, _, videoRevision, err := store.StartedAlbumIDsSnapshot()
	if err != nil || videoRevision <= initialRevision || len(ids) != 0 {
		t.Fatalf("video snapshot=(ids=%v revision=%d err=%v)", ids, videoRevision, err)
	}

	image := imageActivity(1, 1, 3)
	if err := store.Set(image); err != nil {
		t.Fatal(err)
	}
	ids, _, imageRevision, err := store.StartedAlbumIDsSnapshot()
	if err != nil || imageRevision <= videoRevision || len(ids) != 1 {
		t.Fatalf("image snapshot=(ids=%v revision=%d err=%v)", ids, imageRevision, err)
	}
	delete(ids, image.AlbumID)
	ids, _, unchangedRevision, err := store.StartedAlbumIDsSnapshot()
	if err != nil || unchangedRevision != imageRevision {
		t.Fatalf("copied snapshot revision=(%d, %v), want %d", unchangedRevision, err, imageRevision)
	}
	if _, exists := ids[image.AlbumID]; !exists {
		t.Fatalf("mutating returned IDs changed store snapshot: %v", ids)
	}
}

func TestActivityStoreImageActivitySnapshotExcludesVideoRecords(t *testing.T) {
	store, _ := newTestActivityStore(t)
	image := imageActivity(1, 1, 3)
	video := models.Activity{
		AlbumID:    testAlbumID(2),
		MediaKind:  models.MediaKindVideo,
		ItemID:     testFileID(2),
		PositionMS: 10_000,
		DurationMS: 20_000,
	}
	if err := store.SetBatch([]models.Activity{image, video}); err != nil {
		t.Fatal(err)
	}
	activities, ids, revision, err := store.ImageActivitySnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if revision == 0 {
		t.Fatal("image activity snapshot revision was not advanced")
	}
	if len(activities) != 1 || activities[0].AlbumID != image.AlbumID || activities[0].MediaKind != models.MediaKindImage {
		t.Fatalf("image activities=%+v", activities)
	}
	if len(ids) != 1 {
		t.Fatalf("image album IDs=%v", ids)
	}
	if _, exists := ids[image.AlbumID]; !exists {
		t.Fatalf("missing image album ID %q", image.AlbumID)
	}
}

func TestActivityStoreDeleteAndClearAreIdempotent(t *testing.T) {
	store, _ := newTestActivityStore(t)
	first := imageActivity(1, 1, 3)
	second := imageActivity(2, 2, 3)
	if err := store.SetBatch([]models.Activity{first, second}); err != nil {
		t.Fatal(err)
	}
	removed, err := store.Delete(first.Identity())
	if err != nil || !removed {
		t.Fatalf("delete failed: removed=%v err=%v", removed, err)
	}
	removed, err = store.Delete(first.Identity())
	if err != nil || removed {
		t.Fatalf("second delete must be idempotent: removed=%v err=%v", removed, err)
	}
	count, err := store.Clear()
	if err != nil || count != 1 {
		t.Fatalf("clear failed: count=%d err=%v", count, err)
	}
	count, err = store.Clear()
	if err != nil || count != 0 {
		t.Fatalf("second clear must be idempotent: count=%d err=%v", count, err)
	}
}

func TestActivityStoreRecoversFromCorruptFileWithoutExposingIt(t *testing.T) {
	store, path := newTestActivityStore(t)
	if err := os.WriteFile(path, []byte(`{"version":`), 0o644); err != nil {
		t.Fatal(err)
	}
	activities, err := store.Query([]models.ActivityIdentity{{
		AlbumID: testAlbumID(1), MediaKind: models.MediaKindImage,
	}})
	if err != nil || len(activities) != 0 {
		t.Fatalf("corrupt file did not recover: %+v err=%v", activities, err)
	}
	matches, _ := filepath.Glob(path + ".corrupt.*")
	if len(matches) != 1 {
		t.Fatalf("corrupt file backup missing: %v", matches)
	}
}

func TestActivityStoreIsolatesUnsupportedVersionAndColdStarts(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "activity.json")
	future := []byte(`{"version":2,"activities":[]}`)
	if err := os.WriteFile(path, future, 0o644); err != nil {
		t.Fatal(err)
	}
	store := NewActivityStore(path)
	if err := store.Load(); err != nil {
		t.Fatalf("unsupported version should cold start: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("unsupported activity file should be isolated: %v", err)
	}
	matches, _ := filepath.Glob(path + ".unsupported.*")
	if len(matches) != 1 {
		t.Fatalf("unsupported activity backup missing: %v", matches)
	}
}
