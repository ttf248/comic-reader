package services

import (
	"fmt"
	"sort"
	"sync"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// StartedAlbums 描述哪些相册已经翻开过。图片与视频活动分开统计：纯视频
// 相册没有图片活动，未读判定只能依据视频活动；分开存放也避免一种媒体的
// 记录误判另一种媒体的相册。
type StartedAlbums struct {
	Image map[string]struct{}
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
func (i *UnreadLibraryIndex) Dashboard(snapshot CatalogSnapshot, imageActivities []models.Activity, started StartedAlbums, activityRevision uint64) (LibraryHomeDashboard, error) {
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
		if !exists || album.ImageCount == 0 || activity.PageIndex < 0 || activity.PageIndex >= album.ImageCount-1 {
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
		// 有图片的相册看图片活动，纯视频相册没有图片活动，只能看视频活动；
		// 打开过其中一种就算翻开过，不再计入未读。
		if album.ImageCount > 0 {
			if _, opened := started.Image[album.ID]; opened {
				continue
			}
		}
		if album.VideoCount > 0 {
			if _, opened := started.Video[album.ID]; opened {
				continue
			}
		}
		indexes = append(indexes, albumIndex)
	}
	i.ready = true
	i.catalogRevision = catalogRevision
	i.activityRevision = activityRevision
	i.albumIndexes = indexes
	return i.albumIndexes, nil
}

func (i *UnreadLibraryIndex) summaries(snapshot CatalogSnapshot, indexes []int) []LibraryNodeSummary {
	albums := snapshot.state.library.albums
	items := make([]LibraryNodeSummary, len(indexes))
	for itemIndex, albumIndex := range indexes {
		items[itemIndex] = cloneNodeSummary(albums[albumIndex])
	}
	return items
}
