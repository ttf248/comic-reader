package services

import (
	"errors"
	"strconv"
	"strings"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// ErrInvalidMediaFeedQuery 表示照片流的请求参数组合不合法。
var ErrInvalidMediaFeedQuery = errors.New("invalid media feed query")

// MediaFeedScope 描述照片流从哪里取材。
type MediaFeedScope string

const (
	// MediaFeedRecent 取最近加入的几本相册里的照片。
	MediaFeedRecent MediaFeedScope = "recent"
	// MediaFeedRandom 取随机几本相册里的照片。
	MediaFeedRandom MediaFeedScope = "random"
	// MediaFeedYear 取某个年份下各相册的照片：年份是浏览入口，
	// 用户不必先认准是哪一本相册才能看到那一年的照片。
	MediaFeedYear MediaFeedScope = "year"
	// MediaFeedCollection 取某个集合内部所有相册的照片。
	MediaFeedCollection MediaFeedScope = "collection"
)

// MediaFeedQuery 描述一次跨相册取照片的请求。
type MediaFeedQuery struct {
	Kind   LibraryKindScope
	Scope  MediaFeedScope
	Year   string
	Parent string
}

// FeedMediaItem 是跨相册的照片条目：媒体字段加上它来自哪本相册。
//
// 与精选条目同构：只给文件 ID 的话，用户看到一张照片却不知道它出自
// 哪本相册，也回不去原来的位置。
type FeedMediaItem struct {
	LibraryMediaItem
	// AlbumID 是这张照片所属的相册资源 ID。
	AlbumID string `json:"albumId"`
	// AlbumName 是所属相册的展示名。
	AlbumName string `json:"albumName"`
}

// FeedAlbumRef 是照片流里一本相册的定位信息。
type FeedAlbumRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Count 是这本相册贡献的照片数。
	Count int `json:"count"`
}

// MediaFeedPage 是照片流的一页：照片条目 + 这些照片来自哪些相册。
type MediaFeedPage struct {
	LibraryPage[FeedMediaItem]
	// Albums 是这一页涉及的相册。年份页据此告诉用户「这些照片来自哪几本」，
	// 也让前端能把照片与它的原相册对应起来。
	Albums []FeedAlbumRef `json:"albums"`
}

// 照片流一次掺入几本相册、每本取几张。
//
// 首页的照片墙要一眼看见多种内容：相册太多会显得杂乱，太少又只剩一种
// 口味。取 8 本、每本 12 张交错排布，墙上大约是一百来张照片的两三行。
const (
	mediaFeedAlbumCount = 8
	mediaFeedPerAlbum   = 12
)

// Normalize 校验并收口照片流请求参数。
func (q *MediaFeedQuery) Normalize() error {
	if q.Kind != LibraryKindPhoto && q.Kind != LibraryKindComic {
		return ErrInvalidMediaFeedQuery
	}
	switch q.Scope {
	case MediaFeedRecent, MediaFeedRandom:
		// 这两种取材方式不带条件：年份与集合由服务端挑。
		q.Year = ""
		q.Parent = ""
	case MediaFeedYear:
		q.Parent = ""
		if q.Year == "" {
			return ErrInvalidMediaFeedQuery
		}
		if q.Year != "other" {
			year, err := strconv.Atoi(q.Year)
			if err != nil || year < 1900 || year > 2099 {
				return ErrInvalidMediaFeedQuery
			}
		}
	case MediaFeedCollection:
		q.Year = ""
		q.Parent = strings.TrimSpace(q.Parent)
		if q.Parent == "" {
			return ErrInvalidMediaFeedQuery
		}
	default:
		return ErrInvalidMediaFeedQuery
	}
	return nil
}

