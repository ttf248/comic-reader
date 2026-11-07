package services

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// kindFixture 是一个按目录属性分开的媒体库：照片根下两本相册，漫画根下
// 两本相册与一个装着漫画卷的集合。它用来验证两个工作台的数据隔离：
// 照片工作台只看到照片根的内容，漫画工作台只看到漫画根的内容。
type kindFixture struct {
	catalog       *ResourceCatalog
	photoRoot     string
	comicRoot     string
	photoRootID   string
	comicRootID   string
	collectionID  string
	photoAlbumID  string
	comicAlbumID  string
	photoTagAlbum string
	comicTagAlbum string
}

func newKindFixture(t *testing.T) kindFixture {
	t.Helper()
	parent := t.TempDir()
	photoRoot := filepath.Join(parent, "photos")
	comicRoot := filepath.Join(parent, "comics")
	photoPath := filepath.Join(photoRoot, "photo")
	comicPath := filepath.Join(comicRoot, "comic")
	photoTagPath := filepath.Join(photoRoot, "photo-tag")
	comicTagPath := filepath.Join(comicRoot, "comic-tag")
	collectionPath := filepath.Join(comicRoot, "shelf")
	collectionComicPath := filepath.Join(collectionPath, "volume1")

	// 每本相册 3 张图：在读位置才有「还没翻到最后」的空间。
	album := func(path, name, tag, root string) models.Album {
		files := []string{
			filepath.Join(path, "p1.jpg"),
			filepath.Join(path, "p2.jpg"),
			filepath.Join(path, "p3.jpg"),
		}
		return models.Album{
			Type: "album", Path: path, Name: name, DisplayName: name,
			SourceRoot: root, ImageFiles: files, ImageCount: 3,
			CoverImage: files[0], CoverKind: "image", Tags: []string{tag},
		}
	}
	photo := album(photoPath, "photo", "风景", photoRoot)
	comic := album(comicPath, "comic", "漫画", comicRoot)
	photoTag := album(photoTagPath, "photo-tag", "共同", photoRoot)
	comicTag := album(comicTagPath, "comic-tag", "共同", comicRoot)
	volume := album(collectionComicPath, "volume1", "连载", comicRoot)

	collection := models.Collection{
		Type: "collection", Path: collectionPath, Name: "shelf", DisplayName: "shelf",
		SourceRoot: comicRoot, Albums: []models.Album{volume}, AlbumCount: 1,
	}
	result := &models.ScanResult{
		Roots:           []string{photoRoot, comicRoot},
		Albums:          []models.Album{photo, comic, photoTag, comicTag},
		Collections:     []models.Collection{collection},
		AlbumCount:      5,
		CollectionCount: 1,
		ScannedAt:       time.Date(2025, 2, 2, 0, 0, 0, 0, time.UTC),
		SmartCollections: []models.SmartCollection{
			{Type: "smartCollection", Tag: "共同", Albums: []models.Album{photoTag, comicTag}, AlbumCount: 2, CoverImage: photoTag.CoverImage},
			{Type: "smartCollection", Tag: "漫画", Albums: []models.Album{comic}, AlbumCount: 1, CoverImage: comic.CoverImage},
			{Type: "smartCollection", Tag: "风景", Albums: []models.Album{photo}, AlbumCount: 1, CoverImage: photo.CoverImage},
		},
	}
	catalog := NewResourceCatalog()
	// 属性只按目录设：照片根是照片，漫画根是漫画。
	catalog.SetContentKindPolicy(NewContentKindPolicy([]RootKind{
		{Path: photoRoot, Kind: models.ContentKindPhoto},
		{Path: comicRoot, Kind: models.ContentKindComic},
	}))
	catalog.Publish(result, []string{photoRoot, comicRoot})
	return kindFixture{
		catalog:       catalog,
		photoRoot:     photoRoot,
		comicRoot:     comicRoot,
		photoRootID:   catalog.ExternalID(photoRoot, ResourceRoot),
		comicRootID:   catalog.ExternalID(comicRoot, ResourceRoot),
		collectionID:  catalog.ExternalID(collectionPath, ResourceCollection),
		photoAlbumID:  catalog.ExternalID(photoPath, ResourceAlbum),
		comicAlbumID:  catalog.ExternalID(comicPath, ResourceAlbum),
		photoTagAlbum: catalog.ExternalID(photoTagPath, ResourceAlbum),
		comicTagAlbum: catalog.ExternalID(comicTagPath, ResourceAlbum),
	}
}

