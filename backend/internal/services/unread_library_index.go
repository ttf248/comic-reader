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
}

func NewUnreadLibraryIndex() *UnreadLibraryIndex {
	return &UnreadLibraryIndex{}
}

// Page 返回未读相册的一页。目录 revision 保持既有分页游标契约；活动 revision
// 只用作内部缓存键，因此响应字段和 URL 参数无需变化。
func (i *UnreadLibraryIndex) Page(snapshot CatalogSnapshot, started StartedAlbums, activityRevision uint64, cursor string, limit int) (LibraryPage[LibraryNodeSummary], error) {
	const scope = "library-unread"
	offset, err := pageOffset(snapshot, cursor, scope)
	if err != nil {
		return LibraryPage[LibraryNodeSummary]{}, err
	}
	indexes, err := i.albumIndexesFor(snapshot, started, activityRevision)
	if err != nil {
		return LibraryPage[LibraryNodeSummary]{}, err
	}
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
func (i *UnreadLibraryIndex) Summary(snapshot CatalogSnapshot, started StartedAlbums, activityRevision uint64) (LibraryActivitySummary, error) {
	indexes, err := i.albumIndexesFor(snapshot, started, activityRevision)
	if err != nil {
		return LibraryActivitySummary{}, err
	}
	return LibraryActivitySummary{
		Revision: snapshot.Revision(), AlbumCount: len(snapshot.state.library.albums), UnreadCount: len(indexes),
	}, nil
}

// Random 从当前未读下标中安全抽取一项；没有匹配项时返回 ErrLibraryNoMatchingAlbum。
func (i *UnreadLibraryIndex) Random(snapshot CatalogSnapshot, started StartedAlbums, activityRevision uint64) (LibraryNodeSummary, error) {
	indexes, err := i.albumIndexesFor(snapshot, started, activityRevision)
	if err != nil {
		return LibraryNodeSummary{}, err
	}
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
func (i *UnreadLibraryIndex) Dashboard(snapshot CatalogSnapshot, imageActivities, photoActivities []models.Activity, started StartedAlbums, activityRevision uint64) (LibraryHomeDashboard, error) {
	indexes, err := i.albumIndexesFor(snapshot, started, activityRevision)
	if err != nil {
		return LibraryHomeDashboard{}, err
	}
	dashboard := LibraryHomeDashboard{
		Revision:    snapshot.Revision(),
		AlbumCount:  len(snapshot.state.library.albums),
		UnreadCount: len(indexes),
		Unread:      i.summaries(snapshot, indexes[:min(len(indexes), libraryDashboardUnreadPreviewLimit)]),
		InProgress:  []LibraryDashboardProgress{},
	}
	activitiesByAlbum := make(map[string]models.Activity, len(imageActivities)+len(photoActivities))
	for _, activity := range imageActivities {
		if activity.MediaKind != models.MediaKindImage {
			continue
		}
		if current, exists := activitiesByAlbum[activity.AlbumID]; !exists || activity.Updated.After(current.Updated) {
			activitiesByAlbum[activity.AlbumID] = activity
		}
	}
	for _, activity := range photoActivities {
		if activity.MediaKind != models.MediaKindPhoto {
			continue
		}
		if current, exists := activitiesByAlbum[activity.AlbumID]; !exists || activity.Updated.After(current.Updated) {
			activitiesByAlbum[activity.AlbumID] = activity
		}
	}
	for albumID, activity := range activitiesByAlbum {
		album, exists := snapshot.state.library.nodes[albumID]
		if !exists || album.ImageCount == 0 || activity.PageIndex < 0 || activity.PageIndex >= album.ImageCount-1 {
			continue
		}
		// 在读位置必须来自相册当前用途对应的活动：漫画相册看漫画阅读记录，
		// 照片相册看照片浏览记录（旧的漫画记录只作兼容兜底）。
		if album.ContentKind == string(models.ContentKindComic) &&
			activity.MediaKind != models.MediaKindImage {
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