// PageMediaFeed 返回跨相册的一页照片。
//
// 取材全部来自不可变库快照：年份与集合的范围由索引里的目录树算出，
// 照片本身直接引用已物化的媒体列表，不碰文件系统（版本号按需 stat）。
func PageMediaFeed(snapshot CatalogSnapshot, q MediaFeedQuery, cursor string, limit int) (MediaFeedPage, error) {
	if err := q.Normalize(); err != nil {
		return MediaFeedPage{}, err
	}
	if !snapshot.Ready() || snapshot.state == nil || snapshot.state.library == nil {
		return MediaFeedPage{}, ErrLibraryNotReady
	}
	index := snapshot.state.library

	if q.Scope == MediaFeedRecent || q.Scope == MediaFeedRandom {
		albums, items := composeFeedAlbums(index, q, limit)
		return MediaFeedPage{
			LibraryPage: LibraryPage[FeedMediaItem]{
				Revision: snapshot.Revision(), Items: items, Total: len(items),
			},
			Albums: albums,
		}, nil
	}

	albums, err := mediaFeedAlbums(snapshot, index, q)
	if err != nil {
		return MediaFeedPage{}, err
	}
	scope := "media-feed:" + string(q.Kind) + ":" + string(q.Scope) + ":" + q.Year + ":" + q.Parent
	offset, err := pageOffset(snapshot, cursor, scope)
	if err != nil {
		return MediaFeedPage{}, err
	}
	total := 0
	for _, album := range albums {
		total += len(album.media)
	}
	start, end, next, err := pageBounds(snapshot.Revision(), scope, cursor != "", offset, total, limit)
	if err != nil {
		return MediaFeedPage{}, err
	}
	items := sliceFeedItems(albums, start, end)
	for i := range items {
		if items[i].sourcePath == "" {
			continue
		}
		if version, verr := MediaVersion(items[i].sourcePath); verr == nil {
			items[i].Version = version
		}
	}
	refs := make([]FeedAlbumRef, 0, len(albums))
	for _, album := range albums {
		refs = append(refs, FeedAlbumRef{ID: album.id, Name: album.name, Count: len(album.media)})
	}
	return MediaFeedPage{
		LibraryPage: LibraryPage[FeedMediaItem]{
			Revision: snapshot.Revision(), Items: items, Total: total, NextCursor: next,
		},
		Albums: refs,
	}, nil
}

// mediaFeedAlbum 是照片流里一本相册的内部定位。
type mediaFeedAlbum struct {
	id    string
	name  string
	media []LibraryMediaItem
}

// mediaFeedAlbums 按请求范围算出参与照片流的相册及其顺序。
func mediaFeedAlbums(snapshot CatalogSnapshot, index *libraryPageIndex, q MediaFeedQuery) ([]mediaFeedAlbum, error) {
	switch q.Scope {
	case MediaFeedCollection:
		ref, exists := snapshot.state.byID[q.Parent]
		if !exists {
			return nil, ErrLibraryResourceNotFound
		}
		if ref.Kind != ResourceCollection {
			return nil, ErrLibraryResourceWrongKind
		}
		return mediaFeedAlbumsUnder(index, q.Parent, q.Kind), nil
	case MediaFeedYear:
		nodes := mediaFeedScopeNodes(snapshot, index, q.Kind)
		albums := []mediaFeedAlbum{}
		for _, node := range nodes {
			if !mediaFeedYearMatch(node, q.Year) {
				continue
			}
			if node.Kind == string(ResourceCollection) {
				albums = append(albums, mediaFeedAlbumsUnder(index, node.ID, q.Kind)...)
				continue
			}
			media := index.media[node.ID]
			if len(media) == 0 {
				continue
			}
			albums = append(albums, mediaFeedAlbum{id: node.ID, name: node.DisplayName, media: media})
		}
		return albums, nil
	default:
		return nil, ErrInvalidMediaFeedQuery
	}
}

// mediaFeedScopeNodes 列出某个范围下的顶层节点。
//
// 顶层范围就是各个媒体根的直属子节点：年份按节点名归桶，与库内一览
// 的年份分组是同一套口径，用户看到的年份和点进去的内容才对得上。
func mediaFeedScopeNodes(snapshot CatalogSnapshot, index *libraryPageIndex, kind LibraryKindScope) []LibraryNodeSummary {
	nodes := []LibraryNodeSummary{}
	for _, root := range snapshot.state.roots {
		for _, node := range index.children[root.ID] {
			// 散图（"本目录媒体"）没有自己的名字：它跟着目录走，
			// 在顶层范围里不参与年份归桶。
			if node.Virtual {
				continue
			}
			if node.ContentKind != string(kind) {
				continue
			}
			nodes = append(nodes, node)
		}
	}
	return nodes
}

// mediaFeedYearMatch 判断节点属于哪个年份桶。
//
// 口径与库内一览的年份分组一致：取名字里第一处 19xx / 20xx。
// "other" 是没有年份的那一桶。
func mediaFeedYearMatch(node LibraryNodeSummary, year string) bool {
	found := queryYearPattern.FindString(node.Name)
	if year == "other" {
		return found == ""
	}
	return found == year
}

