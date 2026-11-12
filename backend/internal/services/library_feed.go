package services

import (
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math/rand/v2"
	"sort"
	"strconv"
	"strings"
	"time"

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
	// Seed 是随机取材的种子。
	//
	// 「换一批」要保证换出来的确实换掉了：纯随机会撞车，种子让服务端
	// 按可复现的方式取材 —— 同一个种子给同一批照片，不同种子给不同的
	// 一批。只有 scope=random 用它。
	Seed string
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

// LookupLibraryFeedItem 只从已发布目录快照取媒体与原相册摘要，不执行磁盘访问。
// 调用方在对外返回前仍须通过路径安全校验器验证源文件。
func LookupLibraryFeedItem(snapshot CatalogSnapshot, id string) (FeedMediaItem, bool) {
	if !snapshot.Ready() || snapshot.state == nil || snapshot.state.library == nil {
		return FeedMediaItem{}, false
	}
	library := snapshot.state.library
	ref, exists := library.mediaByFile[id]
	if !exists {
		return FeedMediaItem{}, false
	}
	media := library.media[ref.albumID]
	if ref.index < 0 || ref.index >= len(media) {
		return FeedMediaItem{}, false
	}
	album, exists := library.nodes[ref.albumID]
	if !exists {
		return FeedMediaItem{}, false
	}
	item := media[ref.index]
	if item.Kind != "image" {
		return FeedMediaItem{}, false
	}
	name := strings.TrimSpace(album.DisplayName)
	if name == "" {
		name = strings.TrimSpace(album.Name)
	}
	return FeedMediaItem{LibraryMediaItem: item, AlbumID: ref.albumID, AlbumName: name}, true
}

// ResolveLibraryFeedItems 按给定 ID 顺序解析当前快照里的媒体条目，并补上原相册定位。
// 路径仅在服务端用于再次校验与计算版本，不会出现在返回 DTO 中。
func ResolveLibraryFeedItems(snapshot CatalogSnapshot, ids []string, validatePath func(string) (string, error)) []FeedMediaItem {
	if !snapshot.Ready() || snapshot.state == nil || snapshot.state.library == nil {
		return []FeedMediaItem{}
	}
	library := snapshot.state.library
	items := make([]FeedMediaItem, 0, len(ids))
	for _, id := range ids {
		ref, exists := library.mediaByFile[id]
		if !exists {
			continue
		}
		media := library.media[ref.albumID]
		if ref.index < 0 || ref.index >= len(media) {
			continue
		}
		album, exists := library.nodes[ref.albumID]
		if !exists {
			continue
		}
		item := media[ref.index]
		if item.Kind != "image" {
			continue
		}
		if item.sourcePath != "" && validatePath != nil {
			path, err := validatePath(item.sourcePath)
			if err != nil {
				continue
			}
			version, err := MediaVersion(path)
			if err != nil {
				continue
			}
			item.Version = version
		}
		name := strings.TrimSpace(album.DisplayName)
		if name == "" {
			name = strings.TrimSpace(album.Name)
		}
		items = append(items, FeedMediaItem{LibraryMediaItem: item, AlbumID: ref.albumID, AlbumName: name})
	}
	return items
}

// FeedAlbumRef 是照片流里一本相册的定位信息。
type FeedAlbumRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Count 是这本相册贡献的照片数。
	Count int `json:"count"`
}

// FeedSource 是取材范围里被选中的节点：年份对应的那几个集合，
// 或者集合页的那一个集合。
type FeedSource struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Kind 是节点类型："album" 或 "collection"。
	Kind string `json:"kind"`
}

