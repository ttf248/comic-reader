package services

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// newMediaFeedFixture 造一个按年份组织的照片库：
//
//	root/2024年/            集合：散图 1 张 + album-a 2 张 + album-b 1 张
//	root/2023旅行/          相册：1 张
//	root/其他/              相册：1 张（没有年份）
type mediaFeedFixture struct {
	catalog      *ResourceCatalog
	root         string
	collectionID string
	albumAID     string
}

func newMediaFeedFixture(t *testing.T) mediaFeedFixture {
	t.Helper()
	root := t.TempDir()
	yearPath := filepath.Join(root, "2024年")
	albumAPath := filepath.Join(yearPath, "album-a")
	albumBPath := filepath.Join(yearPath, "album-b")
	tripPath := filepath.Join(root, "2023旅行")
	otherPath := filepath.Join(root, "其他")

	virtual := models.Album{
		Type: "album", Path: yearPath, Name: "本目录媒体", DisplayName: "本目录媒体",
		SourceRoot: root, SourceName: filepath.Base(root), Virtual: true,
		Location:    "2024年",
		ImageFiles:  []string{filepath.Join(yearPath, "loose.jpg")},
		ImageCount:  1,
		CoverImage:  filepath.Join(yearPath, "loose.jpg"),
		CoverKind:   "image",
		ContentKind: string(models.ContentKindPhoto),
		ModTime:     time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC),
	}
	albumA := models.Album{
		Type: "album", Path: albumAPath, Name: "album-a", DisplayName: "album-a",
		SourceRoot: root, SourceName: filepath.Base(root),
		ImageFiles: []string{filepath.Join(albumAPath, "a1.jpg"), filepath.Join(albumAPath, "a2.jpg")},
		ImageCount: 2, CoverImage: filepath.Join(albumAPath, "a1.jpg"), CoverKind: "image",
		ContentKind: string(models.ContentKindPhoto),
		ModTime:     time.Date(2024, 1, 2, 0, 0, 0, 0, time.UTC),
	}
	albumB := models.Album{
		Type: "album", Path: albumBPath, Name: "album-b", DisplayName: "album-b",
		SourceRoot: root, SourceName: filepath.Base(root),
		ImageFiles: []string{filepath.Join(albumBPath, "b1.jpg")},
		ImageCount: 1, CoverImage: filepath.Join(albumBPath, "b1.jpg"), CoverKind: "image",
		ContentKind: string(models.ContentKindPhoto),
		ModTime:     time.Date(2024, 1, 3, 0, 0, 0, 0, time.UTC),
	}
	trip := models.Album{
		Type: "album", Path: tripPath, Name: "2023旅行", DisplayName: "2023旅行",
		SourceRoot: root, SourceName: filepath.Base(root),
		ImageFiles: []string{filepath.Join(tripPath, "t1.jpg")},
		ImageCount: 1, CoverImage: filepath.Join(tripPath, "t1.jpg"), CoverKind: "image",
		ContentKind: string(models.ContentKindPhoto),
		ModTime:     time.Date(2023, 5, 1, 0, 0, 0, 0, time.UTC),
	}
	other := models.Album{
		Type: "album", Path: otherPath, Name: "其他", DisplayName: "其他",
		SourceRoot: root, SourceName: filepath.Base(root),
		ImageFiles: []string{filepath.Join(otherPath, "o1.jpg")},
		ImageCount: 1, CoverImage: filepath.Join(otherPath, "o1.jpg"), CoverKind: "image",
		ContentKind: string(models.ContentKindPhoto),
		ModTime:     time.Date(2022, 5, 1, 0, 0, 0, 0, time.UTC),
	}
	collection := models.Collection{
		Type: "collection", Path: yearPath, Name: "2024年", DisplayName: "2024年",
		SourceRoot: root, Albums: []models.Album{virtual, albumA, albumB}, AlbumCount: 3,
	}
	result := &models.ScanResult{
		Roots: []string{root}, Albums: []models.Album{trip, other},
		Collections: []models.Collection{collection},
		AlbumCount:  5, CollectionCount: 1,
		ScannedAt: time.Date(2025, 2, 2, 0, 0, 0, 0, time.UTC), Duration: 1,
	}
	catalog := NewResourceCatalog()
	catalog.SetContentKindPolicy(NewContentKindPolicy([]RootKind{
		{Path: root, Kind: models.ContentKindPhoto},
	}))
	catalog.Publish(result, []string{root})
	return mediaFeedFixture{
		catalog:      catalog,
		root:         root,
		collectionID: catalog.ExternalID(yearPath, ResourceCollection),
		albumAID:     catalog.ExternalID(albumAPath, ResourceAlbum),
	}
}