func TestLibraryChildrenAreIsolatedByRootKind(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()

	photo, err := PageLibraryChildren(snapshot, fixture.photoRootID, LibraryKindPhoto, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if photo.Total != 2 {
		t.Fatalf("photo children total=%d, want 2", photo.Total)
	}
	for _, item := range photo.Items {
		if item.ContentKind != string(LibraryKindPhoto) {
			t.Fatalf("photo scope leaked a comic node %+v", item)
		}
	}

	comic, err := PageLibraryChildren(snapshot, fixture.comicRootID, LibraryKindComic, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	// 2 本漫画相册 + 1 个漫画集合。
	if comic.Total != 3 {
		t.Fatalf("comic children total=%d, want 3", comic.Total)
	}
	for _, item := range comic.Items {
		if item.ContentKind != string(LibraryKindComic) {
			t.Fatalf("comic scope leaked a photo node %+v", item)
		}
	}
}

// 集合继承所属目录的属性：漫画目录下的集合在照片工作台里不该出现。
func TestLibraryChildrenFilterCollectionsByRootKind(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()

	photo, err := PageLibraryChildren(snapshot, fixture.comicRootID, LibraryKindPhoto, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if photo.Total != 0 {
		t.Fatalf("photo scope kept comic-root children: %+v", photo.Items)
	}
}

func TestLibraryCursorScopeSeparatesKinds(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()

	first, err := PageLibraryChildren(snapshot, fixture.comicRootID, LibraryKindComic, "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if first.NextCursor == "" {
		t.Fatal("expected a next cursor for the first page")
	}
	if _, err := PageLibraryChildren(snapshot, fixture.comicRootID, LibraryKindPhoto, first.NextCursor, 1); !errors.Is(err, ErrInvalidPageCursor) {
		t.Fatalf("cross-kind cursor error=%v, want ErrInvalidPageCursor", err)
	}
	if _, err := PageLibraryChildren(snapshot, fixture.comicRootID, LibraryKindComic, first.NextCursor, 1); err != nil {
		t.Fatalf("same-kind cursor error=%v", err)
	}
}

func TestLibraryTagsAreKindScoped(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()

	photo, err := PageLibraryTags(snapshot, LibraryKindPhoto, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, tag := range photo.Items {
		if tag.Tag == "漫画" {
			t.Fatalf("photo scope kept a comic-only tag: %+v", photo.Items)
		}
		if tag.Tag == "共同" && tag.AlbumCount != 1 {
			t.Fatalf("shared tag count=%d, want 1", tag.AlbumCount)
		}
	}

	comic, err := PageLibraryTags(snapshot, LibraryKindComic, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	var foundComic bool
	for _, tag := range comic.Items {
		if tag.Tag == "漫画" {
			foundComic = true
		}
		if tag.Tag == "风景" {
			t.Fatalf("comic scope kept a photo-only tag: %+v", comic.Items)
		}
	}
	if !foundComic {
		t.Fatalf("comic scope dropped the comic-only tag: %+v", comic.Items)
	}
}

func TestTagAlbumsAreKindScoped(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()

	photo, err := PageTagAlbums(snapshot, "共同", LibraryKindPhoto, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if photo.Total != 1 || photo.Items[0].ID != fixture.photoTagAlbum {
		t.Fatalf("photo tag albums=%+v", photo)
	}

	comic, err := PageTagAlbums(snapshot, "共同", LibraryKindComic, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if comic.Total != 1 || comic.Items[0].ID != fixture.comicTagAlbum {
		t.Fatalf("comic tag albums=%+v", comic)
	}
}

func TestLibraryManifestReportsPerKindAlbumCounts(t *testing.T) {
	fixture := newKindFixture(t)
	manifest, err := BuildLibraryManifest(fixture.catalog.Acquire())
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Statistics.AlbumCount != 5 {
		t.Fatalf("album count=%d, want the whole-library total 5", manifest.Statistics.AlbumCount)
	}
	if manifest.Statistics.PhotoAlbumCount != 2 {
		t.Fatalf("photo album count=%d, want 2", manifest.Statistics.PhotoAlbumCount)
	}
	if manifest.Statistics.ComicAlbumCount != 3 {
		t.Fatalf("comic album count=%d, want 3", manifest.Statistics.ComicAlbumCount)
	}
}

// manifest 报告每个根的属性，前端据此把目录归到对应的工作台。
func TestLibraryManifestReportsRootKind(t *testing.T) {
	fixture := newKindFixture(t)
	manifest, err := BuildLibraryManifest(fixture.catalog.Acquire())
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]string{}
	for _, root := range manifest.Roots {
		kinds[root.ID] = root.ContentKind
	}
	if kinds[fixture.photoRootID] != string(models.ContentKindPhoto) {
		t.Fatalf("photo root kind=%q", kinds[fixture.photoRootID])
	}
	if kinds[fixture.comicRootID] != string(models.ContentKindComic) {
		t.Fatalf("comic root kind=%q", kinds[fixture.comicRootID])
	}
}

func TestRandomLibraryAlbumRespectsKind(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()

	for i := 0; i < 20; i++ {
		albums, err := RandomLibraryAlbums(snapshot, LibraryKindComic, 1)
		if err != nil {
			t.Fatal(err)
		}
		if len(albums) != 1 {
			t.Fatalf("random comic albums=%+v", albums)
		}
		if albums[0].ContentKind != string(models.ContentKindComic) {
			t.Fatalf("random comic album=%+v", albums[0])
		}
	}
}

// 一次抽多本时不能抽出重复的相册，也不能混进别的内容属性。
func TestRandomLibraryAlbumsAreDistinctAndKindScoped(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()

	albums, err := RandomLibraryAlbums(snapshot, LibraryKindComic, 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(albums) != 3 {
		t.Fatalf("random comic albums=%d, want 3", len(albums))
	}
	seen := map[string]bool{}
	for _, album := range albums {
		if album.ContentKind != string(models.ContentKindComic) {
			t.Fatalf("random comic album=%+v", album)
		}
		if seen[album.ID] {
			t.Fatalf("duplicate random album=%s", album.ID)
		}
		seen[album.ID] = true
	}
}

func TestSearchLibraryFiltersHitsByKind(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()

	hits := SearchLibrary(snapshot, "共同", LibraryKindPhoto, 10)
	var albumPaths []string
	var smartFound bool
	for _, hit := range hits {
		switch hit.Kind {
		case string(ResourceAlbum):
			albumPaths = append(albumPaths, hit.Path)
		case "smartCollection":
			smartFound = true
		}
	}
	if len(albumPaths) != 1 || albumPaths[0] != fixture.photoTagAlbum {
		t.Fatalf("photo search album hits=%+v", hits)
	}
	// 标签跨两个属性，但照片工作台里它只保留照片侧的那本。
	if !smartFound {
		t.Fatalf("search dropped the shared tag: %+v", hits)
	}
}

// 未读只统计漫画相册：照片目录下的相册不记录阅读进度。
func TestUnreadIndexOnlyCountsComicAlbums(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()
	index := NewUnreadLibraryIndex()

	photo, err := index.Page(snapshot, StartedAlbums{}, 1, LibraryKindPhoto, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if photo.Total != 0 {
		t.Fatalf("photo unread total=%d, want 0", photo.Total)
	}
	comic, err := index.Page(snapshot, StartedAlbums{}, 1, LibraryKindComic, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if comic.Total != 3 {
		t.Fatalf("comic unread total=%d, want 3", comic.Total)
	}
}

// 在读位置只来自漫画阅读记录；照片工作台没有这一区。
func TestDashboardInProgressOnlyCoversComicAlbums(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()
	index := NewUnreadLibraryIndex()

	now := time.Now().UTC()
	dashboard, err := index.Dashboard(snapshot,
		[]models.Activity{
			{
				AlbumID: fixture.comicAlbumID, MediaKind: models.MediaKindImage,
				PageIndex: 1, PageCount: 3, Updated: now,
			},
			{
				AlbumID: fixture.photoAlbumID, MediaKind: models.MediaKindImage,
				PageIndex: 1, PageCount: 3, Updated: now,
			},
		},
		StartedAlbums{}, 1, LibraryKindComic)
	if err != nil {
		t.Fatal(err)
	}
	if len(dashboard.InProgress) != 1 {
		t.Fatalf("in progress=%+v, want only the comic album", dashboard.InProgress)
	}
	if dashboard.InProgress[0].Album.ID != fixture.comicAlbumID {
		t.Fatalf("in progress album=%s", dashboard.InProgress[0].Album.ID)
	}
	if dashboard.InProgress[0].PageIndex != 1 {
		t.Fatalf("page index=%d", dashboard.InProgress[0].PageIndex)
	}
}

// 照片工作台的 dashboard 没有在读区：阅读进度只属于漫画。
func TestDashboardHasNoInProgressInPhotoScope(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()
	index := NewUnreadLibraryIndex()

	dashboard, err := index.Dashboard(snapshot,
		[]models.Activity{{
			AlbumID: fixture.comicAlbumID, MediaKind: models.MediaKindImage,
			PageIndex: 1, PageCount: 3, Updated: time.Now().UTC(),
		}},
		StartedAlbums{}, 1, LibraryKindPhoto)
	if err != nil {
		t.Fatal(err)
	}
	if len(dashboard.InProgress) != 0 {
		t.Fatalf("photo scope kept in-progress entries: %+v", dashboard.InProgress)
	}
}

// 改目录属性不必重扫磁盘：属性只影响相册元数据，
// 重新发布快照后列表立即按新属性收敛。
// 这条覆盖「设置页改属性 → 进程内列表立刻按新属性过滤」的完整语义。
func TestChangingRootKindRepublishesWithoutRescan(t *testing.T) {
	fixture := newKindFixture(t)

	// 改之前：漫画根是漫画，照片作用域下看不到它的内容。
	before, err := PageLibraryChildren(fixture.catalog.Acquire(), fixture.comicRootID, LibraryKindPhoto, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if before.Total != 0 {
		t.Fatalf("photo scope saw comic-root children before the change: %+v", before.Items)
	}

	// 把漫画根改成照片目录。
	fixture.catalog.SetContentKindPolicy(NewContentKindPolicy([]RootKind{
		{Path: fixture.photoRoot, Kind: models.ContentKindPhoto},
		{Path: fixture.comicRoot, Kind: models.ContentKindPhoto},
	}))

	after, err := PageLibraryChildren(fixture.catalog.Acquire(), fixture.comicRootID, LibraryKindPhoto, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if after.Total != 3 {
		t.Fatalf("photo scope total=%d, want 3 after the change", after.Total)
	}
	for _, item := range after.Items {
		if item.ContentKind != string(LibraryKindPhoto) {
			t.Fatalf("node kept the old kind: %+v", item)
		}
	}

	// 反过来，漫画作用域现在应该看不到这些内容。
	comic, err := PageLibraryChildren(fixture.catalog.Acquire(), fixture.comicRootID, LibraryKindComic, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if comic.Total != 0 {
		t.Fatalf("comic scope still sees re-rooted children: %+v", comic.Items)
	}
}

// 按名解析标签要同时给出两侧的册数：客户端据此区分
// 「这个标签失效了」和「它只属于另一侧」。
func TestResolveLibraryTagsReportsBothSides(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()

	result, err := ResolveLibraryTags(snapshot, []string{"共同", "漫画", "风景", "不存在的标签"})
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]LibraryTagSummary{}
	for _, item := range result.Items {
		counts[item.Tag] = item
	}
	if len(counts) != 3 {
		t.Fatalf("items=%d want 3", len(counts))
	}
	shared := counts["共同"]
	if shared.PhotoAlbumCount != 1 || shared.ComicAlbumCount != 1 {
		t.Fatalf("共同 photo=%d comic=%d want 1/1", shared.PhotoAlbumCount, shared.ComicAlbumCount)
	}
	if shared.AlbumCount != 2 {
		t.Fatalf("共同 albumCount=%d want 2", shared.AlbumCount)
	}
	comicOnly := counts["漫画"]
	if comicOnly.PhotoAlbumCount != 0 || comicOnly.ComicAlbumCount != 1 {
		t.Fatalf("漫画 photo=%d comic=%d want 0/1", comicOnly.PhotoAlbumCount, comicOnly.ComicAlbumCount)
	}
	photoOnly := counts["风景"]
	if photoOnly.PhotoAlbumCount != 1 || photoOnly.ComicAlbumCount != 0 {
		t.Fatalf("风景 photo=%d comic=%d want 1/0", photoOnly.PhotoAlbumCount, photoOnly.ComicAlbumCount)
	}
	if len(result.Missing) != 1 || result.Missing[0] != "不存在的标签" {
		t.Fatalf("missing=%v want [不存在的标签]", result.Missing)
	}
}

// 「最近加入」按属性分侧，并按业务日期倒序。
func TestPageLibraryRecentIsKindScopedAndSorted(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()

	photo, err := PageLibraryRecent(snapshot, LibraryKindPhoto, 10)
	if err != nil {
		t.Fatal(err)
	}
	if photo.Total != 2 {
		t.Fatalf("photo recent total=%d want 2", photo.Total)
	}
	for _, item := range photo.Items {
		if item.ContentKind != string(LibraryKindPhoto) {
			t.Fatalf("photo scope leaked a comic album %+v", item)
		}
	}
	comic, err := PageLibraryRecent(snapshot, LibraryKindComic, 10)
	if err != nil {
		t.Fatal(err)
	}
	if comic.Total != 3 {
		t.Fatalf("comic recent total=%d want 3", comic.Total)
	}
	for _, item := range comic.Items {
		if item.ContentKind != string(LibraryKindComic) {
			t.Fatalf("comic scope leaked a photo album %+v", item)
		}
	}

	// 限制条数时只截断，不改顺序。
	limited, err := PageLibraryRecent(snapshot, LibraryKindComic, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(limited.Items) != 1 {
		t.Fatalf("limited items=%d want 1", len(limited.Items))
	}
	if limited.Items[0].ID != comic.Items[0].ID {
		t.Fatalf("limited first=%s want %s", limited.Items[0].ID, comic.Items[0].ID)
	}
}

// 相册的「所属系列」是它直接上级集合的名字；根目录下的相册没有上级集合。
func TestAlbumSummaryCarriesParentSeries(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()

	volumeID := fixture.catalog.ExternalID(filepath.Join(fixture.comicRoot, "shelf", "volume1"), ResourceAlbum)
	node, ok := snapshot.state.library.nodes[volumeID]
	if !ok {
		t.Fatalf("volume album %s not indexed", volumeID)
	}
	if node.ParentName != "shelf" {
		t.Fatalf("parentName=%q want shelf", node.ParentName)
	}

	// 根目录下的相册没有上级集合。
	rootAlbum, ok := snapshot.state.library.nodes[fixture.comicAlbumID]
	if !ok {
		t.Fatalf("comic album %s not indexed", fixture.comicAlbumID)
	}
	if rootAlbum.ParentName != "" {
		t.Fatalf("parentName=%q want empty", rootAlbum.ParentName)
	}
}

// 库规模按属性拆开：两个工作台各自的相册数与集合数都要能报出来。
func TestManifestReportsPerKindCollectionCounts(t *testing.T) {
	fixture := newKindFixture(t)
	manifest, err := BuildLibraryManifest(fixture.catalog.Acquire())
	if err != nil {
		t.Fatal(err)
	}
	stats := manifest.Statistics
	if stats.PhotoAlbumCount != 2 || stats.ComicAlbumCount != 3 {
		t.Fatalf("album counts photo=%d comic=%d want 2/3", stats.PhotoAlbumCount, stats.ComicAlbumCount)
	}
	if stats.PhotoCollectionCount != 0 || stats.ComicCollectionCount != 1 {
		t.Fatalf("collection counts photo=%d comic=%d want 0/1", stats.PhotoCollectionCount, stats.ComicCollectionCount)
	}
	if stats.PhotoCollectionCount+stats.ComicCollectionCount != stats.CollectionCount {
		t.Fatalf("per-kind collections %d+%d != total %d",
			stats.PhotoCollectionCount, stats.ComicCollectionCount, stats.CollectionCount)
	}
}
