package services

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"sync"
)

// ErrChinaRegionNotFound 表示请求的区划码不在离线边界数据里。
var ErrChinaRegionNotFound = errors.New("china region not found")

// ErrInvalidChinaRegionAdcode 表示区划码格式不对。
var ErrInvalidChinaRegionAdcode = errors.New("invalid china region adcode")

// ChinaLocationSummary 是全国省级照片地图的汇总结果。
type ChinaLocationSummary struct {
	Revision uint64 `json:"revision"`
	// BoundaryVersion 是离线边界数据的版本标识。
	BoundaryVersion      string                  `json:"boundaryVersion"`
	GPSPhotoCount        int                     `json:"gpsPhotoCount"`
	ChinaPhotoCount      int                     `json:"chinaPhotoCount"`
	UnassignedPhotoCount int                     `json:"unassignedPhotoCount"`
	Provinces            []ChinaLocationProvince `json:"provinces"`
}

// ChinaLocationProvince 是一个省级区域及其绘图边界。
type ChinaLocationProvince struct {
	Adcode                  int             `json:"adcode"`
	Name                    string          `json:"name"`
	PhotoCount              int             `json:"photoCount"`
	UnmatchedAreaPhotoCount int             `json:"unmatchedAreaPhotoCount"`
	Geometry                json.RawMessage `json:"geometry"`
}

// ChinaLocationRegionInfo 描述当前聚焦的那个区域本身。
type ChinaLocationRegionInfo struct {
	Adcode                  int    `json:"adcode"`
	Name                    string `json:"name"`
	Level                   string `json:"level"`
	PhotoCount              int    `json:"photoCount"`
	UnmatchedAreaPhotoCount int    `json:"unmatchedAreaPhotoCount"`
	// ParentAdcode 是上级的区划码；省级区域为 null。
	ParentAdcode *int `json:"parentAdcode"`
}

// ChinaLocationRegion 是一个下级区域及其绘图边界。
type ChinaLocationRegion struct {
	Adcode     int             `json:"adcode"`
	Name       string          `json:"name"`
	Level      string          `json:"level"`
	PhotoCount int             `json:"photoCount"`
	Geometry   json.RawMessage `json:"geometry"`
}

// ChinaLocationRegions 是某个区域的下一级地图。
//
// regions 为空表示这个区域没有更细的边界，它就是终点。
type ChinaLocationRegions struct {
	Revision        uint64                  `json:"revision"`
	BoundaryVersion string                  `json:"boundaryVersion"`
	Region          ChinaLocationRegionInfo `json:"region"`
	Regions         []ChinaLocationRegion   `json:"regions"`
}

// ChinaRegionMediaPage 是某个区域的照片墙分页。
type ChinaRegionMediaPage struct {
	MediaFeedPage
	Region ChinaLocationRegionInfo `json:"region"`
}

// ChinaLocationService 复用同一次照片匹配结果，为全国地图、子区域地图与
// 区域照片墙提供一致的计数与照片集合。
//
// 匹配要逐张核对文件指纹并做点在多边形判定，大库上并不便宜；结果按
// 媒体库版本与分析记录版本缓存，两个版本都没变时直接复用。
type ChinaLocationService struct {
	mu    sync.Mutex
	key   chinaLocationCacheKey
	match *chinaLocationMatch
}

type chinaLocationCacheKey struct {
	catalogRevision uint64
	recordsRevision uint64
	// validatorID 是路径校验函数的代码地址。
	//
	// 换了一个校验器就意味着校验行为变了，缓存不能复用。
	validatorID uintptr
}

// NewChinaLocationService 创建离线地点图谱服务。
func NewChinaLocationService() *ChinaLocationService {
	return &ChinaLocationService{}
}

// ChinaLocationBoundaryHash 返回内嵌边界数据的内容指纹。
func ChinaLocationBoundaryHash() string {
	index, err := loadChinaAdminIndex()
	if err != nil {
		return ""
	}
	return index.hash
}

// Summary 返回全国省级照片地图的汇总结果。
func (s *ChinaLocationService) Summary(
	snapshot CatalogSnapshot,
	records []AIAnalysisRecord,
	recordsRevision uint64,
	validatePath func(string) (string, error),
) (ChinaLocationSummary, error) {
	match, err := s.currentMatch(snapshot, records, recordsRevision, validatePath)
	if err != nil {
		return ChinaLocationSummary{}, err
	}
	index, err := loadChinaAdminIndex()
	if err != nil {
		return ChinaLocationSummary{}, err
	}
	summary := ChinaLocationSummary{
		Revision:             snapshot.Revision(),
		BoundaryVersion:      chinaBoundaryVersion,
		GPSPhotoCount:        match.gpsPhotoCount,
		ChinaPhotoCount:      match.chinaPhotoCount,
		UnassignedPhotoCount: match.gpsPhotoCount - match.chinaPhotoCount,
		Provinces:            make([]ChinaLocationProvince, 0, len(index.provinces)),
	}
	for _, feature := range index.provinces {
		count := match.provincePhotoCount(feature.adcode)
		matched := 0
		for _, child := range index.childrenByParent[feature.adcode] {
			matched += match.regionPhotoCount(child.adcode)
		}
		summary.Provinces = append(summary.Provinces, ChinaLocationProvince{
			Adcode:                  feature.adcode,
			Name:                    feature.name,
			PhotoCount:              count,
			UnmatchedAreaPhotoCount: count - matched,
			Geometry:                feature.geometry,
		})
	}
	return summary, nil
}