// mediaFeedAlbumsUnder 收集集合内部的全部相册，含嵌套集合。
func mediaFeedAlbumsUnder(index *libraryPageIndex, collectionID string, kind LibraryKindScope) []mediaFeedAlbum {
	albums := []mediaFeedAlbum{}
	seen := map[string]bool{}
	var walk func(id string)
	walk = func(id string) {
		for _, child := range index.children[id] {
			if seen[child.ID] {
				continue
			}
			seen[child.ID] = true
			if child.ContentKind != string(kind) {
				continue
			}
			if child.Kind == string(ResourceCollection) {
				walk(child.ID)
				continue
			}
			media := index.media[child.ID]
			if len(media) == 0 {
				continue
			}
			albums = append(albums, mediaFeedAlbum{id: child.ID, name: child.DisplayName, media: media})
		}
	}
	walk(collectionID)
	return albums
}

// sliceFeedItems 截取跨相册序列中的一段。
//
// 序列是若干本相册的媒体首尾相接而成，偏移量先落到相册、再落到相册内
// 的下标，不必为整条序列再复制一份。
func sliceFeedItems(albums []mediaFeedAlbum, start, end int) []FeedMediaItem {
	items := make([]FeedMediaItem, 0, end-start)
	offset := 0
	for _, album := range albums {
		count := len(album.media)
		if offset+count <= start {
			offset += count
			continue
		}
		if offset >= end {
			break
		}
		from := start - offset
		if from < 0 {
			from = 0
		}
		to := end - offset
		if to > count {
			to = count
		}
		for _, media := range album.media[from:to] {
			items = append(items, FeedMediaItem{
				LibraryMediaItem: media,
				AlbumID:          album.id,
				AlbumName:        album.name,
			})
		}
		offset += count
	}
	return items
}

// composeFeedAlbums 组装首页用的照片流：几本相册的照片交错排在一起。
//
// 交错而不是一本接一本：连着看一本相册的头几张，墙上就只剩一种口味。
// 轮流取能保证墙面上始终有多种内容。
func composeFeedAlbums(index *libraryPageIndex, q MediaFeedQuery, limit int) ([]FeedAlbumRef, []FeedMediaItem) {
	kind := models.NormalizeContentKind(string(q.Kind))
	albums := []LibraryNodeSummary{}
	if q.Scope == MediaFeedRandom {
		indexes, err := randomLibraryIndexes(len(index.albumIndexesByKind[kind]), mediaFeedAlbumCount)
		if err != nil {
			return nil, nil
		}
		for _, position := range indexes {
			albums = append(albums, index.albums[index.albumIndexesByKind[kind][position]])
		}
	} else {
		for _, position := range index.recentAlbumIndexesByKind[kind] {
			if len(albums) >= mediaFeedAlbumCount {
				break
			}
			albums = append(albums, index.albums[position])
		}
	}
	takes := make([]mediaFeedAlbum, 0, len(albums))
	for _, album := range albums {
		media := index.media[album.ID]
		if len(media) == 0 {
			continue
		}
		start := 0
		if q.Scope == MediaFeedRandom {
			if offset, err := randomLibraryIndex(len(media)); err == nil {
				start = offset
			}
		}
		// 起点太靠后就往前挪，保证每本相册都能凑够同样的张数。
		if start > len(media)-mediaFeedPerAlbum {
			start = len(media) - mediaFeedPerAlbum
		}
		if start < 0 {
			start = 0
		}
		end := start + mediaFeedPerAlbum
		if end > len(media) {
			end = len(media)
		}
		takes = append(takes, mediaFeedAlbum{
			id:    album.ID,
			name:  album.DisplayName,
			media: media[start:end],
		})
	}
	refs := make([]FeedAlbumRef, 0, len(takes))
	for _, take := range takes {
		refs = append(refs, FeedAlbumRef{ID: take.id, Name: take.name, Count: len(take.media)})
	}
	items := []FeedMediaItem{}
	longest := 0
	for _, take := range takes {
		if len(take.media) > longest {
			longest = len(take.media)
		}
	}
	for round := 0; round < longest; round++ {
		for _, take := range takes {
			if round >= len(take.media) {
				continue
			}
			media := take.media[round]
			if media.sourcePath != "" {
				if version, err := MediaVersion(media.sourcePath); err == nil {
					media.Version = version
				}
			}
			items = append(items, FeedMediaItem{
				LibraryMediaItem: media,
				AlbumID:          take.id,
				AlbumName:        take.name,
			})
		}
	}
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}
	return refs, items
}
