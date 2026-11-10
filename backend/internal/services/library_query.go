package services

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	lru "github.com/hashicorp/golang-lru/v2"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// LibraryQuery 描述分页前的列表条件，parent 与 tag 互斥。
type LibraryQuery struct {
	Kind          LibraryKindScope `json:"kind"`
	Parent        string           `json:"parent,omitempty"`
	Tag           string           `json:"tag,omitempty"`
	View          string           `json:"view"`
	Query         string           `json:"q"`
	Year          string           `json:"year,omitempty"`
	MinImageCount int              `json:"minImageCount"`
	Sort          string           `json:"sort"`
	// ExcludeYearTargets 把按年份归组的代表节点从列表里去掉。
	//
	// 首页的年份索引直接给照片墙看，那些集合不必在列表里再出现一次：
	// 同一批内容摆两处，用户只会以为看错了。只有顶层范围生效 ——
	// 集合页里的子项不该被年份分组抹掉，搜索时也要找得到它们。
	ExcludeYearTargets bool `json:"excludeYearTargets,omitempty"`
}

var ErrInvalidLibraryQuery = errors.New("invalid library query")
var queryYearPattern = regexp.MustCompile(`(?:19|20)\d{2}`)

type LibraryQueryItem struct {
	Kind string              `json:"kind"`
	Node *LibraryNodeSummary `json:"node,omitempty"`
	Tag  *LibraryTagSummary  `json:"tag,omitempty"`
}

type LibraryQueryYear struct {
	Year       *int             `json:"year"`
	Count      int              `json:"count"`
	ImageTotal int              `json:"imageTotal"`
	VideoTotal int              `json:"videoTotal"`
	Target     LibraryQueryItem `json:"target"`
	CoverImage string           `json:"coverImage,omitempty"`
	// CoverImageVersion 是封面文件的内容版本号。
	CoverImageVersion string `json:"coverImageVersion,omitempty"`
}

type LibraryQuerySeries struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Count      int    `json:"count"`
	CoverImage string `json:"coverImage,omitempty"`
	// CoverImageVersion 是封面文件的内容版本号。
	CoverImageVersion string `json:"coverImageVersion,omitempty"`
}

type LibraryQueryPage struct {
	ScopeCounts map[string]int `json:"scopeCounts"`
	LibraryPage[LibraryQueryItem]
	Counts         map[string]int       `json:"counts"`
	Years          []LibraryQueryYear   `json:"years"`
	Series         []LibraryQuerySeries `json:"series"`
	ImageTotal     int                  `json:"imageTotal"`
	VideoTotal     int                  `json:"videoTotal"`
	CompletedCount int                  `json:"completedCount"`
	LatestModified time.Time            `json:"latestModified"`
}

func (q *LibraryQuery) Normalize() error {
	q.Query = strings.ToLower(strings.TrimSpace(q.Query))
	if q.View == "" {
		q.View = "all"
	}
	if q.Sort == "" {
		q.Sort = "name"
	}
	if q.Kind != LibraryKindScope(models.ContentKindPhoto) && q.Kind != LibraryKindScope(models.ContentKindComic) {
		return ErrInvalidLibraryQuery
	}
	if q.Parent != "" && q.Tag != "" {
		return ErrInvalidLibraryQuery
	}
	if q.View != "all" && q.View != "album" && q.View != "collection" && q.View != "smart" {
		return ErrInvalidLibraryQuery
	}
	if q.Sort != "name" && q.Sort != "count" && q.Sort != "added" && q.Sort != "recent" && q.Sort != "viewed" {
		return ErrInvalidLibraryQuery
	}
	if q.MinImageCount < 0 || len(q.Query) > 1024 {
		return ErrInvalidLibraryQuery
	}
	if q.Year != "" && q.Year != "other" {
		y, err := strconv.Atoi(q.Year)
		if err != nil || y < 1900 || y > 2099 {
			return ErrInvalidLibraryQuery
		}
	}
	return nil
}