func TestMediaFeedYearScopeSpansAlbumsAndKeepsSourceAlbum(t *testing.T) {
	fixture := newMediaFeedFixture(t)
	snapshot := fixture.catalog.Acquire()
	page, err := PageMediaFeed(snapshot, MediaFeedQuery{
		Kind: LibraryKindPhoto, Scope: MediaFeedYear, Year: "2024",
	}, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 4 {
		t.Fatalf("total = %d, want 4", page.Total)
	}
	if len(page.Items) != 4 {
		t.Fatalf("items = %d, want 4", len(page.Items))
	}
	albums := map[string]bool{}
	for _, item := range page.Items {
		if item.AlbumID == "" || item.AlbumName == "" {
			t.Fatalf("item misses source album: %+v", item)
		}
		albums[item.AlbumName] = true
	}
	if len(albums) != 3 {
		t.Fatalf("albums = %+v, want 3", albums)
	}
	if len(page.Albums) != 3 {
		t.Fatalf("album refs = %+v", page.Albums)
	}
	for _, ref := range page.Albums {
		if ref.Count != 1 && ref.Count != 2 {
			t.Fatalf("album ref count = %+v", ref)
		}
	}
	assertNoAbsolutePathInJSON(t, page)
}

func TestMediaFeedYearScopePagesAcrossAlbums(t *testing.T) {
	fixture := newMediaFeedFixture(t)
	snapshot := fixture.catalog.Acquire()
	first, err := PageMediaFeed(snapshot, MediaFeedQuery{
		Kind: LibraryKindPhoto, Scope: MediaFeedYear, Year: "2024",
	}, "", 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 3 || first.NextCursor == "" {
		t.Fatalf("first page = %d items, cursor = %q", len(first.Items), first.NextCursor)
	}
	second, err := PageMediaFeed(snapshot, MediaFeedQuery{
		Kind: LibraryKindPhoto, Scope: MediaFeedYear, Year: "2024",
	}, first.NextCursor, 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 1 || second.NextCursor != "" {
		t.Fatalf("second page = %d items, cursor = %q", len(second.Items), second.NextCursor)
	}
	seen := map[string]bool{}
	for _, item := range append(append([]FeedMediaItem{}, first.Items...), second.Items...) {
		if seen[item.ID] {
			t.Fatalf("duplicated item across pages: %s", item.ID)
		}
		seen[item.ID] = true
	}
}

func TestMediaFeedYearScopeReportsItsSources(t *testing.T) {
	fixture := newMediaFeedFixture(t)
	snapshot := fixture.catalog.Acquire()
	page, err := PageMediaFeed(snapshot, MediaFeedQuery{
		Kind: LibraryKindPhoto, Scope: MediaFeedYear, Year: "2024",
	}, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	// 年份页靠它说清「这一年的照片来自哪个集合」，也靠它回到那个集合。
	if len(page.Sources) != 1 {
		t.Fatalf("sources = %+v", page.Sources)
	}
	source := page.Sources[0]
	if source.ID != fixture.collectionID || source.Kind != "collection" {
		t.Fatalf("source = %+v", source)
	}
	if source.Name != "2024年" {
		t.Fatalf("source name = %q", source.Name)
	}
}

func TestMediaFeedOtherYearKeepsUndatedAlbums(t *testing.T) {
	fixture := newMediaFeedFixture(t)
	snapshot := fixture.catalog.Acquire()
	page, err := PageMediaFeed(snapshot, MediaFeedQuery{
		Kind: LibraryKindPhoto, Scope: MediaFeedYear, Year: "other",
	}, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	// 只有「其他」没有年份；「2023旅行」归到 2023 那一桶。
	if page.Total != 1 {
		t.Fatalf("total = %d, want 1", page.Total)
	}
	trip, err := PageMediaFeed(snapshot, MediaFeedQuery{
		Kind: LibraryKindPhoto, Scope: MediaFeedYear, Year: "2023",
	}, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if trip.Total != 1 || len(trip.Items) != 1 {
		t.Fatalf("2023 feed = %+v", trip)
	}
	if trip.Items[0].AlbumName != "2023旅行" {
		t.Fatalf("album name = %q", trip.Items[0].AlbumName)
	}
}

func TestMediaFeedCollectionScopeReturnsInnerAlbums(t *testing.T) {
	fixture := newMediaFeedFixture(t)
	snapshot := fixture.catalog.Acquire()
	page, err := PageMediaFeed(snapshot, MediaFeedQuery{
		Kind: LibraryKindPhoto, Scope: MediaFeedCollection, Parent: fixture.collectionID,
	}, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 4 {
		t.Fatalf("total = %d, want 4", page.Total)
	}
}

func TestMediaFeedCollectionScopeInterleavesAlbums(t *testing.T) {
	fixture := newMediaFeedFixture(t)
	snapshot := fixture.catalog.Acquire()
	page, err := PageMediaFeed(snapshot, MediaFeedQuery{
		Kind: LibraryKindPhoto, Scope: MediaFeedCollection, Parent: fixture.collectionID,
	}, "", 4)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 4 {
		t.Fatalf("items = %d, want 4", len(page.Items))
	}
	// 轮流取：前几张来自不同的相册，集合页的照片带才代表「里面有什么」。
	albums := map[string]bool{}
	for _, item := range page.Items {
		albums[item.AlbumID] = true
	}
	if len(albums) < 2 {
		t.Fatalf("albums = %+v, want several", albums)
	}
}

func TestMediaFeedCollectionScopeRejectsAlbumID(t *testing.T) {
	fixture := newMediaFeedFixture(t)
	snapshot := fixture.catalog.Acquire()
	_, err := PageMediaFeed(snapshot, MediaFeedQuery{
		Kind: LibraryKindPhoto, Scope: MediaFeedCollection, Parent: fixture.albumAID,
	}, "", 10)
	if !errors.Is(err, ErrLibraryResourceWrongKind) {
		t.Fatalf("err = %v, want wrong kind", err)
	}
}

func TestMediaFeedRecentAndRandomReturnBoundedAlbums(t *testing.T) {
	fixture := newMediaFeedFixture(t)
	snapshot := fixture.catalog.Acquire()
	for _, scope := range []MediaFeedScope{MediaFeedRecent, MediaFeedRandom} {
		page, err := PageMediaFeed(snapshot, MediaFeedQuery{
			Kind: LibraryKindPhoto, Scope: scope,
		}, "", 200)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Items) == 0 {
			t.Fatalf("%s feed is empty", scope)
		}
		if len(page.Items) > mediaFeedAlbumCount*mediaFeedPerAlbum {
			t.Fatalf("%s feed = %d items, too many", scope, len(page.Items))
		}
		for _, item := range page.Items {
			if item.AlbumID == "" {
				t.Fatalf("%s item misses album id: %+v", scope, item)
			}
		}
		assertNoAbsolutePathInJSON(t, page)
	}
}

func TestMediaFeedRejectsInvalidQueries(t *testing.T) {
	fixture := newMediaFeedFixture(t)
	snapshot := fixture.catalog.Acquire()
	cases := []MediaFeedQuery{
		{Kind: LibraryKindPhoto, Scope: MediaFeedYear},
		{Kind: LibraryKindPhoto, Scope: MediaFeedYear, Year: "88"},
		{Kind: LibraryKindPhoto, Scope: MediaFeedCollection},
		{Kind: LibraryKindPhoto, Scope: "nope"},
		{Kind: "music", Scope: MediaFeedRecent},
	}
	for _, query := range cases {
		if _, err := PageMediaFeed(snapshot, query, "", 10); !errors.Is(err, ErrInvalidMediaFeedQuery) {
			t.Fatalf("query %+v err = %v, want invalid query", query, err)
		}
	}
}

func TestMediaFeedRejectsCursorFromAnotherScope(t *testing.T) {
	fixture := newMediaFeedFixture(t)
	snapshot := fixture.catalog.Acquire()
	page, err := PageMediaFeed(snapshot, MediaFeedQuery{
		Kind: LibraryKindPhoto, Scope: MediaFeedYear, Year: "2024",
	}, "", 1)
	if err != nil {
		t.Fatal(err)
	}
	_, err = PageMediaFeed(snapshot, MediaFeedQuery{
		Kind: LibraryKindPhoto, Scope: MediaFeedYear, Year: "other",
	}, page.NextCursor, 1)
	if !errors.Is(err, ErrInvalidPageCursor) {
		t.Fatalf("err = %v, want invalid cursor", err)
	}
}
