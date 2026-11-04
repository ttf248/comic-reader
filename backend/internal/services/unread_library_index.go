package services

import (
	"fmt"
	"sort"
	"sync"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// StartedAlbums 描述哪些相册已经翻开过。三类活动分开统计：漫画阅读、照片
// 浏览与视频播放互不替代——照片看到第 12 张不代表漫画读到第 12 页，
// 纯视频相册则只能依据视频活动判定。
type StartedAlbums struct {
	// Image 是漫画阅读活动派生的相册集合。
	Image map[string]struct{}
	// Photo 是照片浏览活动派生的相册集合。
	Photo map[string]struct{}
	// Video 是视频播放活动派生的相册集合。
	Video map[string]struct{}
}

// UnreadLibraryIndex 缓存当前目录和活动版本组合下的未读相册下标。它只保留
// 轻量下标而不复制相册摘要：同一版本的后续游标页仅校验游标、按下标取值并切片，
// 不再重复扫描全库。
type UnreadLibraryIndex struct {
	mu sync.RWMutex

	ready            bool
	catalogRevision  uint64
	activityRevision uint64
	albumIndexes     []int
	// albumIndexesByKind 是同一批未读下标按相册用途分桶的结果。
	// 缓存本身与用途无关：用途过滤是请求期的后置筛选，
	// 一份缓存就能服务照片 / 漫画 / 全部三种工作台。
	albumIndexesByKind map[models.ContentKind][]int
}

func NewUnreadLibraryIndex() *UnreadLibraryIndex {
	return &UnreadLibraryIndex{}
}

// Page 返回未读相册的一页。目录 revision 保持既有分页游标契约；活动 revision
// 只用作内部缓存键，因此响应字段和 URL 参数无需变化。
func (i *UnreadLibraryIndex) Page(snapshot CatalogSnapshot, started StartedAlbums, activityRevision uint64, kind LibraryKindScope, cursor string, limit int) (LibraryPage[LibraryNodeSummary], error) {
	scope := libraryScope("library-unread", kind)
	offset, err := pageOffset(snapshot, cursor, scope)
	if err != nil {
		return LibraryPage[LibraryNodeSummary]{}, err
	}
	indexes, err := i.albumIndexesFor(snapshot, started, activityRevision)
	if err != nil {
		return LibraryPage[LibraryNodeSummary]{}, err
	}
	indexes = filterIndexesByKind(snapshot, indexes, kind)
	start, end, next, err := pageBounds(snapshot.Revision(), scope, cursor != "", offset, len(indexes), limit)
	if err != nil {
		return LibraryPage[LibraryNodeSummary]{}, err
	}
	return LibraryPage[LibraryNodeSummary]{
		Revision: snapshot.Revision(), Items: i.summaries(snapshot, indexes[start:end]), Total: len(indexes), NextCursor: next,
	}, nil
}

// Summary 为常驻导航返回未读计数。它与分页、首页和随机未读共用同一份下标，
// 避免多个常驻入口分别筛选完整相册列表。
func (i *UnreadLibraryIndex) Summary(snapshot CatalogSnapshot, started StartedAlbums, activityRevision uint64, kind LibraryKindScope) (LibraryActivitySummary, error) {
	indexes, err := i.albumIndexesFor(snapshot, started, activityRevision)
	if err != nil {
		return LibraryActivitySummary{}, err
	}
	unread := filterIndexesByKind(snapshot, indexes, kind)
	return LibraryActivitySummary{
		Revision: snapshot.Revision(), AlbumCount: albumCountForKind(snapshot, kind), UnreadCount: len(unread),
	}, nil
}

// Random 从当前未读下标中安全抽取一项；没有匹配项时返回 ErrLibraryNoMatchingAlbum。
func (i *UnreadLibraryIndex) Random(snapshot CatalogSnapshot, started StartedAlbums, activityRevision uint64, kind LibraryKindScope) (LibraryNodeSummary, error) {
	indexes, err := i.albumIndexesFor(snapshot, started, activityRevision)
	if err != nil {
		return LibraryNodeSummary{}, err
	}
	indexes = filterIndexesByKind(snapshot, indexes, kind)
	if len(indexes) == 0 {
		return LibraryNodeSummary{}, ErrLibraryNoMatchingAlbum
	}
	picked, err := randomLibraryIndex(len(indexes))
	if err != nil {
		return LibraryNodeSummary{}, fmt.Errorf("select random unread library album: %w", err)
	}
	return cloneNodeSummary(snapshot.state.library.albums[indexes[picked]]), nil
}

// Dashboard 使用未读下标生成首页有限预览；在读部分只遍历已有图片活动，
// 不再为少量首页卡片遍历完整相册列表。
func (i *UnreadLibraryIndex) Dashboard(snapshot CatalogSnapshot, imageActivities, photoActivities []models.Activity, started StartedAlbums, activityRevision uint64, kind LibraryKindScope) (LibraryHomeDashboard, error) {
	indexes, err := i.albumIndexesFor(snapshot, started, activityRevision)
	if err != nil {
		return LibraryHomeDashboard{}, err
	}
	unread := filterIndexesByKind(snapshot, indexes, kind)
	dashboard := LibraryHomeDashboard{
		Revision:    snapshot.Revision(),
		AlbumCount:  albumCountForKind(snapshot, kind),
		UnreadCount: len(unread),
		Unread:      i.summaries(snapshot, unread[:min(len(unread), libraryDashboardUnreadPreviewLimit)]),
		InProgress:  []LibraryDashboardProgress{},
	}
	// 在读位置按 (相册, 活动类型) 建索引，不能把两类活动合并成「每个相册一条」：
	// 同一本相册可能同时有一条 photo 活动与一条用途拆分之前留下的 image 活动，
	// 合并后取到较新的那条就可能把漫画页码当成照片浏览位置。
	activitiesByAlbumKind := make(map[string]map[models.MediaKind]models.Activity, len(imageActivities)+len(photoActivities))
	record := func(activity models.Activity) {
		if activity.MediaKind != models.MediaKindImage && activity.MediaKind != models.MediaKindPhoto {
			return
		}
		byKind, exists := activitiesByAlbumKind[activity.AlbumID]
		if !exists {
			byKind = make(map[models.MediaKind]models.Activity, 2)
			activitiesByAlbumKind[activity.AlbumID] = byKind
		}
		if current, exists := byKind[activity.MediaKind]; !exists || activity.Updated.After(current.Updated) {
			byKind[activity.MediaKind] = activity
		}
	}
	for _, activity := range imageActivities {
		record(activity)
	}
	for _, activity := range photoActivities {
		record(activity)
	}
	for albumID, byKind := range activitiesByAlbumKind {
		album, exists := snapshot.state.library.nodes[albumID]
		if !exists || album.ImageCount == 0 {
			continue
		}
		activity, mediaKind, ok := progressActivity(album, byKind)
		if !ok {
			continue
		}
		if activity.PageIndex < 0 || activity.PageIndex >= album.ImageCount-1 {
			continue
		}
		dashboard.InProgress = append(dashboard.InProgress, LibraryDashboardProgress{
			Album:     cloneNodeSummary(album),
			PageIndex: activity.PageIndex,
			PageCount: album.ImageCount,
			MediaKind: string(mediaKind),
			Updated:   activity.Updated,
		})
	}
	sort.SliceStable(dashboard.InProgress, func(i, j int) bool {
		left, right := dashboard.InProgress[i], dashboard.InProgress[j]
		if !left.Updated.Equal(right.Updated) {
			return left.Updated.After(right.Updated)
		}
		return left.Album.ID < right.Album.ID
	})
	if kind != LibraryKindAll {
		filtered := dashboard.InProgress[:0]
		for _, progress := range dashboard.InProgress {
			if progress.Album.ContentKind == string(kind) {
				filtered = append(filtered, progress)
			}
		}
		dashboard.InProgress = filtered
	}
	return dashboard, nil
}

// progressActivity 按相册当前用途挑选在读位置。
//
// 漫画相册只认漫画阅读记录；照片相册优先照片浏览记录，
// 缺少时回退到用途拆分之前遗留的漫画阅读记录（那些记录同样代表「翻过」）。
//
// 返回的媒体类型是「位置的语义」而不是记录的来源：照片相册即使取到遗留的
// image 记录，它表示的仍然是照片墙里翻到第几张，前端应当按「看到 N / M」呈现。
func progressActivity(album LibraryNodeSummary, byKind map[models.MediaKind]models.Activity) (models.Activity, models.MediaKind, bool) {
	if album.ContentKind == string(models.ContentKindComic) {
		activity, exists := byKind[models.MediaKindImage]
		return activity, models.MediaKindImage, exists
	}
	if activity, exists := byKind[models.MediaKindPhoto]; exists {
		return activity, models.MediaKindPhoto, true
	}
	activity, exists := byKind[models.MediaKindImage]
	return activity, models.MediaKindPhoto, exists
}

// filterIndexesByKind 把未读下标按相册用途过滤。缓存本身与用途无关，
// 过滤是请求期的后置筛选。
func filterIndexesByKind(snapshot CatalogSnapshot, indexes []int, kind LibraryKindScope) []int {
	if kind == LibraryKindAll {
		return indexes
	}
	filtered := make([]int, 0, len(indexes))
	for _, index := range indexes {
		album := snapshot.state.library.albums[index]
		if album.ContentKind == string(kind) {
			filtered = append(filtered, index)
		}
	}
	return filtered
}

// albumCountForKind 返回该用途下的相册总数。
func albumCountForKind(snapshot CatalogSnapshot, kind LibraryKindScope) int {
	if kind == LibraryKindAll {
		return len(snapshot.state.library.albums)
	}
	return snapshot.state.library.kindAlbumCounts[models.ContentKind(kind)]
}

func (i *UnreadLibraryIndex) albumIndexesFor(snapshot CatalogSnapshot, started StartedAlbums, activityRevision uint64) ([]int, error) {
	if !snapshot.Ready() || snapshot.state == nil || snapshot.state.library == nil {
		return nil, ErrLibraryNotReady
	}
	catalogRevision := snapshot.Revision()
	i.mu.RLock()
	if i.ready && i.catalogRevision == catalogRevision && i.activityRevision == activityRevision {
		indexes := i.albumIndexes
		i.mu.RUnlock()
		return indexes, nil
	}
	i.mu.RUnlock()

	i.mu.Lock()
	defer i.mu.Unlock()
	if i.ready && i.catalogRevision == catalogRevision && i.activityRevision == activityRevision {
		return i.albumIndexes, nil
	}
	albums := snapshot.state.library.albums
	indexes := make([]int, 0, len(albums))
	for albumIndex, album := range albums {
		if albumOpened(album, started) {
			continue
		}
		indexes = append(indexes, albumIndex)
	}
	i.ready = true
	i.catalogRevision = catalogRevision
	i.activityRevision = activityRevision
	i.albumIndexes = indexes
	return i.albumIndexes, nil
}

// albumOpened 判断相册是否已经翻开过。
//
// 有图片的相册看它所属用途对应的活动：漫画相册看漫画阅读记录，照片相册看
// 照片浏览记录。纯视频相册只有视频活动，只能依据视频活动判定。
//
// 照片相册额外认领旧的漫画阅读记录：两种用途拆分之前，所有相册都用同一
// 条 image 活动记录位置。那些记录属于用户已经翻过的相册，不能因为拆分
// 就让它们重新变成未读。
func albumOpened(album LibraryNodeSummary, started StartedAlbums) bool {
	if album.ImageCount > 0 {
		if album.ContentKind == string(models.ContentKindComic) {
			if _, opened := started.Image[album.ID]; opened {
				return true
			}
		} else {
			if _, opened := started.Photo[album.ID]; opened {
				return true
			}
			if _, opened := started.Image[album.ID]; opened {
				return true
			}
		}
	}
	if album.VideoCount > 0 {
		if _, opened := started.Video[album.ID]; opened {
			return true
		}
	}
	return false
}

func (i *UnreadLibraryIndex) summaries(snapshot CatalogSnapshot, indexes []int) []LibraryNodeSummary {
	albums := snapshot.state.library.albums
	items := make([]LibraryNodeSummary, len(indexes))
	for itemIndex, albumIndex := range indexes {
		items[itemIndex] = cloneNodeSummary(albums[albumIndex])
	}
	return items
}
