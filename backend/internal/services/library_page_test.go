package services

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

type libraryPageFixture struct {
	catalog      *ResourceCatalog
	root         string
	rootID       string
	collectionID string
	albumID      string
}

func newLibraryPageFixture(t *testing.T) libraryPageFixture {
	t.Helper()
	root := t.TempDir()
	virtualPath := root
	album2Path := filepath.Join(root, "album2")
	album10Path := filepath.Join(root, "album10")
	collectionPath := filepath.Join(root, "collection3")
	nestedAlbumPath := filepath.Join(collectionPath, "nested1")
	virtualCover := filepath.Join(root, "cover.jpg")
	page1 := filepath.Join(album2Path, "page1.jpg")
	page2 := filepath.Join(album2Path, "page2.mp4")
	page3 := filepath.Join(album2Path, "page3.jpg")
	page10 := filepath.Join(album2Path, "page10.jpg")
	nestedCover := filepath.Join(nestedAlbumPath, "nested.jpg")
	album10Cover := filepath.Join(album10Path, "cover.jpg")

	virtual := models.Album{
		Type: "album", Path: virtualPath, Name: "本目录媒体", DisplayName: "本目录媒体",
		SourceRoot: root, SourceName: filepath.Base(root), Virtual: true,
		Location:   filepath.Base(root),
		ImageFiles: []string{virtualCover}, ImageCount: 1, CoverImage: virtualCover, CoverKind: "image",
	}
	album2 := models.Album{
		Type: "album", Path: album2Path, Name: "album2", DisplayName: "album2",
		SourceRoot: root, SourceName: filepath.Base(root),
		ImageFiles: []string{page10, page1, page3}, VideoFiles: []string{page2},
		ImageCount: 3, VideoCount: 1, CoverImage: page1, CoverKind: "image",
		Tags: []string{"旅行"}, Date: time.Date(2025, 2, 1, 0, 0, 0, 0, time.UTC), DateSource: "folder",
	}
	album10 := models.Album{
		Type: "album", Path: album10Path, Name: "album10", DisplayName: "album10",
		SourceRoot: root, ImageFiles: []string{album10Cover}, ImageCount: 1,
		CoverImage: album10Cover, CoverKind: "image", Tags: []string{"旅行"},
	}
	nested := models.Album{
		Type: "album", Path: nestedAlbumPath, Name: "nested1", DisplayName: "nested1",
		SourceRoot: root, ImageFiles: []string{nestedCover}, ImageCount: 1,
		CoverImage: nestedCover, CoverKind: "image",
	}
	collection := models.Collection{
		Type: "collection", Path: collectionPath, Name: "collection3", DisplayName: "collection3",
		SourceRoot: root, Albums: []models.Album{nested}, AlbumCount: 1,
	}
	result := &models.ScanResult{
		Roots: []string{root}, Albums: []models.Album{virtual, album2, album10},
		Collections: []models.Collection{collection}, AlbumCount: 4, CollectionCount: 1,
		ScannedAt: time.Date(2025, 2, 2, 0, 0, 0, 0, time.UTC), Duration: 123,
		SmartCollections: []models.SmartCollection{{
			Type: "smartCollection", Tag: "旅行",
			Albums: []models.Album{album10, album2}, AlbumCount: 2, CoverImage: page1,
		}},
	}
	catalog := NewResourceCatalog()
	// 夹具里的内容都属于同一个漫画目录：目录属性决定了列表作用域，
	// 这里统一按 comic 作用域查询。
	catalog.SetContentKindPolicy(NewContentKindPolicy([]RootKind{
		{Path: root, Kind: models.ContentKindComic},
	}))
	catalog.Publish(result, []string{root})
	return libraryPageFixture{
		catalog: catalog, root: root,
		rootID:       catalog.ExternalID(root, ResourceRoot),
		collectionID: catalog.ExternalID(collectionPath, ResourceCollection),
		albumID:      catalog.ExternalID(album2Path, ResourceAlbum),
	}
}