// PageLibraryQuery 只读取不可变库快照与固定历史快照。
func PageLibraryQuery(snapshot CatalogSnapshot, q LibraryQuery, history []models.HistoryEntry, cursor string, limit int) (LibraryQueryPage, error) {
	if err := q.Normalize(); err != nil {
		return LibraryQueryPage{}, err
	}
	if !snapshot.Ready() || snapshot.state.library == nil {
		return LibraryQueryPage{}, ErrLibraryNotReady
	}
	index := snapshot.state.library
	key, _ := json.Marshal(struct {
		Query   LibraryQuery
		History []models.HistoryEntry
	}{q, historyForSort(q.Sort, history)})
	hash := sha256.Sum256(key)
	scope := "library-query:" + hex.EncodeToString(hash[:])
	index.queryOnce.Do(func() { index.queries, _ = lru.New[string, LibraryQueryPage](16) })
	if cached, ok := index.queries.Get(scope); ok {
		return sliceLibraryQuery(snapshot, cached, scope, cursor, limit)
	}
	nodes := []LibraryNodeSummary{}
	switch {
	case q.Parent != "":
		var ok bool
		nodes, ok = index.children[q.Parent]
		if !ok {
			return LibraryQueryPage{}, ErrLibraryResourceNotFound
		}
	case q.Tag != "":
		var ok bool
		nodes, ok = index.tagAlbums[q.Tag]
		if !ok {
			return LibraryQueryPage{}, ErrLibraryTagNotFound
		}
	default:
		for _, root := range snapshot.state.roots {
			for _, node := range index.children[root.ID] {
				if !node.Virtual {
					nodes = append(nodes, node)
				}
			}
		}
	}
	items := make([]LibraryQueryItem, 0, len(nodes))
	result := LibraryQueryPage{Counts: map[string]int{"all": 0, "album": 0, "collection": 0, "smart": 0}, Years: []LibraryQueryYear{}, Series: []LibraryQuerySeries{}}
	years := map[string]*LibraryQueryYear{}
	for _, node := range nodes {
		if node.ContentKind != string(q.Kind) {
			continue
		}
		n := node
		item := LibraryQueryItem{Kind: n.Kind, Node: &n}
		items = append(items, item)
		result.ImageTotal += n.ImageCount
		result.VideoTotal += n.VideoCount
		if n.ModTime.After(result.LatestModified) {
			result.LatestModified = n.ModTime
		}
		if !n.Virtual {
			y := queryYearPattern.FindString(n.Name)
			group := years[y]
			if group == nil {
				group = &LibraryQueryYear{Target: item, CoverImage: n.CoverImage, CoverImageVersion: n.CoverImageVersion}
				if y != "" {
					value, _ := strconv.Atoi(y)
					group.Year = &value
				}
				years[y] = group
			}
			group.Count++
			group.ImageTotal += n.ImageCount
			group.VideoTotal += n.VideoCount
			if (n.Kind == "collection" && group.Target.Kind != "collection") || (n.Kind == group.Target.Kind && queryItemCount(item) > queryItemCount(group.Target)) {
				group.Target = item
				group.CoverImage = n.CoverImage
				group.CoverImageVersion = n.CoverImageVersion
			}
		}
		if n.Kind == "collection" && q.Kind == LibraryKindComic {
			result.Series = append(result.Series, LibraryQuerySeries{ID: n.ID, Name: n.DisplayName, Count: n.AlbumCount, CoverImage: n.CoverImage, CoverImageVersion: n.CoverImageVersion})
		}
	}
	for _, group := range years {
		result.Years = append(result.Years, *group)
	}
	// 年份索引已经把那些集合讲清楚了，列表里不再重复摆一遍。
	// 只在「没有别的条件」的浏览视图里这么做：一旦用户在搜索或按年份
	// 筛选，列表就该老老实实给出全部命中。
	if q.ExcludeYearTargets && q.Parent == "" && q.Tag == "" && q.Year == "" && q.Query == "" {
		items, result.ImageTotal, result.VideoTotal = withoutYearTargets(items, result.ImageTotal, result.VideoTotal, years)
	}
	sort.Slice(result.Years, func(i, j int) bool {
		a, b := result.Years[i].Year, result.Years[j].Year
		return a != nil && (b == nil || *a > *b)
	})
	sort.Slice(result.Series, func(i, j int) bool {
		a, b := result.Series[i], result.Series[j]
		if a.Count != b.Count {
			return a.Count > b.Count
		}
		return a.ID < b.ID
	})
	if q.Parent == "" && q.Tag == "" {
		for _, tag := range index.tags {
			t := tag
			t.AlbumCount = 0
			for _, n := range index.tagAlbums[t.Tag] {
				if n.ContentKind == string(q.Kind) {
					t.AlbumCount++
				}
			}
			if t.AlbumCount > 0 {
				items = append(items, LibraryQueryItem{Kind: "smart", Tag: &t})
			}
		}
	}
	result.ScopeCounts = map[string]int{"all": len(items), "album": 0, "collection": 0, "smart": 0}
	loose := LibraryQuerySeries{Name: "未归入作品"}
	for _, item := range items {
		result.ScopeCounts[item.Kind]++
		if q.Kind == LibraryKindComic && item.Kind == "album" {
			loose.Count++
			if loose.ID == "" {
				loose.ID = item.Node.ID
				loose.CoverImage = item.Node.CoverImage
			}
		}
	}
	if loose.Count > 0 {
		result.Series = append(result.Series, loose)
	}
	times := map[string]time.Time{}
	if q.Sort == "viewed" {
		for _, entry := range history {
			times[entry.AlbumID] = entry.OpenedAt
		}
	}
	filtered := make([]LibraryQueryItem, 0, len(items))
	for _, item := range items {
		title, subtitle := queryItemText(item, q.Parent != "")
		if q.Query != "" && !strings.Contains(strings.ToLower(title+" "+subtitle), q.Query) {
			continue
		}
		if item.Kind == "album" && item.Node.ImageCount < q.MinImageCount {
			continue
		}
		if q.Year != "" {
			y := queryYearPattern.FindString(title)
			if (q.Year == "other" && y != "") || (q.Year != "other" && y != q.Year) {
				continue
			}
		}
		result.Counts["all"]++
		result.Counts[item.Kind]++
		if q.View == "all" || q.View == item.Kind {
			filtered = append(filtered, item)
		}
	}
	sort.Slice(filtered, func(i, j int) bool {
		a, b := filtered[i], filtered[j]
		if q.Sort == "count" && queryItemCount(a) != queryItemCount(b) {
			return queryItemCount(a) > queryItemCount(b)
		}
		date := func(item LibraryQueryItem) time.Time {
			if item.Node == nil {
				return time.Time{}
			}
			switch q.Sort {
			case "viewed":
				return times[item.Node.ID]
			case "added":
				if !item.Node.Date.IsZero() {
					return item.Node.Date
				}
				return item.Node.ModTime
			case "recent":
				return item.Node.ModTime
			}
			return time.Time{}
		}
		if da, db := date(a), date(b); !da.Equal(db) {
			return da.After(db)
		}
		ta, _ := queryItemText(a, q.Parent != "")
		tb, _ := queryItemText(b, q.Parent != "")
		if ta != tb {
			return naturalLess(ta, tb)
		}
		return queryItemID(a) < queryItemID(b)
	})
	result.LibraryPage = LibraryPage[LibraryQueryItem]{Revision: snapshot.Revision(), Items: filtered, Total: len(filtered)}
	index.queries.Add(scope, result)
	return sliceLibraryQuery(snapshot, result, scope, cursor, limit)
}

