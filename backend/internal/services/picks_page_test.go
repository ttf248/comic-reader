package services

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// newPhotoPicksFixture 造一个照片侧目录：一本相册三张图，另一本一张图。
func newPhotoPicksFixture(t *testing.T) (CatalogSnapshot, map[string]string, string) {
	t.Helper()
	root := t.TempDir()
	sep := string(filepath.Separator)
	albumAPath := root + sep + "albumA"
	albumBPath := root + sep + "albumB"
	first := albumAPath + sep + "1.jpg"
	second := albumAPath + sep + "2.jpg"
	third := albumAPath + sep + "3.jpg"
	other := albumBPath + sep + "4.jpg"

	albumA := models.Album{
		Type: "album", Path: albumAPath, Name: "albumA", DisplayName: "albumA",
		SourceRoot: root, SourceName: "root",
		ImageFiles: []string{first, second, third}, ImageCount: 3,
		CoverImage: first, CoverKind: "image", ContentKind: string(models.ContentKindPhoto),
	}
	albumB := models.Album{
		Type: "album", Path: albumBPath, Name: "albumB", DisplayName: "albumB",
		SourceRoot: root, SourceName: "root",
		ImageFiles: []string{other}, ImageCount: 1,
		CoverImage: other, CoverKind: "image", ContentKind: string(models.ContentKindPhoto),
	}
	catalog := NewResourceCatalog()
	catalog.SetContentKindPolicy(NewContentKindPolicy([]RootKind{
		{Path: root, Kind: models.ContentKindPhoto},
	}))
	catalog.Publish(&models.ScanResult{
		Roots: []string{root}, Albums: []models.Album{albumA, albumB},
		AlbumCount: 2, ScannedAt: time.Date(2025, 2, 2, 0, 0, 0, 0, time.UTC),
	}, []string{root})

	ids := map[string]string{
		"first":  catalog.ExternalID(first, ResourceFile),
		"second": catalog.ExternalID(second, ResourceFile),
		"third":  catalog.ExternalID(third, ResourceFile),
		"other":  catalog.ExternalID(other, ResourceFile),
		"albumA": catalog.ExternalID(albumAPath, ResourceAlbum),
		"albumB": catalog.ExternalID(albumBPath, ResourceAlbum),
	}
	return catalog.Acquire(), ids, root
}

func TestPagePicksResolvesPhotosWithAlbum(t *testing.T) {
	snapshot, ids, _ := newPhotoPicksFixture(t)
	page, err := PagePicks(snapshot, []string{ids["second"], ids["other"]}, 1, "", 50)
	if err != nil {
		t.Fatalf("page picks: %v", err)
	}
	if page.Total != 2 || len(page.Items) != 2 {
		t.Fatalf("expected 2 picks, got total=%d len=%d", page.Total, len(page.Items))
	}
	if page.Items[0].ID != ids["second"] || page.Items[0].AlbumID != ids["albumA"] {
		t.Fatalf("unexpected first pick: %+v", page.Items[0])
	}
	if page.Items[0].AlbumName != "albumA" {
		t.Fatalf("unexpected album name %q", page.Items[0].AlbumName)
	}
	if !page.Items[0].Picked {
		t.Fatal("expected pick flag to be set")
	}
	if page.Items[1].AlbumID != ids["albumB"] {
		t.Fatalf("unexpected second pick album: %+v", page.Items[1])
	}
}

func TestPagePicksSkipsUnknownFiles(t *testing.T) {
	snapshot, ids, _ := newPhotoPicksFixture(t)
	page, err := PagePicks(snapshot, []string{"f_missing", ids["first"]}, 1, "", 50)
	if err != nil {
		t.Fatalf("page picks: %v", err)
	}
	if page.Total != 1 || len(page.Items) != 1 || page.Items[0].ID != ids["first"] {
		t.Fatalf("unexpected picks page: %+v", page)
	}
}

func TestPagePicksKeepsGivenOrder(t *testing.T) {
	snapshot, ids, _ := newPhotoPicksFixture(t)
	// 精选列表按「最近加入在前」给，服务端不再重排。
	page, err := PagePicks(snapshot, []string{ids["third"], ids["first"]}, 1, "", 50)
	if err != nil {
		t.Fatalf("page picks: %v", err)
	}
	if page.Items[0].ID != ids["third"] || page.Items[1].ID != ids["first"] {
		t.Fatalf("unexpected order: %+v", page.Items)
	}
}

func TestPagePicksPaginates(t *testing.T) {
	snapshot, ids, _ := newPhotoPicksFixture(t)
	all := []string{ids["first"], ids["second"], ids["third"]}
	page, err := PagePicks(snapshot, all, 1, "", 2)
	if err != nil {
		t.Fatalf("page picks: %v", err)
	}
	if len(page.Items) != 2 || page.Total != 3 || page.NextCursor == "" {
		t.Fatalf("unexpected first page: %+v", page)
	}
	next, err := PagePicks(snapshot, all, 1, page.NextCursor, 2)
	if err != nil {
		t.Fatalf("page picks next: %v", err)
	}
	if len(next.Items) != 1 || next.NextCursor != "" {
		t.Fatalf("unexpected second page: %+v", next)
	}
}

func TestPagePicksCursorInvalidatedByPickChange(t *testing.T) {
	snapshot, ids, _ := newPhotoPicksFixture(t)
	all := []string{ids["first"], ids["second"], ids["third"]}
	page, err := PagePicks(snapshot, all, 1, "", 2)
	if err != nil {
		t.Fatalf("page picks: %v", err)
	}
	// 精选变了（版本 +1），旧游标必须失效：否则新加入的照片会把
	// 已翻过的页顶走一格。
	if _, err := PagePicks(snapshot, all, 2, page.NextCursor, 2); err == nil {
		t.Fatal("expected stale cursor to be rejected")
	}
}
