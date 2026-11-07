package services

import (
	"fmt"
	"sort"
	"sync"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// StartedAlbums 描述哪些相册已经翻开过。两类活动分开统计：漫画阅读与
// 视频播放互不替代——读到第 12 页不代表视频看到第 12 秒，
// 纯视频相册则只能依据视频活动判定。
type StartedAlbums struct {
	// Image 是漫画阅读活动派生的相册集合。
	Image map[string]struct{}
	// Video 是视频播放活动派生的相册集合。
	Video map[string]struct{}
}

// UnreadLibraryIndex 缓存当前目录和活动版本组合下的未读相册下标。它只保留
// 轻量下标而不复制相册摘要：同一版本的后续游标页仅校验游标、按下标取值并切片，
// 不再重复扫描全库。
//
// 未读只属于漫画工作台：照片目录下的相册不记录阅读进度，也没有「未读」
// 这个概念，因此不进入这张表。
type UnreadLibraryIndex struct {
	mu sync.RWMutex

	ready            bool
	catalogRevision  uint64
	activityRevision uint64
	albumIndexes     []int
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
// Random 抽取至多 count 本还没开始读的随机相册。
// 抽出的相册互不相同；未读候选不足 count 本时返回全部。
func (i *UnreadLibraryIndex) Random(snapshot CatalogSnapshot, started StartedAlbums, activityRevision uint64, kind LibraryKindScope, count int) ([]LibraryNodeSummary, error) {
	indexes, err := i.albumIndexesFor(snapshot, started, activityRevision)
	if err != nil {
		return nil, err
	}
	indexes = filterIndexesByKind(snapshot, indexes, kind)
	if len(indexes) == 0 {
		return nil, ErrLibraryNoMatchingAlbum
	}
	picked, err := randomLibraryIndexes(len(indexes), count)
	if err != nil {
		return nil, fmt.Errorf("select random unread library albums: %w", err)
	}
	out := make([]LibraryNodeSummary, 0, len(picked))
	for _, index := range picked {
		out = append(out, cloneNodeSummary(snapshot.state.library.albums[indexes[index]]))
	}
	return out, nil
}

// Dashboard 使用未读下标生成首页有限预览；在读部分只遍历已有漫画阅读活动，
// 不再为少量首页卡片遍历完整相册列表。
func (i *UnreadLibraryIndex) Dashboard(snapshot CatalogSnapshot, imageActivities []models.Activity, started StartedAlbums, activityRevision uint64, kind LibraryKindScope) (LibraryHomeDashboard, error) {
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
	// 在读位置按相册建索引：同一本相册只有一条漫画阅读记录。
	activitiesByAlbum := make(map[string]models.Activity, len(imageActivities))
	for _, activity := range imageActivities {
		if activity.MediaKind != models.MediaKindImage {
			continue
		}
		if current, exists := activitiesByAlbum[activity.AlbumID]; !exists || activity.Updated.After(current.Updated) {
			activitiesByAlbum[activity.AlbumID] = activity
		}
	}
	for albumID, activity := range activitiesByAlbum {
		album, exists := snapshot.state.library.nodes[albumID]
		if !exists || album.ImageCount == 0 {
			continue
		}
		// 在读只属于漫画工作台：照片相册没有阅读进度，不该出现在这一区。
		if album.ContentKind != string(kind) {
			continue
		}
		if activity.PageIndex < 0 || activity.PageIndex >= album.ImageCount-1 {
			continue
		}
		dashboard.InProgress = append(dashboard.InProgress, LibraryDashboardProgress{
			Album:     cloneNodeSummary(album),
			PageIndex: activity.PageIndex,
			PageCount: album.ImageCount,
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
	return dashboard, nil
}

// filterIndexesByKind 把未读下标按内容属性过滤。缓存本身与属性无关，
// 过滤是请求期的后置筛选。
func filterIndexesByKind(snapshot CatalogSnapshot, indexes []int, kind LibraryKindScope) []int {
	filtered := make([]int, 0, len(indexes))
	for _, index := range indexes {
		album := snapshot.state.library.albums[index]
		if album.ContentKind == string(kind) {
			filtered = append(filtered, index)
		}
	}
	return filtered
}

// albumCountForKind 返回该属性下的相册总数。
func albumCountForKind(snapshot CatalogSnapshot, kind LibraryKindScope) int {
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
		// 未读只统计漫画相册：照片目录下的相册不记录阅读进度。
		if album.ContentKind != string(models.ContentKindComic) {
			continue
		}
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
// 有图片的漫画相册看它的漫画阅读记录；纯视频相册只有视频活动，
// 只能依据视频活动判定。
func albumOpened(album LibraryNodeSummary, started StartedAlbums) bool {
	if album.ImageCount > 0 {
		if _, opened := started.Image[album.ID]; opened {
			return true
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