func sliceLibraryQuery(snapshot CatalogSnapshot, result LibraryQueryPage, scope, cursor string, limit int) (LibraryQueryPage, error) {
	offset, err := pageOffset(snapshot, cursor, scope)
	if err != nil {
		return LibraryQueryPage{}, err
	}
	start, end, next, err := pageBounds(snapshot.Revision(), scope, cursor != "", offset, result.Total, limit)
	if err != nil {
		return LibraryQueryPage{}, err
	}
	cloned := make([]LibraryQueryItem, end-start)
	for i, item := range result.Items[start:end] {
		cloned[i] = cloneQueryItem(item)
	}
	result.LibraryPage = LibraryPage[LibraryQueryItem]{Revision: snapshot.Revision(), Items: cloned, Total: result.Total, NextCursor: next}
	counts := map[string]int{}
	for k, v := range result.Counts {
		counts[k] = v
	}
	result.Counts = counts
	scopeCounts := map[string]int{}
	for k, v := range result.ScopeCounts {
		scopeCounts[k] = v
	}
	result.ScopeCounts = scopeCounts
	result.Years = append([]LibraryQueryYear{}, result.Years...)
	for i := range result.Years {
		result.Years[i].Target = cloneQueryItem(result.Years[i].Target)
	}
	result.Series = append([]LibraryQuerySeries{}, result.Series...)
	return result, nil
}