// Regions 返回某个区域的下一级地图。
//
// 传入省级区划码得到该省的地级市（直辖市与特别行政区得到区县）；
// 传入更细的区划码得到它的下一级；没有下一级时 regions 为空。
func (s *ChinaLocationService) Regions(
	snapshot CatalogSnapshot,
	records []AIAnalysisRecord,
	recordsRevision uint64,
	validatePath func(string) (string, error),
	adcode int,
) (ChinaLocationRegions, error) {
	index, err := loadChinaAdminIndex()
	if err != nil {
		return ChinaLocationRegions{}, err
	}
	feature, exists := index.byAdcode[adcode]
	if !exists {
		return ChinaLocationRegions{}, ErrChinaRegionNotFound
	}
	match, err := s.currentMatch(snapshot, records, recordsRevision, validatePath)
	if err != nil {
		return ChinaLocationRegions{}, err
	}
	children := index.childrenByParent[adcode]
	regions := make([]ChinaLocationRegion, 0, len(children))
	matched := 0
	for _, child := range children {
		count := match.regionPhotoCount(child.adcode)
		matched += count
		regions = append(regions, ChinaLocationRegion{
			Adcode:     child.adcode,
			Name:       child.name,
			Level:      child.level,
			PhotoCount: count,
			Geometry:   child.geometry,
		})
	}
	info := ChinaLocationRegionInfo{
		Adcode: feature.adcode,
		Name:   feature.name,
		Level:  feature.level,
	}
	if feature.level == chinaAdminProvinceLevel {
		info.PhotoCount = match.provincePhotoCount(feature.adcode)
		info.UnmatchedAreaPhotoCount = info.PhotoCount - matched
	} else {
		parent := feature.parentAdcode
		info.ParentAdcode = &parent
		info.PhotoCount = match.regionPhotoCount(feature.adcode)
	}
	return ChinaLocationRegions{
		Revision:        snapshot.Revision(),
		BoundaryVersion: chinaBoundaryVersion,
		Region:          info,
		Regions:         regions,
	}, nil
}

// RegionMedia 返回某个区域的照片墙分页。
//
// 照片按相册顺序与相册内序号排列，与既有地点媒体页一致；出库前按当前
// 媒体根重新校验路径。
func (s *ChinaLocationService) RegionMedia(
	snapshot CatalogSnapshot,
	records []AIAnalysisRecord,
	recordsRevision uint64,
	validatePath func(string) (string, error),
	adcode int,
	cursor string,
	limit int,
) (ChinaRegionMediaPage, error) {
	index, err := loadChinaAdminIndex()
	if err != nil {
		return ChinaRegionMediaPage{}, err
	}
	feature, exists := index.byAdcode[adcode]
	if !exists {
		return ChinaRegionMediaPage{}, ErrChinaRegionNotFound
	}
	match, err := s.currentMatch(snapshot, records, recordsRevision, validatePath)
	if err != nil {
		return ChinaRegionMediaPage{}, err
	}
	photos := match.regionPhotos[adcode]
	scope := fmt.Sprintf("china-region-media:%d", adcode)
	offset, err := pageOffset(snapshot, cursor, scope)
	if err != nil {
		return ChinaRegionMediaPage{}, err
	}
	start, end, next, err := pageBounds(snapshot.Revision(), scope, cursor != "", offset, len(photos), limit)
	if err != nil {
		return ChinaRegionMediaPage{}, err
	}
	ids := make([]string, 0, end-start)
	for _, photo := range photos[start:end] {
		ids = append(ids, photo.resourceID)
	}
	items := ResolveLibraryFeedItems(snapshot, ids, validatePath)
	albums := make(map[string]*FeedAlbumRef)
	for _, item := range items {
		ref, exists := albums[item.AlbumID]
		if !exists {
			ref = &FeedAlbumRef{ID: item.AlbumID, Name: item.AlbumName}
			albums[item.AlbumID] = ref
		}
		ref.Count++
	}
	albumRefs := make([]FeedAlbumRef, 0, len(albums))
	for _, ref := range albums {
		albumRefs = append(albumRefs, *ref)
	}
	sort.Slice(albumRefs, func(i, j int) bool { return albumRefs[i].Name < albumRefs[j].Name })
	return ChinaRegionMediaPage{
		MediaFeedPage: MediaFeedPage{
			LibraryPage: LibraryPage[FeedMediaItem]{
				Revision: snapshot.Revision(), Items: items, Total: len(photos), NextCursor: next,
			},
			Albums:  albumRefs,
			Sources: []FeedSource{},
		},
		Region: ChinaLocationRegionInfo{
			Adcode:     feature.adcode,
			Name:       feature.name,
			Level:      feature.level,
			PhotoCount: len(photos),
		},
	}, nil
}

// currentMatch 取出当前版本的匹配结果，必要时重新匹配并缓存。
func (s *ChinaLocationService) currentMatch(
	snapshot CatalogSnapshot,
	records []AIAnalysisRecord,
	recordsRevision uint64,
	validatePath func(string) (string, error),
) (*chinaLocationMatch, error) {
	key := chinaLocationCacheKey{
		catalogRevision: snapshot.Revision(),
		recordsRevision: recordsRevision,
		validatorID:     reflect.ValueOf(validatePath).Pointer(),
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.match != nil && s.key == key {
		return s.match, nil
	}
	match, err := matchChinaLocations(snapshot, records, validatePath)
	if err != nil {
		return nil, err
	}
	s.match = match
	s.key = key
	return match, nil
}
