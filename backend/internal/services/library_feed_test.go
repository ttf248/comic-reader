package services

import (
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
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

func TestMediaFeedRandomSeedIsReproducibleAndChangesWithSeed(t *testing.T) {
	fixture := newMediaFeedFixture(t)
	snapshot := fixture.catalog.Acquire()
	fetch := func(seed string) MediaFeedPage {
		page, err := PageMediaFeed(snapshot, MediaFeedQuery{
			Kind: LibraryKindPhoto, Scope: MediaFeedRandom, Seed: seed,
		}, "", 200)
		if err != nil {
			t.Fatal(err)
		}
		return page
	}
	first := fetch("seed-1")
	again := fetch("seed-1")
	other := fetch("seed-2")

	ids := func(page MediaFeedPage) []string {
		out := make([]string, 0, len(page.Items))
		for _, item := range page.Items {
			out = append(out, item.ID)
		}
		return out
	}
	// 同一个种子给同一批照片：可复现是「换一批能换掉」的前提。
	if !reflect.DeepEqual(ids(first), ids(again)) {
		t.Fatalf("same seed gave different batches:\n%v\n%v", ids(first), ids(again))
	}
	// 不同种子给不同的批次。
	if reflect.DeepEqual(ids(first), ids(other)) {
		t.Fatalf("different seeds gave the same batch: %v", ids(first))
	}
}

// 随机取材要分散：年份不同的相册各占一部分，同一本相册里的照片也不
// 该是连着的一段。
func TestMediaFeedRandomSpreadsAcrossAlbumsAndYears(t *testing.T) {
	catalog := newSpreadFeedFixture(t)
	snapshot := catalog.Acquire()
	page, err := PageMediaFeed(snapshot, MediaFeedQuery{
		Kind: LibraryKindPhoto, Scope: MediaFeedRandom, Seed: "spread",
	}, "", 200)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Albums) < 2 {
		t.Fatalf("albums = %d, want several albums", len(page.Albums))
	}
	// 同一本相册不能连着贡献一整段照片：交错排列时相邻的两张来自不同
	// 相册，墙上因此始终有多种内容。
	for i := 1; i < len(page.Items); i++ {
		if page.Items[i].AlbumID == page.Items[i-1].AlbumID {
			t.Fatalf("items %d and %d come from the same album %s", i-1, i, page.Items[i].AlbumID)
		}
	}
	// 一本相册里取出的照片要跨遍整本，不是开头那一段。
	biggest := ""
	for _, ref := range page.Albums {
		if ref.Count >= mediaFeedPerAlbum {
			biggest = ref.ID
			break
		}
	}
	if biggest == "" {
		t.Fatalf("no album contributed a full sample: %+v", page.Albums)
	}
	var picked []int
	for _, item := range page.Items {
		if item.AlbumID == biggest {
			picked = append(picked, item.Index)
		}
	}
	if len(picked) < mediaFeedPerAlbum {
		t.Fatalf("album contributed %d photos, want %d", len(picked), mediaFeedPerAlbum)
	}
	if picked[len(picked)-1]-picked[0] < mediaFeedPerAlbum {
		t.Fatalf("album photos are contiguous: %v", picked)
	}
}

// newSpreadFeedFixture 造一个能看出分散度的库：
//
//	root/2024年/album-2024   40 张（年份 2024）
//	root/2023年/album-2023   40 张（年份 2023）
//	root/2022年/album-2022   40 张（年份 2022）
//	root/2021年/album-2021   40 张（年份 2021）
func newSpreadFeedFixture(t *testing.T) *ResourceCatalog {
	t.Helper()
	root := t.TempDir()
	albums := []models.Album{}
	for _, year := range []int{2021, 2022, 2023, 2024} {
		dir := filepath.Join(root, fmt.Sprintf("%d年", year))
		files := make([]string, 0, 40)
		for i := 0; i < 40; i++ {
			files = append(files, filepath.Join(dir, fmt.Sprintf("IMG_%d%02d%02d_%06d.jpg", year, 1+i%12, 1+i%28, i)))
		}
		albums = append(albums, models.Album{
			Type: "album", Path: dir, Name: fmt.Sprintf("%d年", year), DisplayName: fmt.Sprintf("%d年", year),
			SourceRoot: root, SourceName: filepath.Base(root),
			ImageFiles: files, ImageCount: len(files),
			CoverImage: files[0], CoverKind: "image",
			ContentKind: string(models.ContentKindPhoto),
			ModTime:    time.Date(year, 1, 1, 0, 0, 0, 0, time.UTC),
		})
	}
	result := &models.ScanResult{
		Roots: []string{root}, Albums: albums,
		AlbumCount: len(albums),
		ScannedAt:  time.Date(2025, 2, 2, 0, 0, 0, 0, time.UTC), Duration: 1,
	}
	catalog := NewResourceCatalog()
	catalog.SetContentKindPolicy(NewContentKindPolicy([]RootKind{
		{Path: root, Kind: models.ContentKindPhoto},
	}))
	catalog.Publish(result, []string{root})
	return catalog
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