// MediaFeedPage 是照片流的一页：照片条目 + 这些照片来自哪些相册。
type MediaFeedPage struct {
	LibraryPage[FeedMediaItem]
	// Albums 是这一页涉及的相册。年份页据此告诉用户「这些照片来自哪几本」，
	// 也让前端能把照片与它的原相册对应起来。
	Albums []FeedAlbumRef `json:"albums"`
	// Sources 是取材范围里被选中的节点。年份页据此把「这一年的照片来自
	// 哪个集合」说清楚，也给出回到那个集合的入口。
	Sources []FeedSource `json:"sources"`
}

// 照片流一次掺入几本相册、每本取几张。
//
// 首页的照片墙要一眼看见多种内容：相册太多会显得杂乱，太少又只剩一种
// 口味。取 8 本、每本 12 张交错排布，墙上大约是一百来张照片的两三行。
const mediaFeedPerAlbum = 12

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
		if q.Scope != MediaFeedRandom {
			// 种子只对随机取材有意义。
			q.Seed = ""
		}
	case MediaFeedYear:
		q.Parent = ""
		q.Seed = ""
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
		q.Seed = ""
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
		albums, items := composeFeedAlbums(index, q, limit, snapshot.Revision())
		return MediaFeedPage{
			LibraryPage: LibraryPage[FeedMediaItem]{
				Revision: snapshot.Revision(), Items: items, Total: len(items),
			},
			Albums:  albums,
			Sources: []FeedSource{},
		}, nil
	}

	albums, sources, err := mediaFeedAlbums(snapshot, index, q)
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
	items := sliceFeedItems(albums, start, end, q.Scope == MediaFeedCollection)
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
		Albums:  refs,
		Sources: sources,
	}, nil
}

// mediaFeedAlbum 是照片流里一本相册的内部定位。
type mediaFeedAlbum struct {
	id    string
	name  string
	media []LibraryMediaItem
}

