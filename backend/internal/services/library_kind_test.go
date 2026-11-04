package services

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// kindFixture 是一个混排用途的媒体库：两本照片相册、两本漫画相册，
// 外加一个装着漫画卷的集合。它用来验证「工作台模式」下的列表过滤。
//
// 根目录下有 4 本相册 + 1 个集合；集合里的卷算在漫画一侧。
type kindFixture struct {
	catalog       *ResourceCatalog
	root          string
	rootID        string
	collectionID  string
	photoAlbumID  string
	comicAlbumID  string
	photoTagAlbum string
	comicTagAlbum string
}

func newKindFixture(t *testing.T) kindFixture {
	t.Helper()
	root := t.TempDir()
	photoPath := filepath.Join(root, "photo")
	comicPath := filepath.Join(root, "comic")
	photoTagPath := filepath.Join(root, "photo-tag")
	comicTagPath := filepath.Join(root, "comic-tag")
	collectionPath := filepath.Join(root, "shelf")
	collectionComicPath := filepath.Join(collectionPath, "volume1")

	// 每本相册 3 张图：在读位置才有「还没翻到最后」的空间。
	album := func(path, name, tag string) models.Album {
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
	photo := album(photoPath, "photo", "风景")
	comic := album(comicPath, "comic", "漫画")
	photoTag := album(photoTagPath, "photo-tag", "共同")
	comicTag := album(comicTagPath, "comic-tag", "共同")
	volume := album(collectionComicPath, "volume1", "连载")

	collection := models.Collection{
		Type: "collection", Path: collectionPath, Name: "shelf", DisplayName: "shelf",
		SourceRoot: root, Albums: []models.Album{volume}, AlbumCount: 1,
	}
	result := &models.ScanResult{
		Roots:           []string{root},
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
	catalog.Publish(result, []string{root})
	// 漫画相册与漫画卷显式标成 comic，其余保持全局默认 photo。
	catalog.SetContentKindOverrides(map[string]models.ContentKind{
		filepath.Clean(comicPath):           models.ContentKindComic,
		filepath.Clean(comicTagPath):        models.ContentKindComic,
		filepath.Clean(collectionComicPath): models.ContentKindComic,
	})
	return kindFixture{
		catalog:       catalog,
		root:          root,
		rootID:        catalog.ExternalID(root, ResourceRoot),
		collectionID:  catalog.ExternalID(collectionPath, ResourceCollection),
		photoAlbumID:  catalog.ExternalID(photoPath, ResourceAlbum),
		comicAlbumID:  catalog.ExternalID(comicPath, ResourceAlbum),
		photoTagAlbum: catalog.ExternalID(photoTagPath, ResourceAlbum),
		comicTagAlbum: catalog.ExternalID(comicTagPath, ResourceAlbum),
	}
}

func TestLibraryChildrenFiltersAlbumsByKind(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()

	all, err := PageLibraryChildren(snapshot, fixture.rootID, LibraryKindAll, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if all.Total != 5 {
		t.Fatalf("all children total=%d, want 5", all.Total)
	}

	photo, err := PageLibraryChildren(snapshot, fixture.rootID, LibraryKindPhoto, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	// 2 本照片相册 + 1 个集合（集合恒返回）。
	if photo.Total != 3 {
		t.Fatalf("photo children total=%d, want 3", photo.Total)
	}
	for _, item := range photo.Items {
		if item.Kind == string(ResourceAlbum) && item.ContentKind != string(LibraryKindPhoto) {
			t.Fatalf("photo scope leaked comic album %+v", item)
		}
	}

	comic, err := PageLibraryChildren(snapshot, fixture.rootID, LibraryKindComic, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if comic.Total != 3 {
		t.Fatalf("comic children total=%d, want 3", comic.Total)
	}
	for _, item := range comic.Items {
		if item.Kind == string(ResourceAlbum) && item.ContentKind != string(LibraryKindComic) {
			t.Fatalf("comic scope leaked photo album %+v", item)
		}
	}
}

func TestLibraryCursorScopeSeparatesKinds(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()

	first, err := PageLibraryChildren(snapshot, fixture.rootID, LibraryKindPhoto, "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if first.NextCursor == "" {
		t.Fatal("expected a next cursor for the first page")
	}
	if _, err := PageLibraryChildren(snapshot, fixture.rootID, LibraryKindComic, first.NextCursor, 1); !errors.Is(err, ErrInvalidPageCursor) {
		t.Fatalf("cross-kind cursor error=%v, want ErrInvalidPageCursor", err)
	}
	if _, err := PageLibraryChildren(snapshot, fixture.rootID, LibraryKindPhoto, first.NextCursor, 1); err != nil {
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

func TestRandomLibraryAlbumRespectsKind(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()

	for i := 0; i < 20; i++ {
		album, err := RandomLibraryAlbum(snapshot, LibraryKindComic)
		if err != nil {
			t.Fatal(err)
		}
		if album.ContentKind != string(models.ContentKindComic) {
			t.Fatalf("random comic album=%+v", album)
		}
	}
}

func TestSearchLibraryFiltersAlbumHitsByKind(t *testing.T) {
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
	// 智能标签是导航容器，不参与用途过滤：它仍然出现在结果里。
	if !smartFound {
		t.Fatalf("search dropped the smart collection: %+v", hits)
	}
}

func TestUnreadIndexIsBucketedByKind(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()
	index := NewUnreadLibraryIndex()

	photo, err := index.Page(snapshot, StartedAlbums{}, 1, LibraryKindPhoto, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if photo.Total != 2 {
		t.Fatalf("photo unread total=%d, want 2", photo.Total)
	}
	comic, err := index.Page(snapshot, StartedAlbums{}, 1, LibraryKindComic, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if comic.Total != 3 {
		t.Fatalf("comic unread total=%d, want 3", comic.Total)
	}
	all, err := index.Page(snapshot, StartedAlbums{}, 1, LibraryKindAll, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if all.Total != 5 {
		t.Fatalf("all unread total=%d, want 5", all.Total)
	}
}

// 照片相册可能同时存在一条 photo 活动与一条用途拆分之前留下的 image 活动：
// 在读位置必须取 photo 的那条，不能因为 image 更新就指向漫画页码。
func TestDashboardInProgressUsesKindMatchingActivity(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()
	index := NewUnreadLibraryIndex()

	now := time.Now().UTC()
	dashboard, err := index.Dashboard(snapshot,
		[]models.Activity{{
			AlbumID: fixture.photoAlbumID, MediaKind: models.MediaKindImage,
			PageIndex: 2, PageCount: 3, Updated: now.Add(time.Minute),
		}},
		[]models.Activity{{
			AlbumID: fixture.photoAlbumID, MediaKind: models.MediaKindPhoto,
			PageIndex: 0, PageCount: 3, Updated: now,
		}},
		StartedAlbums{}, 1, LibraryKindAll)
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, progress := range dashboard.InProgress {
		if progress.Album.ID != fixture.photoAlbumID {
			continue
		}
		found = true
		if progress.PageIndex != 0 {
			t.Fatalf("photo album took the comic position: %+v", progress)
		}
		if progress.MediaKind != string(models.MediaKindPhoto) {
			t.Fatalf("photo album media kind=%q, want photo", progress.MediaKind)
		}
	}
	if !found {
		t.Fatalf("photo album missing from in-progress: %+v", dashboard.InProgress)
	}
}

// 用途拆分之前所有相册都写 image 活动：照片相册只有遗留记录时，
// 位置仍然可用，但语义仍是照片浏览。
func TestDashboardInProgressFallsBackToLegacyImageActivity(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()
	index := NewUnreadLibraryIndex()

	dashboard, err := index.Dashboard(snapshot,
		[]models.Activity{{
			AlbumID: fixture.photoAlbumID, MediaKind: models.MediaKindImage,
			PageIndex: 1, PageCount: 3, Updated: time.Now().UTC(),
		}},
		nil, StartedAlbums{}, 1, LibraryKindAll)
	if err != nil {
		t.Fatal(err)
	}
	for _, progress := range dashboard.InProgress {
		if progress.Album.ID != fixture.photoAlbumID {
			continue
		}
		if progress.PageIndex != 1 {
			t.Fatalf("legacy position=%+v", progress)
		}
		if progress.MediaKind != string(models.MediaKindPhoto) {
			t.Fatalf("legacy position media kind=%q, want photo", progress.MediaKind)
		}
		return
	}
	t.Fatalf("photo album missing from in-progress: %+v", dashboard.InProgress)
}

// 漫画相册只认漫画阅读记录：照片浏览活动不能冒充阅读位置。
func TestDashboardInProgressIgnoresPhotoActivityForComicAlbum(t *testing.T) {
	fixture := newKindFixture(t)
	snapshot := fixture.catalog.Acquire()
	index := NewUnreadLibraryIndex()

	dashboard, err := index.Dashboard(snapshot,
		nil,
		[]models.Activity{{
			AlbumID: fixture.comicAlbumID, MediaKind: models.MediaKindPhoto,
			PageIndex: 1, PageCount: 3, Updated: time.Now().UTC(),
		}},
		StartedAlbums{}, 1, LibraryKindAll)
	if err != nil {
		t.Fatal(err)
	}
	for _, progress := range dashboard.InProgress {
		if progress.Album.ID == fixture.comicAlbumID {
			t.Fatalf("comic album took a photo position: %+v", progress)
		}
	}
}