// withoutYearTargets 去掉各年份分组的代表节点，并重算媒体总量。
//
// 「其他」那一桶不算年份：它的成员是普通相册与散图，留在列表里。
// 去掉之后列表空了就把东西放回去 —— 空列表比重复更糟。
func withoutYearTargets(items []LibraryQueryItem, imageTotal, videoTotal int, years map[string]*LibraryQueryYear) ([]LibraryQueryItem, int, int) {
	targets := map[string]bool{}
	for _, group := range years {
		if group.Year == nil || group.Target.Node == nil {
			continue
		}
		targets[group.Target.Node.ID] = true
	}
	if len(targets) == 0 {
		return items, imageTotal, videoTotal
	}
	kept := make([]LibraryQueryItem, 0, len(items))
	keptImages, keptVideos := 0, 0
	for _, item := range items {
		if item.Node != nil && targets[item.Node.ID] {
			continue
		}
		kept = append(kept, item)
		if item.Node != nil {
			keptImages += item.Node.ImageCount
			keptVideos += item.Node.VideoCount
		}
	}
	if len(kept) == 0 {
		return items, imageTotal, videoTotal
	}
	return kept, keptImages, keptVideos
}

func historyForSort(sort string, history []models.HistoryEntry) []models.HistoryEntry {
	if sort == "viewed" {
		return history
	}
	return nil
}
func queryItemText(item LibraryQueryItem, collection bool) (string, string) {
	if item.Tag != nil {
		return item.Tag.Tag, ""
	}
	n := item.Node
	title := n.Name
	if n.Virtual {
		title = n.Location
		if collection {
			title = "散图"
		}
	}
	return title, strings.Join(n.Tags, " · ")
}
func queryItemCount(item LibraryQueryItem) int {
	if item.Tag != nil {
		return item.Tag.AlbumCount
	}
	if item.Kind == "collection" {
		return item.Node.AlbumCount
	}
	return item.Node.ImageCount
}
func queryItemID(item LibraryQueryItem) string {
	if item.Tag != nil {
		return "smart:" + item.Tag.Tag
	}
	return item.Node.ID
}

// QueryCompletedCount 按整个标签统计，不能只统计已加载的一页。
func QueryCompletedCount(snapshot CatalogSnapshot, q LibraryQuery, activities []models.Activity) int {
	if q.Tag == "" || !snapshot.Ready() {
		return 0
	}
	completed := map[string]bool{}
	for _, a := range activities {
		if a.MediaKind == models.MediaKindImage && a.Status == models.ActivityCompleted {
			completed[a.AlbumID] = true
		}
	}
	count := 0
	for _, n := range snapshot.state.library.tagAlbums[q.Tag] {
		if n.ContentKind == string(q.Kind) && completed[n.ID] {
			count++
		}
	}
	return count
}

// queryCacheFields 的互斥初始化由快照拥有；旧快照回收时缓存一起释放。
type queryCacheFields struct {
	queryOnce sync.Once
	queries   *lru.Cache[string, LibraryQueryPage]
}

func cloneQueryItem(item LibraryQueryItem) LibraryQueryItem {
	if item.Node != nil {
		n := cloneNodeSummary(*item.Node)
		item.Node = &n
	}
	if item.Tag != nil {
		tag := *item.Tag
		tag.CoverImages = append([]string{}, tag.CoverImages...)
		item.Tag = &tag
	}
	return item
}