// mediaFeedAlbums 按请求范围算出参与照片流的相册及其顺序。
//
// 第二个返回值是被选中的范围节点：年份对应的那几个集合，或集合页的
// 那一个集合。年份页要靠它说清「这一年的照片来自哪里」。
func mediaFeedAlbums(snapshot CatalogSnapshot, index *libraryPageIndex, q MediaFeedQuery) ([]mediaFeedAlbum, []FeedSource, error) {
	switch q.Scope {
	case MediaFeedCollection:
		ref, exists := snapshot.state.byID[q.Parent]
		if !exists {
			return nil, nil, ErrLibraryResourceNotFound
		}
		if ref.Kind != ResourceCollection {
			return nil, nil, ErrLibraryResourceWrongKind
		}
		node, ok := index.nodes[q.Parent]
		if !ok {
			return nil, nil, ErrLibraryResourceNotFound
		}
		sources := []FeedSource{{ID: node.ID, Name: node.DisplayName, Kind: node.Kind}}
		return mediaFeedAlbumsUnder(index, q.Parent, q.Kind), sources, nil
	case MediaFeedYear:
		nodes := mediaFeedScopeNodes(snapshot, index, q.Kind)
		albums := []mediaFeedAlbum{}
		sources := []FeedSource{}
		for _, node := range nodes {
			if !mediaFeedYearMatch(node, q.Year) {
				continue
			}
			sources = append(sources, FeedSource{ID: node.ID, Name: node.DisplayName, Kind: node.Kind})
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
		return albums, sources, nil
	default:
		return nil, nil, ErrInvalidMediaFeedQuery
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
//
// interleave 为真时改成轮流取：第 0 轮取每本相册的第 1 张，第 1 轮取
// 每本的第 2 张…… 连着看一本相册的头几张，看到的只是这一本；轮流取
// 之后每一本都露得出来，集合页的照片带才真的代表「这里有什么」。
func sliceFeedItems(albums []mediaFeedAlbum, start, end int, interleave bool) []FeedMediaItem {
	items := make([]FeedMediaItem, 0, end-start)
	if interleave {
		return interleaveFeedItems(albums, start, end)
	}
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

// interleaveFeedItems 按「轮流取」排出序列中的一段。
//
// 从头走到目标位置：不预先物化整条序列，翻页时多算一点，
// 换来的是不为大集合再留一份完整副本。
func interleaveFeedItems(albums []mediaFeedAlbum, start, end int) []FeedMediaItem {
	items := make([]FeedMediaItem, 0, end-start)
	seen := 0
	for round := 0; seen < end; round++ {
		progressed := false
		for _, album := range albums {
			if round >= len(album.media) {
				continue
			}
			progressed = true
			if seen >= start {
				items = append(items, FeedMediaItem{
					LibraryMediaItem: album.media[round],
					AlbumID:          album.id,
					AlbumName:        album.name,
				})
			}
			seen++
			if seen >= end {
				break
			}
		}
		if !progressed {
			break
		}
	}
	return items
}

// composeFeedAlbums 组装首页用的照片流：几本相册的照片交错排在一起。
//
// 交错而不是一本接一本：连着看一本相册的头几张，墙上就只剩一种口味。
// 轮流取能保证墙面上始终有多种内容。
func composeFeedAlbums(index *libraryPageIndex, q MediaFeedQuery, limit int, revision uint64) ([]FeedAlbumRef, []FeedMediaItem) {
	kind := models.NormalizeContentKind(string(q.Kind))
	albums := []LibraryNodeSummary{}
	rnd := newFeedRandomizer(q.Seed, revision)
	if q.Scope == MediaFeedRandom {
		albums = selectFeedAlbums(index, kind, mediaFeedAlbumCount, rnd)
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
		picked := media
		if q.Scope == MediaFeedRandom {
			// 等距取样，不取连续的一段：一本相册的前十二张常常是同一场
			// 活动的连拍，摊在墙上读起来像卡带。
			picked = spreadSample(media, mediaFeedPerAlbum, rnd)
		} else if len(media) > mediaFeedPerAlbum {
			picked = media[:mediaFeedPerAlbum]
		}
		takes = append(takes, mediaFeedAlbum{
			id:    album.ID,
			name:  album.DisplayName,
			media: picked,
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

// 一年里最多取几本相册。
//
// 照片流一次掺入 8 本：相册太多会显得杂乱，太少又只剩一种口味。
const mediaFeedAlbumCount = 8

// 同一个年份桶里最多取几本。
//
// 一年散在好几本相册里，全取就是同一种口味；每个年份给两三本，批次
// 里的年份因此能拉开。
const mediaFeedPerYearBucket = 2

// feedRandomizer 是照片流取材时用的随机源。
//
// 有种子时用可复现的伪随机：同一个种子给同一批照片，「换一批」因此
// 一定换得掉。没有种子时用加密随机，取样与从前一样不可预期。
type feedRandomizer struct {
	rnd *rand.Rand
}

// newFeedRandomizer 按种子取材用的随机源。
//
// 种子混进库版本号：扫描之后库变了，同一个种子给出的批次也跟着变 ——
// 否则「换一批」可能换出一批已经不在库里的照片。
func newFeedRandomizer(seed string, revision uint64) *feedRandomizer {
	var state uint64
	if seed != "" {
		sum := sha256.Sum256([]byte(seed + "|" + strconv.FormatUint(revision, 10)))
		state = binary.LittleEndian.Uint64(sum[:8])
	} else {
		var buf [8]byte
		if _, err := crand.Read(buf[:]); err != nil {
			state = uint64(time.Now().UnixNano())
		} else {
			state = binary.LittleEndian.Uint64(buf[:])
		}
	}
	return &feedRandomizer{rnd: rand.New(rand.NewPCG(state, state^0x9E3779B97F4A7C15))}
}

// intn 返回 [0, n) 里的一个随机整数。
func (r *feedRandomizer) intn(n int) int {
	if n <= 0 {
		return 0
	}
	return r.rnd.IntN(n)
}

// shuffle 就地打乱一个切片。
func (r *feedRandomizer) shuffle(values []int) {
	r.rnd.Shuffle(len(values), func(i, j int) {
		values[i], values[j] = values[j], values[i]
	})
}

// float64 返回 [0, 1) 里的随机数。
func (r *feedRandomizer) float64() float64 {
	return r.rnd.Float64()
}

// selectFeedAlbums 按年份分散地挑相册。
//
// 纯随机会撞：一次抽到七八本同一年、同一场活动的相册，墙上就只剩一种
// 口味。按年份分桶后轮流取，一批照片因此来自不同的年份、不同的场景。
//
// 库里只有一两年时第一轮就挑不满，第二轮不设上限补齐 —— 分 buckets 是
// 为了丰富，不是为了少给照片。
func selectFeedAlbums(index *libraryPageIndex, kind models.ContentKind, count int, rnd *feedRandomizer) []LibraryNodeSummary {
	positions := index.albumIndexesByKind[kind]
	if len(positions) == 0 || count <= 0 {
		return nil
	}
	buckets := map[int][]int{}
	for _, position := range positions {
		year := albumYearBucket(index.albums[position])
		buckets[year] = append(buckets[year], position)
	}
	keys := make([]int, 0, len(buckets))
	for key := range buckets {
		keys = append(keys, key)
	}
	// map 的遍历顺序每次都不同；不先排一遍，shuffle 的输入顺序就会飘，
	// 同一个种子给出的批次不再可复现 —— 「换一批」会换出乱序。
	sort.Ints(keys)
	rnd.shuffle(keys)

	picked := make([]int, 0, count)
	used := make(map[int]bool, count)
	// 第一轮：每个年份桶最多取几本，年份之间轮流取。
	for _, key := range keys {
		list := buckets[key]
		rnd.shuffle(list)
		taken := 0
		for _, position := range list {
			if taken >= mediaFeedPerYearBucket || len(picked) >= count {
				break
			}
			picked = append(picked, position)
			used[position] = true
			taken++
		}
	}
	// 第二轮：年份不够分时补齐。
	for _, key := range keys {
		if len(picked) >= count {
			break
		}
		for _, position := range buckets[key] {
			if len(picked) >= count {
				break
			}
			if used[position] {
				continue
			}
			picked = append(picked, position)
			used[position] = true
		}
	}
	albums := make([]LibraryNodeSummary, 0, len(picked))
	for _, position := range picked {
		albums = append(albums, index.albums[position])
	}
	return albums
}

// albumYearBucket 把相册归到年份桶。
//
// 优先用业务日期（拍摄时间 > 目录名 > 修改时间），取不到就用名字里的
// 年份；都没有时归到「年份未知」那一桶（0）。
func albumYearBucket(album LibraryNodeSummary) int {
	if !album.Date.IsZero() {
		return album.Date.Year()
	}
	if found := queryYearPattern.FindString(album.Name); found != "" {
		if year, err := strconv.Atoi(found); err == nil {
			return year
		}
	}
	return 0
}

// spreadSample 在一本相册里等距取 count 张。
//
// 连续的一段往往是同一场活动连拍（十几张几乎一样的照片），摊在墙上
// 读起来像卡带。等距抽样把整本相册的跨度摊开：同一本相册贡献的是它
// 各个时段的样子，而不是一个瞬间的连续帧。起点带一点随机相位，
// 否则每次都从同一个位置开始取。
func spreadSample(media []LibraryMediaItem, count int, rnd *feedRandomizer) []LibraryMediaItem {
	if count <= 0 {
		return nil
	}
	if len(media) <= count {
		return media
	}
	step := float64(len(media)) / float64(count)
	offset := rnd.float64() * step
	picked := make([]LibraryMediaItem, 0, count)
	for i := 0; i < count; i++ {
		position := int(offset + float64(i)*step)
		if position >= len(media) {
			position = len(media) - 1
		}
		picked = append(picked, media[position])
	}
	return picked
}