func TestLibraryManifestIsLightweightAndPathSafe(t *testing.T) {
	fixture := newLibraryPageFixture(t)
	manifest, err := BuildLibraryManifest(fixture.catalog.Acquire())
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Revision == 0 || len(manifest.Roots) != 1 || manifest.Roots[0].ID != fixture.rootID {
		t.Fatalf("manifest=%+v", manifest)
	}
	if manifest.Roots[0].ChildCount != 4 || manifest.Statistics.AlbumCount != 4 || manifest.Statistics.TagCount != 1 {
		t.Fatalf("manifest statistics=%+v roots=%+v", manifest.Statistics, manifest.Roots)
	}
	assertNoAbsolutePathInJSON(t, manifest)
}

func TestLibraryManifestIncludesBoundedWarningDetails(t *testing.T) {
	root := t.TempDir()
	warnings := make([]models.ScanWarning, 120)
	for i := range warnings {
		warnings[i] = models.ScanWarning{
			Code:    "metadata_unavailable",
			Path:    "library/album/page.jpg",
			Message: "无法读取媒体元数据",
		}
	}
	catalog := NewResourceCatalog()
	catalog.Publish(&models.ScanResult{Roots: []string{root}, Warnings: warnings}, []string{root})

	manifest, err := BuildLibraryManifest(catalog.Acquire())
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Statistics.WarningCount != len(warnings) {
		t.Fatalf("warning count = %d, want %d", manifest.Statistics.WarningCount, len(warnings))
	}
	if len(manifest.Warnings) != libraryManifestWarningLimit {
		t.Fatalf("warning details = %d, want %d", len(manifest.Warnings), libraryManifestWarningLimit)
	}
	assertNoAbsolutePathInJSON(t, manifest)
}

func TestLibraryChildrenUsesRevisionBoundCursorAndNaturalOrder(t *testing.T) {
	fixture := newLibraryPageFixture(t)
	snapshot := fixture.catalog.Acquire()
	first, err := PageLibraryChildren(snapshot, fixture.rootID, LibraryKindComic, "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if first.Total != 4 || len(first.Items) != 2 || first.NextCursor == "" {
		t.Fatalf("first page=%+v", first)
	}
	if first.Items[0].Name != "本目录媒体" || first.Items[1].Name != "album2" {
		t.Fatalf("first page order=%q, %q", first.Items[0].Name, first.Items[1].Name)
	}
	if first.Items[1].SourceRoot != fixture.rootID || len(first.Items[1].Tags) != 1 || first.Items[1].Tags[0] != "旅行" {
		t.Fatalf("album summary lost source/tag metadata: %+v", first.Items[1])
	}
	encoded, err := json.Marshal(first.Items[1])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), `"author"`) {
		t.Fatalf("album summary must not expose removed author alias: %s", encoded)
	}
	second, err := PageLibraryChildren(snapshot, fixture.rootID, LibraryKindComic, first.NextCursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 2 || second.Items[0].Name != "album10" || second.Items[1].Name != "collection3" || second.NextCursor != "" {
		t.Fatalf("second page=%+v", second)
	}

	nested, err := PageLibraryChildren(snapshot, fixture.collectionID, LibraryKindComic, "", 60)
	if err != nil || len(nested.Items) != 1 || nested.Items[0].Name != "nested1" {
		t.Fatalf("collection children=(%+v, %v)", nested, err)
	}
	assertNoAbsolutePathInJSON(t, first)
	assertNoAbsolutePathInJSON(t, second)

	fixture.catalog.Publish(&models.ScanResult{Roots: []string{fixture.root}}, []string{fixture.root})
	if _, err := PageLibraryChildren(fixture.catalog.Acquire(), fixture.rootID, LibraryKindComic, first.NextCursor, 2); !errors.Is(err, ErrStalePageCursor) {
		t.Fatalf("stale cursor error=%v, want ErrStalePageCursor", err)
	}
}

