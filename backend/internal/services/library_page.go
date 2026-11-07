package services

import (
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

const (
	DefaultLibraryPageLimit = 60
	MaxLibraryPageLimit     = 200
	MaxLibraryNodeQuery     = 500
)

var (
	ErrLibraryNotReady          = errors.New("library is not ready")
	ErrLibraryResourceNotFound  = errors.New("library resource not found")
	ErrLibraryResourceWrongKind = errors.New("library resource has wrong kind")
	ErrLibraryTagNotFound       = errors.New("library tag not found")
	ErrLibraryNoMatchingAlbum   = errors.New("library has no matching album")
)

// LibraryKindScope 是一次列表请求覆盖的内容属性。
//
// 它对应前端的「工作台模式」：photo / comic 只返回该属性的相册与集合。
// 两个属性互斥，没有「全部」的第三种作用域：媒体库按目录属性一分为二，
// 任何列表都只呈现其中一半。
type LibraryKindScope string

const (
	// LibraryKindPhoto 只返回照片目录下的相册与集合。
	LibraryKindPhoto LibraryKindScope = "photo"
	// LibraryKindComic 只返回漫画目录下的相册与集合。
	LibraryKindComic LibraryKindScope = "comic"
)

// LibraryKindScopeFromMode 把工作台模式换算成列表作用域。
func LibraryKindScopeFromMode(mode models.AppMode) LibraryKindScope {
	if mode == models.AppModeComic {
		return LibraryKindComic
	}
	return LibraryKindPhoto
}

// libraryScope 把属性折进分页游标的作用域：不同属性的游标互不通用，
// 跨属性复用会得到 invalid_cursor，而不是把「换了模式」误判成「库变了」。
func libraryScope(base string, kind LibraryKindScope) string {
	return base + ":" + string(kind)
}

// filterNodesByKind 保留属性匹配的相册与集合。
// 集合继承所属目录的属性，因此也参与过滤：漫画目录下的集合不该出现在
// 照片工作台里。过滤是稳定筛选，不改变原有顺序，因此分页不会漏项或重复。
func filterNodesByKind(items []LibraryNodeSummary, kind LibraryKindScope) []LibraryNodeSummary {
	filtered := make([]LibraryNodeSummary, 0, len(items))
	for _, item := range items {
		if item.ContentKind == string(kind) {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

// LibraryManifest 是首页启动所需的轻量目录描述，不包含相册树或媒体列表。
type LibraryManifest struct {
	Revision   uint64               `json:"revision"`
	ScannedAt  time.Time            `json:"scannedAt"`
	Duration   int64                `json:"duration"`
	Roots      []LibraryRootSummary `json:"roots"`
	Statistics LibraryStatistics    `json:"statistics"`
	Warnings   []models.ScanWarning `json:"warnings,omitempty"`
}

type LibraryStatistics struct {
	RootCount       int `json:"rootCount"`
	AlbumCount      int `json:"albumCount"`
	CollectionCount int `json:"collectionCount"`
	TagCount        int `json:"tagCount"`
	WarningCount    int `json:"warningCount"`
	// PhotoAlbumCount / ComicAlbumCount 是按用途拆分的相册数。
	// AlbumCount 恒为全库总数：它出现在「我的媒体库 N 本相册」这类常驻文案里，
	// 若随工作台模式跳变，用户会以为库变小了。
	PhotoAlbumCount int `json:"photoAlbumCount"`
	ComicAlbumCount int `json:"comicAlbumCount"`
	// PhotoCollectionCount / ComicCollectionCount 是按用途拆分的集合数，
	// 与上面的相册数一一对应：工作台按属性一分为二，界面上的库规模
	// 也要跟着那一侧走。
	PhotoCollectionCount int `json:"photoCollectionCount"`
	ComicCollectionCount int `json:"comicCollectionCount"`
}

type LibraryRootSummary struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	ChildCount int    `json:"childCount"`
	// ContentKind 是该目录的内容属性："photo" / "comic"。
	// 前端用它把目录归到对应的工作台。
	ContentKind string `json:"contentKind,omitempty"`
}

const libraryManifestWarningLimit = 100

// LibraryNodeSummary 是 root/collection 直属子节点的统一卡片 DTO。
// CoverImages 最多四项，可直接用于 collection 的拼贴封面。
type LibraryNodeSummary struct {
	ID             string    `json:"id"`
	Kind           string    `json:"kind"`
	Name           string    `json:"name"`
	DisplayName    string    `json:"displayName"`
	SourceRoot     string    `json:"sourceRoot,omitempty"`
	SourceName     string    `json:"sourceName,omitempty"`
	CoverImage     string    `json:"coverImage,omitempty"`
	CoverImages    []string  `json:"coverImages"`
	CoverKind      string    `json:"coverKind,omitempty"`
	ImageCount     int       `json:"imageCount,omitempty"`
	VideoCount     int       `json:"videoCount,omitempty"`
	MediaCount     int       `json:"mediaCount,omitempty"`
	AlbumCount     int       `json:"albumCount,omitempty"`
	ChildCount     int       `json:"childCount,omitempty"`
	FolderSize     int64     `json:"folderSize,omitempty"`
	Tags           []string  `json:"tags,omitempty"`
	ModTime        time.Time `json:"modTime,omitempty"`
	Date           time.Time `json:"date,omitempty"`
	DateSource     string    `json:"dateSource,omitempty"`
	Virtual        bool      `json:"virtual,omitempty"`
	HasCustomCover bool      `json:"hasCustomCover,omitempty"`
	// Location 是虚拟相册归属目录相对媒体根的路径（斜杠分隔），
	// 例如 "2020年" / "2011年/10.1一号公馆"。前端用它替代
	// “本目录媒体”作为卡片标题。普通相册为空。
	Location string `json:"location,omitempty"`
	// ParentName 是相册直接上级集合的名字，也就是「所属系列」。
	// 漫画目录里一连载多卷时，前端按它把卷分节展示。
	// 根目录下的相册没有上级集合，为空。
	ParentName string `json:"parentName,omitempty"`
	// ParentID 是直接上级集合的资源 ID。它与 ParentName 是同一件事的
	// 两种形式：名字给人看，ID 让前端能一路往上拼出面包屑
	// （存照 / 萍乡中学 / 3班running man）。顶层集合没有上级，为空。
	ParentID string `json:"parentId,omitempty"`
	// ContentKind 是节点的内容属性："photo" / "comic"。
	// 前端据此决定点击相册后进入照片墙还是漫画阅读器。
	ContentKind string `json:"contentKind,omitempty"`
}

type LibraryMediaItem struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Index     int    `json:"index"`
	KindIndex int    `json:"kindIndex"`
	// Width / Height 是媒体的原始像素尺寸；未知时为 0。
	// 照片墙据此按真实宽高比排布，不必在浏览器里逐张探测。
	Width  int `json:"width,omitempty"`
	Height int `json:"height,omitempty"`
}

type LibraryTagSummary struct {
	Tag         string   `json:"tag"`
	AlbumCount  int      `json:"albumCount"`
	CoverImage  string   `json:"coverImage,omitempty"`
	CoverImages []string `json:"coverImages"`
	// PhotoAlbumCount / ComicAlbumCount 是该标签在两种属性下的册数。
	// 列表接口按当前属性收敛，只要一个数就够；按名解析时两个都要，
	// 客户端据此判断「这个标签在当前这一侧还有没有作品」。
	PhotoAlbumCount int `json:"photoAlbumCount,omitempty"`
	ComicAlbumCount int `json:"comicAlbumCount,omitempty"`
}

// LibrarySearchHit 是预计算搜索索引的对外条目，不包含目录树或绝对路径。
type LibrarySearchHit struct {
	Kind string `json:"kind"`
	Path string `json:"path"`
	Name string `json:"name"`
	// Virtual 标记散图（"本目录媒体"）。它的 Name 是归属目录路径，
	// 与同名集合难以区分，前端据此显示类型标签。
	Virtual    bool     `json:"virtual,omitempty"`
	Tags       []string `json:"tags,omitempty"`
	Count      int      `json:"count"`
	CoverImage string   `json:"coverImage,omitempty"`
	// ContentKind 让搜索结果不必再查一次相册摘要就能决定跳转目标。
	ContentKind string `json:"contentKind,omitempty"`
}

// LibraryActivitySummary 是常驻导航所需的轻量阅读计数，不携带相册清单或活动详情。
type LibraryActivitySummary struct {
	Revision    uint64 `json:"revision"`
	AlbumCount  int    `json:"albumCount"`
	UnreadCount int    `json:"unreadCount"`
}

const libraryDashboardUnreadPreviewLimit = 6

// LibraryDashboardProgress 是首页继续阅读所需的一条相册摘要与当前位置。
// PageCount 始终以当前 catalog 中的图片数为准，旧阅读记录不会覆盖重扫后的计数。
//
// 阅读进度只属于漫画工作台，因此这里的页码恒为「读到第几页」。
type LibraryDashboardProgress struct {
	Album     LibraryNodeSummary `json:"album"`
	PageIndex int                `json:"pageIndex"`
	PageCount int                `json:"pageCount"`
	Updated   time.Time          `json:"updated"`
}

// LibraryHomeDashboard 只包含首页立即可见的阅读状态：未读总数及最多六本预览，
// 加上真实在读的相册。它避免首页下载全量相册摘要后再批量查询每本活动记录。
type LibraryHomeDashboard struct {
	Revision    uint64                     `json:"revision"`
	AlbumCount  int                        `json:"albumCount"`
	UnreadCount int                        `json:"unreadCount"`
	Unread      []LibraryNodeSummary       `json:"unread"`
	InProgress  []LibraryDashboardProgress `json:"inProgress"`
}

// LibraryPage 在每页都回传 revision；客户端合并分页结果前可再次确认版本。
type LibraryPage[T any] struct {
	Revision   uint64 `json:"revision"`
	Items      []T    `json:"items"`
	Total      int    `json:"total"`
	NextCursor string `json:"nextCursor,omitempty"`
}

// NormalizeLibraryPageLimit 提供服务层的安全默认值与硬上限。
func NormalizeLibraryPageLimit(limit int) int {
	if limit <= 0 {
		return DefaultLibraryPageLimit
	}
	if limit > MaxLibraryPageLimit {
		return MaxLibraryPageLimit
	}
	return limit
}

// libraryPageIndex 随 ResourceCatalog 一次性发布。请求只做游标校验和切片，
// 不再按页遍历目录树、复制完整相册或重复自然排序。
type libraryPageIndex struct {
	manifest  LibraryManifest
	children  map[string][]LibraryNodeSummary
	media     map[string][]LibraryMediaItem
	albums    []LibraryNodeSummary
	nodes     map[string]LibraryNodeSummary
	tags      []LibraryTagSummary
	tagsByName map[string]LibraryTagSummary
	tagAlbums map[string][]LibraryNodeSummary
	search    []LibrarySearchHit
	// albumIndexesByKind 是全库相册按用途分桶的下标表（存下标不存摘要副本）。
	// 用途过滤只需要在已物化的切片上做一次稳定筛选，不必另存一份摘要。
	albumIndexesByKind map[models.ContentKind][]int
	kindAlbumCounts    map[models.ContentKind]int
	// recentAlbumIndexesByKind 是按用途分桶的「最近加入」下标表。
	// 它在索引构建期按业务日期排好一次，请求期只切片，
	// 不再每请求重排全库。
	recentAlbumIndexesByKind map[models.ContentKind][]int
	kindCollectionCounts      map[models.ContentKind]int
}

func buildLibraryPageIndex(state *resourceCatalogState) *libraryPageIndex {
	index := &libraryPageIndex{
		children:                make(map[string][]LibraryNodeSummary),
		media:                   make(map[string][]LibraryMediaItem),
		albums:                  []LibraryNodeSummary{},
		nodes:                   make(map[string]LibraryNodeSummary),
		tags:                    []LibraryTagSummary{},
		tagsByName:              make(map[string]LibraryTagSummary),
		tagAlbums:               make(map[string][]LibraryNodeSummary),
		albumIndexesByKind:      make(map[models.ContentKind][]int),
		kindAlbumCounts:         make(map[models.ContentKind]int),
		recentAlbumIndexesByKind: make(map[models.ContentKind][]int),
		kindCollectionCounts:      make(map[models.ContentKind]int),
	}
	if state == nil || state.result == nil {
		return index
	}

	rootAlbums := make(map[string][]models.Album, len(state.roots))
	rootCollections := make(map[string][]models.Collection, len(state.roots))
	for i := range state.result.Albums {
		album := state.result.Albums[i]
		id := externalID(state, album.Path, ResourceAlbum)
		if ref, ok := state.byID[id]; ok {
			rootAlbums[ref.RootID] = append(rootAlbums[ref.RootID], album)
		}
	}
	for i := range state.result.Collections {
		collection := state.result.Collections[i]
		id := externalID(state, collection.Path, ResourceCollection)
		if ref, ok := state.byID[id]; ok {
			rootCollections[ref.RootID] = append(rootCollections[ref.RootID], collection)
		}
	}
	for _, root := range state.roots {
		index.children[root.ID] = buildNodeIndex(state, rootAlbums[root.ID], rootCollections[root.ID])
	}
	for id, collection := range state.collections {
		index.children[id] = buildNodeIndex(state, collection.Albums, collection.Collections)
	}

	for id, album := range state.albums {
		summary := albumSummary(state, album)
		index.nodes[id] = summary
		index.albums = append(index.albums, summary)
		sources := albumMediaSources(state, album)
		items := make([]LibraryMediaItem, 0, len(sources))
		kindIndexes := map[string]int{"image": 0, "video": 0}
		for itemIndex, source := range sources {
			items = append(items, LibraryMediaItem{
				ID:        source.id,
				Kind:      source.kind,
				Name:      filepath.Base(source.path),
				Index:     itemIndex,
				KindIndex: kindIndexes[source.kind],
			})
			kindIndexes[source.kind]++
		}
		index.media[id] = items
	}
	for id, collection := range state.collections {
		index.nodes[id] = collectionSummary(state, collection)
	}
	sort.SliceStable(index.albums, func(i, j int) bool {
		left, right := index.albums[i], index.albums[j]
		if left.Virtual != right.Virtual {
			return left.Virtual
		}
		if naturalLess(left.DisplayName, right.DisplayName) {
			return true
		}
		if naturalLess(right.DisplayName, left.DisplayName) {
			return false
		}
		return left.ID < right.ID
	})
	// 按属性给全库相册分桶：只存下标不存摘要副本，内存代价可忽略，
	// 却让「按属性随机抽一本」「按属性算相册数」不必每次扫全库。
	for i, album := range index.albums {
		kind := models.NormalizeContentKind(album.ContentKind)
		index.albumIndexesByKind[kind] = append(index.albumIndexesByKind[kind], i)
		index.kindAlbumCounts[kind]++
	}
	// 「最近加入」的下标表同样在构建期排好：按业务日期倒序，
	// 日期缺失时退回修改时间。请求期只切片，不再重排全库。
	for _, kind := range []models.ContentKind{models.ContentKindPhoto, models.ContentKindComic} {
		recent := make([]int, 0, len(index.albums))
		for i, album := range index.albums {
			if models.NormalizeContentKind(album.ContentKind) == kind {
				recent = append(recent, i)
			}
		}
		sort.SliceStable(recent, func(i, j int) bool {
			return albumMoreRecent(index.albums[recent[i]], index.albums[recent[j]])
		})
		index.recentAlbumIndexesByKind[kind] = recent
	}
	// 集合也按属性计数：工作台分两侧，库规模也要跟着那一侧走。
	// state.collections 含各层嵌套的集合，与扫描结果的集合总数一致。
	for _, collection := range state.collections {
		kind := models.NormalizeContentKind(collection.ContentKind)
		index.kindCollectionCounts[kind]++
	}

	smartCollections := append([]models.SmartCollection(nil), state.result.SmartCollections...)
	sort.SliceStable(smartCollections, func(i, j int) bool {
		return naturalLess(smartCollections[i].Tag, smartCollections[j].Tag)
	})
	for _, smart := range smartCollections {
		summary := tagSummary(state, smart)
		index.tags = append(index.tags, summary)
		index.tagsByName[summary.Tag] = summary
		albums := append([]models.Album(nil), smart.Albums...)
		sort.SliceStable(albums, func(i, j int) bool {
			return albumNaturalLess(albums[i], albums[j])
		})
		summaries := make([]LibraryNodeSummary, 0, len(albums))
		for _, album := range albums {
			summaries = append(summaries, albumSummary(state, album))
		}
		if smart.Tag != "" {
			index.tagAlbums[smart.Tag] = summaries
		}
	}
	index.search = buildLibrarySearchIndex(index)

	index.manifest = buildIndexedLibraryManifest(state, index)
	return index
}

func buildLibrarySearchIndex(index *libraryPageIndex) []LibrarySearchHit {
	hits := make([]LibrarySearchHit, 0, len(index.albums)+len(index.nodes)+len(index.tags))
	for _, album := range index.albums {
		hits = append(hits, LibrarySearchHit{
			Kind: "album", Path: album.ID, Name: searchHitName(album),
			Virtual:     album.Virtual,
			Tags:        append([]string(nil), album.Tags...),
			Count:       album.ImageCount,
			CoverImage:  album.CoverImage,
			ContentKind: album.ContentKind,
		})
	}
	collections := make([]LibraryNodeSummary, 0, len(index.nodes))
	for _, node := range index.nodes {
		if node.Kind == string(ResourceCollection) {
			collections = append(collections, node)
		}
	}
	sort.SliceStable(collections, func(i, j int) bool {
		if naturalLess(collections[i].DisplayName, collections[j].DisplayName) {
			return true
		}
		if naturalLess(collections[j].DisplayName, collections[i].DisplayName) {
			return false
		}
		return collections[i].ID < collections[j].ID
	})
	for _, collection := range collections {
		hits = append(hits, LibrarySearchHit{
			Kind: "collection", Path: collection.ID, Name: collection.DisplayName,
			Count: collection.AlbumCount, CoverImage: collection.CoverImage,
			ContentKind: collection.ContentKind,
		})
	}
	for _, tag := range index.tags {
		hits = append(hits, LibrarySearchHit{
			Kind: "smartCollection", Path: "smart:" + tag.Tag, Name: tag.Tag,
			Tags: []string{tag.Tag}, Count: tag.AlbumCount, CoverImage: tag.CoverImage,
		})
	}
	return hits
}

func buildNodeIndex(state *resourceCatalogState, albums []models.Album, collections []models.Collection) []LibraryNodeSummary {
	albums = append([]models.Album(nil), albums...)
	collections = append([]models.Collection(nil), collections...)
	sortNodeSources(albums, collections)
	return mergeNodePage(state, albums, collections, 0, len(albums)+len(collections))
}

func buildIndexedLibraryManifest(state *resourceCatalogState, index *libraryPageIndex) LibraryManifest {
	result := state.result
	snapshot := CatalogSnapshot{state: state}
	roots := make([]LibraryRootSummary, 0, len(state.roots))
	seenRoots := make(map[string]struct{}, len(state.roots))
	appendRoot := func(path string) {
		id := externalID(state, path, ResourceRoot)
		if id == "" {
			return
		}
		if _, exists := seenRoots[id]; exists {
			return
		}
		seenRoots[id] = struct{}{}
		roots = append(roots, LibraryRootSummary{
			ID: id, Name: snapshot.RelativeLabel(id), ChildCount: len(index.children[id]),
			ContentKind: string(state.contentPolicy.KindFor(path)),
		})
	}
	for _, root := range result.Roots {
		appendRoot(root)
	}
	// 旧扫描快照可能缺少 Roots；补齐配置根，同时保持路径脱敏。
	for _, root := range state.roots {
		if _, exists := seenRoots[root.ID]; exists {
			continue
		}
		roots = append(roots, LibraryRootSummary{
			ID: root.ID, Name: snapshot.RelativeLabel(root.ID), ChildCount: len(index.children[root.ID]),
			ContentKind: string(state.contentPolicy.KindFor(root.AbsolutePath)),
		})
	}
	warnings := result.Warnings
	if len(warnings) > libraryManifestWarningLimit {
		warnings = warnings[:libraryManifestWarningLimit]
	}
	return LibraryManifest{
		Revision:  state.revision,
		ScannedAt: result.ScannedAt,
		Duration:  result.Duration,
		Roots:     roots,
		Warnings:  append([]models.ScanWarning(nil), warnings...),
		Statistics: LibraryStatistics{
			RootCount:            len(roots),
			AlbumCount:           result.AlbumCount,
			CollectionCount:      result.CollectionCount,
			TagCount:             len(index.tags),
			WarningCount:         len(result.Warnings),
			PhotoAlbumCount:      index.kindAlbumCounts[models.ContentKindPhoto],
			ComicAlbumCount:      index.kindAlbumCounts[models.ContentKindComic],
			PhotoCollectionCount: index.kindCollectionCounts[models.ContentKindPhoto],
			ComicCollectionCount: index.kindCollectionCounts[models.ContentKindComic],
		},
	}
}

func BuildLibraryManifest(snapshot CatalogSnapshot) (LibraryManifest, error) {
	if !snapshot.Ready() || snapshot.state == nil || snapshot.state.library == nil {
		return LibraryManifest{}, ErrLibraryNotReady
	}
	manifest := snapshot.state.library.manifest
	manifest.Roots = append([]LibraryRootSummary(nil), manifest.Roots...)
	manifest.Warnings = append([]models.ScanWarning(nil), manifest.Warnings...)
	return manifest, nil
}

func PageLibraryChildren(snapshot CatalogSnapshot, parentID string, kind LibraryKindScope, cursor string, limit int) (LibraryPage[LibraryNodeSummary], error) {
	scope := libraryScope("library-children:"+parentID, kind)
	offset, err := pageOffset(snapshot, cursor, scope)
	if err != nil {
		return LibraryPage[LibraryNodeSummary]{}, err
	}
	if !snapshot.Ready() || snapshot.state == nil || snapshot.state.library == nil {
		return LibraryPage[LibraryNodeSummary]{}, ErrLibraryNotReady
	}
	ref, exists := snapshot.state.byID[parentID]
	if !exists {
		return LibraryPage[LibraryNodeSummary]{}, ErrLibraryResourceNotFound
	}

	switch ref.Kind {
	case ResourceRoot, ResourceCollection:
	default:
		return LibraryPage[LibraryNodeSummary]{}, ErrLibraryResourceWrongKind
	}
	items, exists := snapshot.state.library.children[parentID]
	if !exists {
		return LibraryPage[LibraryNodeSummary]{}, ErrLibraryResourceNotFound
	}
	// 过滤发生在分页之前：游标里的 offset 是「过滤后列表」的偏移。
	items = filterNodesByKind(items, kind)
	total := len(items)
	start, end, next, err := pageBounds(snapshot.Revision(), scope, cursor != "", offset, total, limit)
	if err != nil {
		return LibraryPage[LibraryNodeSummary]{}, err
	}
	return LibraryPage[LibraryNodeSummary]{
		Revision: snapshot.Revision(), Items: cloneNodePage(items, start, end), Total: total, NextCursor: next,
	}, nil
}

func PageAlbumMedia(snapshot CatalogSnapshot, albumID, cursor string, limit int) (LibraryPage[LibraryMediaItem], error) {
	scope := "album-media:" + albumID
	offset, err := pageOffset(snapshot, cursor, scope)
	if err != nil {
		return LibraryPage[LibraryMediaItem]{}, err
	}
	if !snapshot.Ready() || snapshot.state == nil || snapshot.state.library == nil {
		return LibraryPage[LibraryMediaItem]{}, ErrLibraryNotReady
	}
	ref, exists := snapshot.state.byID[albumID]
	if !exists {
		return LibraryPage[LibraryMediaItem]{}, ErrLibraryResourceNotFound
	}
	if ref.Kind != ResourceAlbum {
		return LibraryPage[LibraryMediaItem]{}, ErrLibraryResourceWrongKind
	}
	media, exists := snapshot.state.library.media[albumID]
	if !exists {
		return LibraryPage[LibraryMediaItem]{}, ErrLibraryResourceNotFound
	}
	start, end, next, err := pageBounds(snapshot.Revision(), scope, cursor != "", offset, len(media), limit)
	if err != nil {
		return LibraryPage[LibraryMediaItem]{}, err
	}
	return LibraryPage[LibraryMediaItem]{
		Revision: snapshot.Revision(), Items: clonePage(media, start, end), Total: len(media), NextCursor: next,
	}, nil
}

// ResolveLibraryNodes 按调用方给定顺序批量解析相册或集合摘要。不存在、已过期
// 或不是可展示节点的 ID 会进入 Missing，避免收藏/最近浏览逐个发请求。
func ResolveLibraryNodes(snapshot CatalogSnapshot, ids []string) (LibraryNodeQueryResult, error) {
	if !snapshot.Ready() || snapshot.state == nil || snapshot.state.library == nil {
		return LibraryNodeQueryResult{}, ErrLibraryNotReady
	}
	result := LibraryNodeQueryResult{
		Revision: snapshot.Revision(),
		Items:    make([]LibraryNodeSummary, 0, len(ids)),
		Missing:  make([]string, 0),
	}
	for _, id := range ids {
		summary, exists := snapshot.state.library.nodes[id]
		if !exists {
			result.Missing = append(result.Missing, id)
			continue
		}
		result.Items = append(result.Items, cloneNodeSummary(summary))
	}
	return result, nil
}

type LibraryNodeQueryResult struct {
	Revision uint64               `json:"revision"`
	Items    []LibraryNodeSummary `json:"items"`
	Missing  []string             `json:"missing"`
}

// LibraryTagQueryResult 是按名解析标签摘要的结果。
//
// Missing 只装「库里根本没有这个标签」的条目：一个只含漫画的标签在照片
// 工作台里同样存在，只是这一侧没有作品 —— 客户端据此区分「失效」与
// 「属于另一侧」，不会把用户的收藏误当成垃圾清掉。
type LibraryTagQueryResult struct {
	Revision uint64              `json:"revision"`
	Items    []LibraryTagSummary `json:"items"`
	Missing  []string            `json:"missing"`
}

// ResolveLibraryTags 按调用方给定顺序批量解析标签摘要。
//
// 它与 ResolveLibraryNodes 同构：不按工作台属性过滤，而是同时给出
// 两种属性下的册数，让客户端自己决定当前这一侧看不看得到它。
func ResolveLibraryTags(snapshot CatalogSnapshot, names []string) (LibraryTagQueryResult, error) {
	if !snapshot.Ready() || snapshot.state == nil || snapshot.state.library == nil {
		return LibraryTagQueryResult{}, ErrLibraryNotReady
	}
	result := LibraryTagQueryResult{
		Revision: snapshot.Revision(),
		Items:    make([]LibraryTagSummary, 0, len(names)),
		Missing:  make([]string, 0),
	}
	for _, name := range names {
		tag := strings.TrimSpace(name)
		albums, exists := snapshot.state.library.tagAlbums[tag]
		if !exists {
			result.Missing = append(result.Missing, tag)
			continue
		}
		summary, ok := snapshot.state.library.tagsByName[tag]
		if !ok {
			summary = LibraryTagSummary{Tag: tag}
		}
		summary.Tag = tag
		summary.AlbumCount = len(albums)
		summary.PhotoAlbumCount = 0
		summary.ComicAlbumCount = 0
		for _, album := range albums {
			if models.NormalizeContentKind(album.ContentKind) == models.ContentKindComic {
				summary.ComicAlbumCount++
			} else {
				summary.PhotoAlbumCount++
			}
		}
		result.Items = append(result.Items, summary)
	}
	return result, nil
}

// PageLibraryRecent 返回该属性下最近加入的相册摘要，按业务日期倒序。
//
// 它是照片工作台的「最近添加」与收藏空态推荐的唯一数据源：
// 漫画侧有阅读进度可以当「继续阅读」，照片侧不记录浏览进度，
// 只能按加入时间给用户看点什么。
func PageLibraryRecent(snapshot CatalogSnapshot, kind LibraryKindScope, limit int) (LibraryPage[LibraryNodeSummary], error) {
	if !snapshot.Ready() || snapshot.state == nil || snapshot.state.library == nil {
		return LibraryPage[LibraryNodeSummary]{}, ErrLibraryNotReady
	}
	if limit <= 0 || limit > MaxLibraryPageLimit {
		limit = DefaultLibraryPageLimit
	}
	indexes := snapshot.state.library.recentAlbumIndexesByKind[models.ContentKind(kind)]
	total := len(indexes)
	if total > limit {
		total = limit
	}
	items := make([]LibraryNodeSummary, 0, total)
	for _, i := range indexes[:total] {
		items = append(items, cloneNodeSummary(snapshot.state.library.albums[i]))
	}
	return LibraryPage[LibraryNodeSummary]{
		Revision: snapshot.Revision(),
		Items:    items,
		Total:    len(indexes),
	}, nil
}

func PageLibraryTags(snapshot CatalogSnapshot, kind LibraryKindScope, cursor string, limit int) (LibraryPage[LibraryTagSummary], error) {
	scope := libraryScope("library-tags", kind)
	offset, err := pageOffset(snapshot, cursor, scope)
	if err != nil {
		return LibraryPage[LibraryTagSummary]{}, err
	}
	if !snapshot.Ready() || snapshot.state == nil || snapshot.state.library == nil {
		return LibraryPage[LibraryTagSummary]{}, ErrLibraryNotReady
	}
	// 标签是导航容器，但它下面的相册分属照片与漫画两个属性：
	// 按当前属性重算册数，归零的标签整个不出现，避免点进去是一个空标签。
	tags := snapshot.state.library.tags
	filtered := make([]LibraryTagSummary, 0, len(tags))
	for _, tag := range tags {
		count := 0
		for _, album := range snapshot.state.library.tagAlbums[tag.Tag] {
			if album.ContentKind == string(kind) {
				count++
			}
		}
		if count == 0 {
			continue
		}
		tag.AlbumCount = count
		filtered = append(filtered, tag)
	}
	tags = filtered
	start, end, next, err := pageBounds(snapshot.Revision(), scope, cursor != "", offset, len(tags), limit)
	if err != nil {
		return LibraryPage[LibraryTagSummary]{}, err
	}
	return LibraryPage[LibraryTagSummary]{
		Revision: snapshot.Revision(), Items: cloneTagPage(tags, start, end), Total: len(tags), NextCursor: next,
	}, nil
}

func PageTagAlbums(snapshot CatalogSnapshot, tag string, kind LibraryKindScope, cursor string, limit int) (LibraryPage[LibraryNodeSummary], error) {
	tag = strings.TrimSpace(tag)
	scope := libraryScope("tag-albums:"+tag, kind)
	offset, err := pageOffset(snapshot, cursor, scope)
	if err != nil {
		return LibraryPage[LibraryNodeSummary]{}, err
	}
	if !snapshot.Ready() || snapshot.state == nil || snapshot.state.library == nil {
		return LibraryPage[LibraryNodeSummary]{}, ErrLibraryNotReady
	}
	albums, exists := snapshot.state.library.tagAlbums[tag]
	if !exists {
		return LibraryPage[LibraryNodeSummary]{}, ErrLibraryTagNotFound
	}
	albums = filterNodesByKind(albums, kind)
	start, end, next, err := pageBounds(snapshot.Revision(), scope, cursor != "", offset, len(albums), limit)
	if err != nil {
		return LibraryPage[LibraryNodeSummary]{}, err
	}
	return LibraryPage[LibraryNodeSummary]{
		Revision: snapshot.Revision(), Items: cloneNodePage(albums, start, end), Total: len(albums), NextCursor: next,
	}, nil
}

// SearchLibrary 从当前不可变 revision 的预计算摘要中进行大小写不敏感匹配。
// 搜索请求不再递归遍历完整扫描树，也不会触发路径转换。
//
// kind 过滤全部命中：相册与集合继承目录属性，标签则按「该属性下是否还有
// 相册」判断 —— 一个只含漫画的标签不该出现在照片工作台的搜索结果里。
//
// 命中按匹配质量排序后再截断：搜索索引是按目录顺序排的，先截断等于
// 「前 N 条碰巧命中的」，用户搜「2015」看到的第一条可能是一本只是
// 恰好待在「2015年」目录下的散图。
func SearchLibrary(snapshot CatalogSnapshot, query string, kind LibraryKindScope, limit int) []LibrarySearchHit {
	if !snapshot.Ready() || snapshot.state == nil || snapshot.state.library == nil {
		return []LibrarySearchHit{}
	}
	needle := strings.ToLower(strings.TrimSpace(query))
	if needle == "" || limit <= 0 {
		return []LibrarySearchHit{}
	}
	scored := make([]scoredSearchHit, 0, len(snapshot.state.library.search))
	for order, hit := range snapshot.state.library.search {
		if !searchHitMatchesKind(snapshot, hit, kind) {
			continue
		}
		rank, pos, ok := searchHitScore(hit, needle)
		if !ok {
			continue
		}
		scored = append(scored, scoredSearchHit{
			hit:   hit,
			rank:  rank,
			kind:  searchHitKindWeight(hit.Kind),
			pos:   pos,
			order: order,
		})
	}
	sort.SliceStable(scored, func(i, j int) bool {
		left, right := scored[i], scored[j]
		if left.rank != right.rank {
			return left.rank < right.rank
		}
		// 同档里先给具体的相册与作品，标签是聚合视图，最后再出现。
		if left.kind != right.kind {
			return left.kind < right.kind
		}
		if left.pos != right.pos {
			return left.pos < right.pos
		}
		// 同等匹配质量下短名字更可能是用户要找的那本。
		if len(left.hit.Name) != len(right.hit.Name) {
			return len(left.hit.Name) < len(right.hit.Name)
		}
		return left.order < right.order
	})
	results := make([]LibrarySearchHit, 0, min(limit, len(scored)))
	for _, item := range scored {
		results = append(results, item.hit)
		if len(results) == limit {
			break
		}
	}
	return results
}

// scoredSearchHit 是一条命中连同它的匹配质量。
type scoredSearchHit struct {
	hit   LibrarySearchHit
	rank  int // 越小越靠前，见 searchHitScore
	kind  int // 同档里的类型优先���，见 searchHitKindWeight
	pos   int // 命中位置，越小越靠前
	order int // 原始顺序，同分时保持稳定
}

// searchHitKindWeight 给命中类型排序：相册与作品是具体的内容，
// 标签是聚合视图 —— 同等匹配质量下具体的排前面。
func searchHitKindWeight(kind string) int {
	switch kind {
	case string(ResourceAlbum), string(ResourceCollection):
		return 0
	default:
		return 1
	}
}

// 匹配质量的档位。
const (
	searchRankExact   = 0 // 名字完全等于查询
	searchRankPrefix  = 1 // 名字以查询开头
	searchRankContain = 2 // 名字里包含查询
	searchRankTag     = 3 // 标签命中
	searchRankPath    = 4 // 只在散图的整条归属路径里命中
)

// searchHitScore 给一条命中打分，返回档位与命中位置。
//
// 散图（虚拟相册）的 Name 是它的归属目录路径，例如
// 「2015年/南昌大学」。用户找的是「哪一本」，所以命中它自己那一段
// 目录名才算数；只命中上级目录名（路径里的「2015年」）说明这一本跟
// 查询没什么关系，只是恰好待在一个同名目录下 —— 那一档排在最后。
func searchHitScore(hit LibrarySearchHit, needle string) (rank int, pos int, ok bool) {
	name := strings.ToLower(hit.Name)
	if hit.Kind == "smartCollection" {
		// 标签的名字就是标签本身：它永远只是一次标签命中，不因为
		// 名字恰好等于查询就抢在命名的相册前面。标签是聚合视图，
		// 同等匹配质量下具体的相册与作品先出现。
		if containsTag(hit.Tags, needle) {
			return searchRankTag, 0, true
		}
		return 0, 0, false
	}
	if hit.Virtual {
		segment := name
		if i := strings.LastIndex(segment, "/"); i >= 0 {
			segment = segment[i+1:]
		}
		if idx := strings.Index(segment, needle); idx == 0 {
			return searchRankPrefix, 0, true
		} else if idx > 0 {
			return searchRankContain, idx, true
		}
		if idx := strings.Index(name, needle); idx >= 0 {
			return searchRankPath, idx, true
		}
		if containsTag(hit.Tags, needle) {
			return searchRankTag, 0, true
		}
		return 0, 0, false
	}
	if name == needle {
		return searchRankExact, 0, true
	}
	if idx := strings.Index(name, needle); idx == 0 {
		return searchRankPrefix, 0, true
	} else if idx > 0 {
		return searchRankContain, idx, true
	}
	if containsTag(hit.Tags, needle) {
		return searchRankTag, 0, true
	}
	return 0, 0, false
}

// searchHitMatchesKind 判断一条命中是否属于当前属性的工作台。
func searchHitMatchesKind(snapshot CatalogSnapshot, hit LibrarySearchHit, kind LibraryKindScope) bool {
	switch hit.Kind {
	case string(ResourceAlbum), string(ResourceCollection):
		return hit.ContentKind == string(kind)
	case "smartCollection":
		tag := strings.TrimPrefix(hit.Path, "smart:")
		for _, album := range snapshot.state.library.tagAlbums[tag] {
			if album.ContentKind == string(kind) {
				return true
			}
		}
		return false
	default:
		return false
	}
}

func containsTag(tags []string, needle string) bool {
	for _, tag := range tags {
		if strings.Contains(strings.ToLower(tag), needle) {
			return true
		}
	}
	return false
}

// RandomLibraryAlbums 从当前 revision 的预计算相册摘要中安全地抽取至多
// count 本随机相册。只在该属性的相册里抽：照片工作台不该随机开到一本漫画。
// 抽出的相册互不相同；候选不足 count 本时返回全部。
func RandomLibraryAlbums(snapshot CatalogSnapshot, kind LibraryKindScope, count int) ([]LibraryNodeSummary, error) {
	if !snapshot.Ready() || snapshot.state == nil || snapshot.state.library == nil {
		return nil, ErrLibraryNotReady
	}
	albums := snapshot.state.library.albums
	indexes := snapshot.state.library.albumIndexesByKind[models.ContentKind(kind)]
	total := len(indexes)
	if total == 0 {
		return nil, ErrLibraryNoMatchingAlbum
	}
	picked, err := randomLibraryIndexes(total, count)
	if err != nil {
		return nil, fmt.Errorf("select random library albums: %w", err)
	}
	out := make([]LibraryNodeSummary, 0, len(picked))
	for _, index := range picked {
		out = append(out, cloneNodeSummary(albums[indexes[index]]))
	}
	return out, nil
}

func randomLibraryIndex(total int) (int, error) {
	picked, err := rand.Int(rand.Reader, big.NewInt(int64(total)))
	if err != nil {
		return 0, err
	}
	return int(picked.Int64()), nil
}

// randomLibraryIndexes 抽 count 个互不相同的下标。
//
// 不用部分洗牌：候选可能有成千上万本，整份拷贝只为换几本不划算。
// 这里每次抽一个下标、抽到重复的重来；count 很小（不超过十几本），
// 命中的概率高，重来的次数有限。
func randomLibraryIndexes(total, count int) ([]int, error) {
	if count > total {
		count = total
	}
	picked := make([]int, 0, count)
	used := make(map[int]bool, count)
	for len(picked) < count {
		index, err := randomLibraryIndex(total)
		if err != nil {
			return nil, err
		}
		if used[index] {
			continue
		}
		used[index] = true
		picked = append(picked, index)
	}
	return picked, nil
}

func clonePage[T any](items []T, start, end int) []T {
	if start == end {
		return []T{}
	}
	return append([]T(nil), items[start:end]...)
}

func cloneNodePage(items []LibraryNodeSummary, start, end int) []LibraryNodeSummary {
	out := clonePage(items, start, end)
	for i := range out {
		out[i] = cloneNodeSummary(out[i])
	}
	return out
}

func cloneNodeSummary(item LibraryNodeSummary) LibraryNodeSummary {
	item.CoverImages = append([]string(nil), item.CoverImages...)
	item.Tags = append([]string(nil), item.Tags...)
	return item
}

func cloneTagPage(items []LibraryTagSummary, start, end int) []LibraryTagSummary {
	out := clonePage(items, start, end)
	for i := range out {
		out[i].CoverImages = append([]string(nil), out[i].CoverImages...)
	}
	return out
}

func pageOffset(snapshot CatalogSnapshot, cursor, scope string) (int, error) {
	if cursor == "" {
		return 0, nil
	}
	return DecodePageCursor(cursor, snapshot.Revision(), scope)
}

func pageBounds(revision uint64, scope string, hasCursor bool, offset, total, limit int) (int, int, string, error) {
	if offset < 0 || offset > total || (hasCursor && (total == 0 || offset == total)) {
		return 0, 0, "", ErrInvalidPageCursor
	}
	limit = NormalizeLibraryPageLimit(limit)
	end := offset + limit
	if end > total {
		end = total
	}
	next := ""
	if end < total {
		var err error
		next, err = EncodePageCursor(revision, scope, end)
		if err != nil {
			return 0, 0, "", fmt.Errorf("encode next page: %w", err)
		}
	}
	return offset, end, next, nil
}

func sortNodeSources(albums []models.Album, collections []models.Collection) {
	sort.SliceStable(albums, func(i, j int) bool { return albumNaturalLess(albums[i], albums[j]) })
	sort.SliceStable(collections, func(i, j int) bool {
		return naturalLess(nodeDisplayName(collections[i].DisplayName, collections[i].Name),
			nodeDisplayName(collections[j].DisplayName, collections[j].Name))
	})
}

func mergeNodePage(state *resourceCatalogState, albums []models.Album, collections []models.Collection, start, end int) []LibraryNodeSummary {
	items := make([]LibraryNodeSummary, 0, end-start)
	albumIndex, collectionIndex, mergedIndex := 0, 0, 0
	for mergedIndex < end && (albumIndex < len(albums) || collectionIndex < len(collections)) {
		useAlbum := collectionIndex >= len(collections)
		if albumIndex < len(albums) && collectionIndex < len(collections) {
			useAlbum = albumBeforeCollection(albums[albumIndex], collections[collectionIndex])
		}
		if useAlbum {
			if mergedIndex >= start {
				items = append(items, albumSummary(state, albums[albumIndex]))
			}
			albumIndex++
		} else {
			if mergedIndex >= start {
				items = append(items, collectionSummary(state, collections[collectionIndex]))
			}
			collectionIndex++
		}
		mergedIndex++
	}
	return items
}

func albumBeforeCollection(album models.Album, collection models.Collection) bool {
	if album.Virtual {
		return true
	}
	aName := nodeDisplayName(album.DisplayName, album.Name)
	cName := nodeDisplayName(collection.DisplayName, collection.Name)
	if naturalLess(aName, cName) {
		return true
	}
	if naturalLess(cName, aName) {
		return false
	}
	return true // 同名时 album 在前，保证跨请求顺序稳定。
}

func albumNaturalLess(left, right models.Album) bool {
	if left.Virtual != right.Virtual {
		return left.Virtual
	}
	leftName := nodeDisplayName(left.DisplayName, left.Name)
	rightName := nodeDisplayName(right.DisplayName, right.Name)
	if naturalLess(leftName, rightName) {
		return true
	}
	if naturalLess(rightName, leftName) {
		return false
	}
	return left.Path < right.Path
}

func nodeDisplayName(displayName, name string) string {
	if displayName != "" {
		return displayName
	}
	return name
}

// albumDisplayName 决定相册摘要的展示名。
//
// 散图（"本目录媒体"）的 Name 只是类型常量，真正的标题是归属目录。
// 扫描缓存里可能还是旧值（DisplayName 仍是类型常量），这里用
// Location 兜底，避免升级后阅读器标题、属性弹窗继续显示
// "本目录媒体"。
func albumDisplayName(album models.Album) string {
	name := nodeDisplayName(album.DisplayName, album.Name)
	if album.Virtual && album.Location != "" && name == models.VirtualAlbumName {
		return album.Location
	}
	return name
}

// searchHitName 决定搜索结果条目的展示名。
//
// 虚拟相册的 Name 恒为“本目录媒体”，对用户毫无检索价值；用 Location
// （归属目录相对路径）代替，搜“2020年”才能命中对应目录的散图。
func searchHitName(album LibraryNodeSummary) string {
	if album.Virtual && album.Location != "" {
		return album.Location
	}
	return nodeDisplayName(album.DisplayName, album.Name)
}

func albumSummary(state *resourceCatalogState, album models.Album) LibraryNodeSummary {
	id := externalID(state, album.Path, ResourceAlbum)
	sourceRoot, sourceName := nodeSource(state, id, album.SourceRoot, album.SourceName)
	cover := externalID(state, album.CoverImage, ResourceFile)
	covers := []string{}
	if cover != "" {
		covers = append(covers, cover)
	}
	tags := append([]string(nil), album.Tags...)
	return LibraryNodeSummary{
		ID:             id,
		Kind:           string(ResourceAlbum),
		Name:           album.Name,
		DisplayName:    albumDisplayName(album),
		SourceRoot:     sourceRoot,
		SourceName:     sourceName,
		CoverImage:     cover,
		CoverImages:    covers,
		CoverKind:      album.CoverKind,
		ImageCount:     album.ImageCount,
		VideoCount:     album.VideoCount,
		MediaCount:     len(album.ImageFiles) + len(album.VideoFiles),
		FolderSize:     album.FolderSize,
		Tags:           tags,
		ModTime:        album.ModTime,
		Date:           album.Date,
		DateSource:     album.DateSource,
		Virtual:        album.Virtual,
		HasCustomCover: state.customCovers[filepath.Clean(album.Path)],
		Location:       album.Location,
		ParentName:     parentNameFor(state, album),
		ParentID:       parentCollectionID(state, album.Path, album.Virtual),
		ContentKind:    album.ContentKind,
	}
}

// parentNameFor 返回相册直接上级集合的名字，也就是「所属系列」。
//
// 相册的父目录就是它所在集合的路径；根目录下的相册没有上级集合。
// 虚拟相册（“本目录媒体”）与所属集合同目录，不算有上级系列。
// parentCollectionID 返回节点直接上级集合的资源 ID。
//
// 散图（虚拟相册）是某个目录里的散落媒体：它与同名集合同处一个目录，
// 因此它的上级是那个集合本身，而不是集合的父目录。找不到同名集合时
// （散图直接位于媒体根下）退回按父目录查找。
func parentCollectionID(state *resourceCatalogState, path string, virtual bool) string {
	if state == nil || path == "" {
		return ""
	}
	if virtual {
		if id := externalID(state, filepath.Clean(path), ResourceCollection); id != "" {
			return id
		}
	}
	return externalID(state, filepath.Dir(filepath.Clean(path)), ResourceCollection)
}

func parentNameFor(state *resourceCatalogState, album models.Album) string {
	if state == nil || album.Virtual || album.Path == "" {
		return ""
	}
	return state.collectionNames[filepath.Dir(filepath.Clean(album.Path))]
}

// albumMoreRecent 判断左边的相册是否比右边的「更近」。
//
// 排序用业务日期（拍摄时间 > 文件夹名日期 > 修改时间）：
// 新加进来的相册不一定是最新的目录，但它是用户刚整理的那一批。
// 日期相同时退回 ID，保证顺序稳定。
func albumMoreRecent(left, right LibraryNodeSummary) bool {
	leftDate, rightDate := left.Date, right.Date
	if leftDate.IsZero() {
		leftDate = left.ModTime
	}
	if rightDate.IsZero() {
		rightDate = right.ModTime
	}
	if !leftDate.Equal(rightDate) {
		return leftDate.After(rightDate)
	}
	return left.ID < right.ID
}

func collectionSummary(state *resourceCatalogState, collection models.Collection) LibraryNodeSummary {
	id := externalID(state, collection.Path, ResourceCollection)
	sourceRoot, sourceName := nodeSource(state, id, collection.SourceRoot, collection.SourceName)
	covers, coverKind := collectionCovers(state, collection, 4)
	cover := ""
	if len(covers) > 0 {
		cover = covers[0]
	}
	albumCount, imageCount, videoCount, folderSize := collectionTotals(collection)
	return LibraryNodeSummary{
		ID:          id,
		Kind:        string(ResourceCollection),
		Name:        collection.Name,
		DisplayName: nodeDisplayName(collection.DisplayName, collection.Name),
		SourceRoot:  sourceRoot,
		SourceName:  sourceName,
		CoverImage:  cover,
		CoverImages: covers,
		CoverKind:   coverKind,
		ImageCount:  imageCount,
		VideoCount:  videoCount,
		MediaCount:  imageCount + videoCount,
		AlbumCount:  albumCount,
		ChildCount:  len(collection.Albums) + len(collection.Collections),
		FolderSize:  folderSize,
		ParentID:    parentCollectionID(state, collection.Path, false),
		ContentKind: collection.ContentKind,
	}
}

func collectionTotals(collection models.Collection) (albumCount, imageCount, videoCount int, folderSize int64) {
	for _, album := range collection.Albums {
		albumCount++
		imageCount += album.ImageCount
		videoCount += album.VideoCount
		folderSize += album.FolderSize
	}
	for _, child := range collection.Collections {
		childAlbums, childImages, childVideos, childSize := collectionTotals(child)
		albumCount += childAlbums
		imageCount += childImages
		videoCount += childVideos
		folderSize += childSize
	}
	return albumCount, imageCount, videoCount, folderSize
}

func nodeSource(state *resourceCatalogState, id, configuredRoot, configuredName string) (string, string) {
	rootID := externalID(state, configuredRoot, ResourceRoot)
	if rootID == "" {
		if ref, exists := state.byID[id]; exists {
			rootID = ref.RootID
		}
	}
	name := configuredName
	if name == "" {
		if root, exists := state.byID[rootID]; exists {
			name = filepath.Base(root.AbsolutePath)
		}
	}
	return rootID, name
}

func collectionCovers(state *resourceCatalogState, collection models.Collection, maximum int) ([]string, string) {
	covers := make([]string, 0, maximum)
	coverKind := ""
	var visit func(models.Collection)
	visit = func(current models.Collection) {
		for i := range current.Albums {
			if len(covers) >= maximum {
				return
			}
			if id := externalID(state, current.Albums[i].CoverImage, ResourceFile); id != "" {
				covers = append(covers, id)
				if coverKind == "" {
					coverKind = current.Albums[i].CoverKind
				}
			}
		}
		for i := range current.Collections {
			if len(covers) >= maximum {
				return
			}
			visit(current.Collections[i])
		}
	}
	visit(collection)
	return covers, coverKind
}

type albumMediaSource struct {
	id   string
	kind string
	path string
}

func albumMediaSources(state *resourceCatalogState, album models.Album) []albumMediaSource {
	media := make([]albumMediaSource, 0, len(album.ImageFiles)+len(album.VideoFiles))
	seen := make(map[string]struct{}, cap(media))
	appendMedia := func(path, kind string) {
		if path == "" {
			return
		}
		key := pathKindKey(path, ResourceFile)
		if _, exists := seen[key]; exists {
			return
		}
		id := externalID(state, path, ResourceFile)
		if id == "" {
			return
		}
		seen[key] = struct{}{}
		media = append(media, albumMediaSource{id: id, kind: kind, path: path})
	}
	for _, path := range album.ImageFiles {
		appendMedia(path, "image")
	}
	for _, path := range album.VideoFiles {
		appendMedia(path, "video")
	}
	sort.SliceStable(media, func(i, j int) bool {
		leftName, rightName := filepath.Base(media[i].path), filepath.Base(media[j].path)
		if naturalLess(leftName, rightName) {
			return true
		}
		if naturalLess(rightName, leftName) {
			return false
		}
		if media[i].kind != media[j].kind {
			return media[i].kind < media[j].kind
		}
		return media[i].path < media[j].path
	})
	return media
}

func tagSummary(state *resourceCatalogState, smart models.SmartCollection) LibraryTagSummary {
	covers := make([]string, 0, 4)
	for i := range smart.Albums {
		if len(covers) >= 4 {
			break
		}
		if id := externalID(state, smart.Albums[i].CoverImage, ResourceFile); id != "" {
			covers = append(covers, id)
		}
	}
	cover := externalID(state, smart.CoverImage, ResourceFile)
	if cover == "" && len(covers) > 0 {
		cover = covers[0]
	}
	return LibraryTagSummary{
		Tag: smart.Tag, AlbumCount: smart.AlbumCount, CoverImage: cover, CoverImages: covers,
	}
}