func TestAlbumMediaPageMergesImageAndVideoNaturalOrder(t *testing.T) {
	fixture := newLibraryPageFixture(t)
	first, err := PageAlbumMedia(fixture.catalog.Acquire(), fixture.albumID, "", 3)
	if err != nil {
		t.Fatal(err)
	}
	if first.Total != 4 || len(first.Items) != 3 || first.NextCursor == "" {
		t.Fatalf("first media page=%+v", first)
	}
	wantNames := []string{"page1.jpg", "page2.mp4", "page3.jpg"}
	wantKinds := []string{"image", "video", "image"}
	wantKindIndexes := []int{0, 0, 1}
	for i := range wantNames {
		if first.Items[i].Name != wantNames[i] || first.Items[i].Kind != wantKinds[i] ||
			first.Items[i].Index != i || first.Items[i].KindIndex != wantKindIndexes[i] {
			t.Fatalf("media[%d]=%+v, want name=%q kind=%q", i, first.Items[i], wantNames[i], wantKinds[i])
		}
	}
	second, err := PageAlbumMedia(fixture.catalog.Acquire(), fixture.albumID, first.NextCursor, 3)
	if err != nil || len(second.Items) != 1 || second.Items[0].Name != "page10.jpg" || second.Items[0].Index != 3 {
		t.Fatalf("second media page=(%+v, %v)", second, err)
	}
	assertNoAbsolutePathInJSON(t, first)
}

func TestLibraryNodeQueryUsesLightweightIndex(t *testing.T) {
	fixture := newLibraryPageFixture(t)
	snapshot := fixture.catalog.Acquire()
	resolved, err := ResolveLibraryNodes(snapshot, []string{fixture.collectionID, "a_missing", fixture.albumID})
	if err != nil {
		t.Fatal(err)
	}
	if len(resolved.Items) != 2 || resolved.Items[0].ID != fixture.collectionID || resolved.Items[1].ID != fixture.albumID {
		t.Fatalf("resolved items=%+v", resolved.Items)
	}
	if len(resolved.Missing) != 1 || resolved.Missing[0] != "a_missing" {
		t.Fatalf("missing=%v", resolved.Missing)
	}
	collection := resolved.Items[0]
	if collection.AlbumCount != 1 || collection.ImageCount != 1 || collection.MediaCount != 1 {
		t.Fatalf("collection aggregate=%+v", collection)
	}
	assertNoAbsolutePathInJSON(t, resolved)
}

func TestUnreadLibraryAlbumsUsesActivityIndexAndRevisionCursor(t *testing.T) {
	fixture := newLibraryPageFixture(t)
	snapshot := fixture.catalog.Acquire()
	index := NewUnreadLibraryIndex()
	started := StartedAlbums{Image: map[string]struct{}{fixture.albumID: {}}}
	first, err := index.Page(snapshot, started, 1, LibraryKindComic, "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if first.Total != 3 || len(first.Items) != 2 || first.NextCursor == "" {
		t.Fatalf("first unread page=%+v", first)
	}
	for _, item := range first.Items {
		if item.ID == fixture.albumID {
			t.Fatalf("started image album appeared in unread page=%+v", first)
		}
	}
	second, err := index.Page(snapshot, started, 1, LibraryKindComic, first.NextCursor, 2)
	if err != nil || len(second.Items) != 1 || second.NextCursor != "" {
		t.Fatalf("second unread page=(%+v, %v)", second, err)
	}
	assertNoAbsolutePathInJSON(t, first)
}

func TestUnreadLibraryIndexCachesByCatalogAndActivityRevision(t *testing.T) {
	fixture := newLibraryPageFixture(t)
	snapshot := fixture.catalog.Acquire()
	index := NewUnreadLibraryIndex()
	started := StartedAlbums{Image: map[string]struct{}{fixture.albumID: {}}}

	first, err := index.Page(snapshot, started, 1, LibraryKindComic, "", 2)
	if err != nil || first.Total != 3 || len(first.Items) != 2 || first.NextCursor == "" {
		t.Fatalf("first unread page=(%+v, %v)", first, err)
	}
	// 同一活动版本意味着调用方提供的是同一不可变活动快照；即使后续调用
	// 传入了不同 map，缓存也必须保持第一次构建的索引，不能重复筛全库。
	second, err := index.Page(snapshot, StartedAlbums{}, 1, LibraryKindComic, first.NextCursor, 2)
	if err != nil || second.Total != 3 || len(second.Items) != 1 || second.NextCursor != "" {
		t.Fatalf("cached unread page=(%+v, %v)", second, err)
	}

	refreshed, err := index.Page(snapshot, StartedAlbums{}, 2, LibraryKindComic, "", 2)
	if err != nil || refreshed.Total != 4 || len(refreshed.Items) != 2 || refreshed.NextCursor == "" {
		t.Fatalf("refreshed unread page=(%+v, %v)", refreshed, err)
	}
}

func TestLibrarySearchUsesPrecomputedPathSafeIndex(t *testing.T) {
	fixture := newLibraryPageFixture(t)
	hits := SearchLibrary(fixture.catalog.Acquire(), "旅行", LibraryKindComic, 10)
	if len(hits) != 3 || hits[0].Kind != "album" || hits[0].Path != fixture.albumID ||
		hits[1].Kind != "album" || hits[1].Name != "album10" ||
		hits[2].Kind != "smartCollection" || hits[2].Path != "smart:旅行" {
		t.Fatalf("search hits=%+v", hits)
	}
	if collectionHits := SearchLibrary(fixture.catalog.Acquire(), "collection3", LibraryKindComic, 10); len(collectionHits) != 1 ||
		collectionHits[0].Kind != "collection" || collectionHits[0].Path != fixture.collectionID {
		t.Fatalf("collection search hits=%+v", collectionHits)
	}
	assertNoAbsolutePathInJSON(t, hits)

	empty := NewResourceCatalog()
	if hits := SearchLibrary(empty.Acquire(), "旅行", LibraryKindComic, 10); len(hits) != 0 {
		t.Fatalf("unready library search hits=%+v", hits)
	}
}

// TestLibrarySummaryCarriesVirtualAlbumLocation 验证散图（"本目录媒体"）
// 的摘要带 location，搜索命中也用 location 而不是同名常量名。
//
// 背景：所有散图的 name 恒为"本目录媒体"，扁平列表里用户无法分辨归属目录。
func TestLibrarySummaryCarriesVirtualAlbumLocation(t *testing.T) {
	fixture := newLibraryPageFixture(t)
	snapshot := fixture.catalog.Acquire()

	children, err := PageLibraryChildren(snapshot, fixture.rootID, LibraryKindComic, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	var virtual *LibraryNodeSummary
	for i := range children.Items {
		if children.Items[i].Virtual {
			virtual = &children.Items[i]
		}
	}
	if virtual == nil {
		t.Fatalf("children page missing virtual album: %+v", children.Items)
	}
	if virtual.Location != filepath.Base(fixture.root) {
		t.Fatalf("virtual location=%q, want %q", virtual.Location, filepath.Base(fixture.root))
	}
	// name 保持语义常量，location 才是展示用的归属目录。
	if virtual.Name != models.VirtualAlbumName {
		t.Fatalf("virtual name=%q, want %q", virtual.Name, models.VirtualAlbumName)
	}
	// 展示名必须是归属目录：阅读器标题、属性弹窗、搜索结果都读它。
	if virtual.DisplayName != filepath.Base(fixture.root) {
		t.Fatalf("virtual displayName=%q, want %q", virtual.DisplayName, filepath.Base(fixture.root))
	}

	hits := SearchLibrary(snapshot, filepath.Base(fixture.root), LibraryKindComic, 10)
	if len(hits) != 1 || hits[0].Kind != "album" ||
		hits[0].Name != filepath.Base(fixture.root) {
		t.Fatalf("search by location hits=%+v", hits)
	}
	// 散图命中要带 virtual 标记：它的展示名是目录路径，和同名集合难区分。
	if !hits[0].Virtual {
		t.Fatalf("search hit should mark virtual album: %+v", hits[0])
	}
}

// 纯视频相册没有图片活动，未读判定只能依据视频活动：播放过一次后不应
// 继续留在未读列表里，否则纯视频相册会永远显示为未读。
func TestUnreadIndexExcludesVideoOnlyAlbumAfterVideoActivity(t *testing.T) {
	root := t.TempDir()
	videoPath := filepath.Join(root, "movie.mp4")
	if err := os.WriteFile(videoPath, []byte("video"), 0o600); err != nil {
		t.Fatal(err)
	}
	imagePath := filepath.Join(root, "photo.jpg")
	if err := os.WriteFile(imagePath, []byte("image"), 0o600); err != nil {
		t.Fatal(err)
	}
	videoAlbumPath := filepath.Join(root, "videos")
	imageAlbumPath := filepath.Join(root, "photos")
	videoAlbum := models.Album{
		Type: "album", Path: videoAlbumPath, Name: "videos", DisplayName: "videos",
		SourceRoot: root, SourceName: filepath.Base(root),
		VideoFiles: []string{videoPath}, VideoCount: 1,
		CoverImage: videoPath, CoverKind: "video",
	}
	imageAlbum := models.Album{
		Type: "album", Path: imageAlbumPath, Name: "photos", DisplayName: "photos",
		SourceRoot: root, SourceName: filepath.Base(root),
		ImageFiles: []string{imagePath}, ImageCount: 1,
		CoverImage: imagePath, CoverKind: "image",
	}
	result := &models.ScanResult{
		Roots: []string{root}, Albums: []models.Album{videoAlbum, imageAlbum},
		AlbumCount: 2, ScannedAt: time.Date(2025, 2, 2, 0, 0, 0, 0, time.UTC), Duration: 1,
	}
	catalog := NewResourceCatalog()
	catalog.SetContentKindPolicy(NewContentKindPolicy([]RootKind{
		{Path: root, Kind: models.ContentKindComic},
	}))
	catalog.Publish(result, []string{root})
	snapshot := catalog.Acquire()
	unreadIndex := NewUnreadLibraryIndex()
	videoAlbumID := catalog.ExternalID(videoAlbumPath, ResourceAlbum)

	summary, err := unreadIndex.Summary(snapshot, StartedAlbums{}, 1, LibraryKindComic)
	if err != nil {
		t.Fatal(err)
	}
	if summary.UnreadCount != 2 {
		t.Fatalf("unread count before any activity=%+v, want 2", summary)
	}

	// 只有视频活动时，纯视频相册已翻开，不再计入未读。
	started := StartedAlbums{Video: map[string]struct{}{videoAlbumID: {}}}
	summary, err = unreadIndex.Summary(snapshot, started, 2, LibraryKindComic)
	if err != nil {
		t.Fatal(err)
	}
	if summary.UnreadCount != 1 {
		t.Fatalf("unread count after video activity=%+v, want 1", summary)
	}

	// 图片相册仍然只认图片活动：视频活动不算它已翻开。
	page, err := unreadIndex.Page(snapshot, started, 3, LibraryKindComic, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != catalog.ExternalID(imageAlbumPath, ResourceAlbum) {
		t.Fatalf("unread page after video activity=%+v", page.Items)
	}
}

func TestRandomLibraryAlbumAndActivitySummaryUsePublishedIndex(t *testing.T) {
	fixture := newLibraryPageFixture(t)
	snapshot := fixture.catalog.Acquire()
	unreadIndex := NewUnreadLibraryIndex()

	random, err := RandomLibraryAlbums(snapshot, LibraryKindComic, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(random) != 1 || random[0].Kind != string(ResourceAlbum) || random[0].ID == "" {
		t.Fatalf("random album=%+v", random)
	}

	started := StartedAlbums{Image: map[string]struct{}{fixture.albumID: {}}}
	summary, err := unreadIndex.Summary(snapshot, started, 1, LibraryKindComic)
	if err != nil {
		t.Fatal(err)
	}
	if summary.Revision != snapshot.Revision() || summary.AlbumCount != 4 || summary.UnreadCount != 3 {
		t.Fatalf("activity summary=%+v", summary)
	}

	excludeAll := make(map[string]struct{}, len(snapshot.state.library.albums))
	for _, album := range snapshot.state.library.albums {
		excludeAll[album.ID] = struct{}{}
	}
	if _, err := unreadIndex.Random(snapshot, StartedAlbums{Image: excludeAll}, 2, LibraryKindComic, 1); !errors.Is(err, ErrLibraryNoMatchingAlbum) {
		t.Fatalf("all albums excluded error=%v, want ErrLibraryNoMatchingAlbum", err)
	}
	assertNoAbsolutePathInJSON(t, summary)
}

func TestLibraryHomeDashboardUsesCurrentImageCountAndLimitedUnreadPreview(t *testing.T) {
	fixture := newLibraryPageFixture(t)
	snapshot := fixture.catalog.Acquire()
	unreadIndex := NewUnreadLibraryIndex()
	started := StartedAlbums{Image: map[string]struct{}{fixture.albumID: {}}}

	dashboard, err := unreadIndex.Dashboard(snapshot, []models.Activity{{
		AlbumID: fixture.albumID, MediaKind: models.MediaKindImage,
		PageIndex: 1, PageCount: 99, Updated: time.Now().UTC(),
	}}, started, 1, LibraryKindComic)
	if err != nil {
		t.Fatal(err)
	}
	if dashboard.Revision != snapshot.Revision() || dashboard.AlbumCount != 4 || dashboard.UnreadCount != 3 || len(dashboard.Unread) != 3 {
		t.Fatalf("dashboard=%+v", dashboard)
	}
	if len(dashboard.InProgress) != 1 {
		t.Fatalf("in-progress=%+v", dashboard.InProgress)
	}
	progress := dashboard.InProgress[0]
	if progress.Album.ID != fixture.albumID || progress.PageIndex != 1 || progress.PageCount != 3 {
		t.Fatalf("progress=%+v", progress)
	}
	assertNoAbsolutePathInJSON(t, dashboard)
}

func TestLibraryActivitySummaryKeepsCurrentEmptyAlbumUnreadAfterRescan(t *testing.T) {
	root := t.TempDir()
	albumPath := filepath.Join(root, "video-only")
	videoPath := filepath.Join(albumPath, "clip.mp4")
	catalog := NewResourceCatalog()
	catalog.SetContentKindPolicy(NewContentKindPolicy([]RootKind{
		{Path: root, Kind: models.ContentKindComic},
	}))
	catalog.Publish(&models.ScanResult{
		Roots: []string{root},
		Albums: []models.Album{{
			Type: "album", Path: albumPath, Name: "video-only", SourceRoot: root,
			VideoFiles: []string{videoPath}, VideoCount: 1, CoverImage: videoPath, CoverKind: "video",
		}},
	}, []string{root})
	albumID := catalog.ExternalID(albumPath, ResourceAlbum)

	snapshot := catalog.Acquire()
	started := StartedAlbums{Image: map[string]struct{}{albumID: {}}}
	unreadIndex := NewUnreadLibraryIndex()
	summary, err := unreadIndex.Summary(snapshot, started, 1, LibraryKindComic)
	if err != nil || summary.UnreadCount != 1 {
		t.Fatalf("summary=(%+v, %v)", summary, err)
	}
	random, err := unreadIndex.Random(snapshot, started, 1, LibraryKindComic, 1)
	if err != nil || len(random) != 1 || random[0].ID != albumID {
		t.Fatalf("random unread=(%+v, %v)", random, err)
	}
	unread, err := unreadIndex.Page(snapshot, started, 1, LibraryKindComic, "", 60)
	if err != nil || unread.Total != 1 || len(unread.Items) != 1 || unread.Items[0].ID != albumID {
		t.Fatalf("unread page=(%+v, %v)", unread, err)
	}
}

func TestLibraryAlbumSummaryTracksOnlyActiveCustomCovers(t *testing.T) {
	root := t.TempDir()
	albumPath := filepath.Join(root, "album")
	if err := os.MkdirAll(albumPath, 0o755); err != nil {
		t.Fatal(err)
	}
	defaultCover := filepath.Join(albumPath, "default.jpg")
	customCover := filepath.Join(albumPath, "custom.jpg")
	for _, file := range []string{defaultCover, customCover} {
		if err := os.WriteFile(file, []byte("cover"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	result := &models.ScanResult{
		Roots: []string{root},
		Albums: []models.Album{{
			Type: "album", Path: albumPath, Name: "album",
			ImageFiles: []string{defaultCover, customCover}, ImageCount: 2,
			CoverImage: defaultCover, CoverKind: "image",
		}},
	}
	catalog := NewResourceCatalog()
	coverStore := NewCoverOverrideStore(filepath.Join(t.TempDir(), "cover_overrides.json"))
	if err := coverStore.Set(albumPath, customCover); err != nil {
		t.Fatal(err)
	}
	catalog.CommitScan(result, []string{root}, nil, coverStore)
	albumID := catalog.ExternalID(albumPath, ResourceAlbum)

	first, err := ResolveLibraryNodes(catalog.Acquire(), []string{albumID})
	if err != nil || len(first.Items) != 1 || !first.Items[0].HasCustomCover {
		t.Fatalf("custom cover summary=(%+v, %v)", first, err)
	}
	if err := coverStore.Clear(albumPath); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := catalog.RefreshCovers(nil, coverStore); !ok {
		t.Fatal("expected catalog cover refresh")
	}
	second, err := ResolveLibraryNodes(catalog.Acquire(), []string{albumID})
	if err != nil || len(second.Items) != 1 || second.Items[0].HasCustomCover {
		t.Fatalf("cleared cover summary=(%+v, %v)", second, err)
	}
}

func TestLibraryPageResponsesDoNotMutatePublishedIndex(t *testing.T) {
	fixture := newLibraryPageFixture(t)
	snapshot := fixture.catalog.Acquire()
	if snapshot.state.library == nil || len(snapshot.state.library.children[fixture.rootID]) != 4 {
		t.Fatalf("page index was not precomputed: %+v", snapshot.state.library)
	}
	first, err := PageLibraryChildren(snapshot, fixture.rootID, LibraryKindComic, "", 2)
	if err != nil {
		t.Fatal(err)
	}
	first.Items[0].Name = "mutated by caller"
	again, err := PageLibraryChildren(snapshot, fixture.rootID, LibraryKindComic, "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if again.Items[0].Name == "mutated by caller" {
		t.Fatal("page response shared its backing array with the immutable catalog")
	}
}

func TestTagsAndTagAlbumsArePagedWithoutFullAlbums(t *testing.T) {
	fixture := newLibraryPageFixture(t)
	tags, err := PageLibraryTags(fixture.catalog.Acquire(), LibraryKindComic, "", 60)
	if err != nil || len(tags.Items) != 1 || tags.Items[0].Tag != "旅行" || tags.Items[0].AlbumCount != 2 {
		t.Fatalf("tags=(%+v, %v)", tags, err)
	}
	albums, err := PageTagAlbums(fixture.catalog.Acquire(), "旅行", LibraryKindComic, "", 1)
	if err != nil || len(albums.Items) != 1 || albums.Items[0].Name != "album2" || albums.NextCursor == "" {
		t.Fatalf("tag albums=(%+v, %v)", albums, err)
	}
	if _, err := PageTagAlbums(fixture.catalog.Acquire(), "不存在", LibraryKindComic, "", 60); !errors.Is(err, ErrLibraryTagNotFound) {
		t.Fatalf("missing tag error=%v", err)
	}
	assertNoAbsolutePathInJSON(t, tags)
	assertNoAbsolutePathInJSON(t, albums)
}

func TestLibraryPageRejectsCursorFromAnotherScope(t *testing.T) {
	fixture := newLibraryPageFixture(t)
	children, err := PageLibraryChildren(fixture.catalog.Acquire(), fixture.rootID, LibraryKindComic, "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := PageAlbumMedia(fixture.catalog.Acquire(), fixture.albumID, children.NextCursor, 1); !errors.Is(err, ErrInvalidPageCursor) {
		t.Fatalf("cross-scope cursor error=%v, want ErrInvalidPageCursor", err)
	}
}

func TestNormalizeLibraryPageLimit(t *testing.T) {
	if got := NormalizeLibraryPageLimit(0); got != 60 {
		t.Fatalf("default limit=%d", got)
	}
	if got := NormalizeLibraryPageLimit(999); got != 200 {
		t.Fatalf("maximum limit=%d", got)
	}
}

func assertNoAbsolutePathInJSON(t *testing.T, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var decoded any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	var visit func(any)
	visit = func(current any) {
		switch typed := current.(type) {
		case string:
			if filepath.IsAbs(typed) {
				t.Fatalf("response exposed absolute path %q in %s", typed, data)
			}
		case []any:
			for _, item := range typed {
				visit(item)
			}
		case map[string]any:
			for _, item := range typed {
				visit(item)
			}
		}
	}
	visit(decoded)
}
