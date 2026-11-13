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

// ErrChinaVisitNotFound 表示请求的到访序号不存在。
var ErrChinaVisitNotFound = errors.New("china region visit not found")

// ChinaLocationSummary 是全国省级照片地图的汇总结果。
type ChinaLocationSummary struct {
	Revision uint64 `json:"revision"`
	// BoundaryVersion 是离线边界数据的版本标识。
	BoundaryVersion      string                  `json:"boundaryVersion"`
	GPSPhotoCount        int                     `json:"gpsPhotoCount"`
	ChinaPhotoCount      int                     `json:"chinaPhotoCount"`
	UnassignedPhotoCount int                     `json:"unassignedPhotoCount"`
	Provinces            []ChinaLocationProvince `json:"provinces"`
	// Months 是本范围内的逐月分布，供时间轴使用。
	Months []ChinaLocationMonth `json:"months"`
	// Trajectory 是本范围内的停靠序列，供地图上的轨迹线使用。
	Trajectory []ChinaLocationStop `json:"trajectory"`
	// UntimedPhotoCount 是有位置但没有可信拍摄时间的照片数。
	UntimedPhotoCount int `json:"untimedPhotoCount"`
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
	// Months 是这个区域自己的逐月分布，随层级细化。
	Months []ChinaLocationMonth `json:"months"`
	// Trajectory 是这个区域下级之间的停靠序列。
	Trajectory []ChinaLocationStop `json:"trajectory"`
	// UntimedPhotoCount 是这个区域里没有可信拍摄时间的照片数。
	UntimedPhotoCount int `json:"untimedPhotoCount"`
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

// ChinaTimeRange 是请求指定的时间区间（左闭右闭，按拍摄时间的日历月）。
//
// 区间为空表示不限时间：空间统计按全部照片算，时间轴与轨迹只统计有
// 可信拍摄时间的那些。
type ChinaTimeRange struct {
	// From 是 "2019-01"，空表示不限。
	From string
	// To 是 "2019-12"，空表示不限。
	To string
}

// IsZero 判断是否没有限定时间。
func (r ChinaTimeRange) IsZero() bool {
	return r.From == "" && r.To == ""
}

// scopeKey 是区间在游标作用域里的标记：不同区间的游标不能串用。
func (r ChinaTimeRange) scopeKey() string {
	if r.IsZero() {
		return "all"
	}
	return r.From + "-" + r.To
}

// includes 判断一张照片是否落在区间内。
func (r ChinaTimeRange) includes(captured chinaCaptureTime) bool {
	if !captured.Valid {
		return false
	}
	if r.From != "" && captured.YearMonth < r.From {
		return false
	}
	if r.To != "" && captured.YearMonth > r.To {
		return false
	}
	return true
}

// ChinaLocationMonth 是某个月份的照片数。
type ChinaLocationMonth struct {
	Month string `json:"month"`
	Count int    `json:"count"`
}

// ChinaLocationStop 是轨迹上的一个停靠点：连续落在同一区域的一段时间。
type ChinaLocationStop struct {
	At         string `json:"at"`
	Until      string `json:"until"`
	Adcode     int    `json:"adcode"`
	Name       string `json:"name"`
	PhotoCount int    `json:"photoCount"`
}

// ChinaLocationVisitRegion 是一次到访期间去过的其它区域。
type ChinaLocationVisitRegion struct {
	Adcode int    `json:"adcode"`
	Name   string `json:"name"`
	Count  int    `json:"count"`
}

// ChinaLocationVisit 是一次到访：同一个区域里连续的一段拍摄。
type ChinaLocationVisit struct {
	StartedAt  string `json:"startedAt"`
	EndedAt    string `json:"endedAt"`
	DayCount   int    `json:"dayCount"`
	PhotoCount int    `json:"photoCount"`
	// Regions 是这段时间里去过的其它区域，按张数从多到少。
	// 始终给数组：前端直接读它的长度。
	Regions []ChinaLocationVisitRegion `json:"regions"`
}

// ChinaLocationVisits 是一个区域的到访记录。
type ChinaLocationVisits struct {
	Revision          uint64                  `json:"revision"`
	BoundaryVersion   string                  `json:"boundaryVersion"`
	Region            ChinaLocationRegionInfo `json:"region"`
	Visits            []ChinaLocationVisit    `json:"visits"`
	UntimedPhotoCount int                     `json:"untimedPhotoCount"`
}

// chinaVisitMaxGapDays 是切分到访的最大间隔（天）。
//
// 相邻两张照片的日历日间隔超过它就算另一次到访：跨夜的行程算同一次
// （间隔 1 天），隔很久回来算两次（间隔 3 天以上）。这个阈值落在实测
// 分布的拐点上 —— 1–2 天的间隔占多数，3 天起断崖式下跌。
const chinaVisitMaxGapDays = 2

// chinaVisitMaxOtherRegions 是到访里列出的其它区域上限。
const chinaVisitMaxOtherRegions = 3

// chinaVisit 是一次到访（服务层内部）。
type chinaVisit struct {
	startedAt chinaCaptureTime
	endedAt   chinaCaptureTime
	photos    []chinaRegionPhoto
}

// chinaMonthDistribution 统计逐月的照片数，按时间升序。
func chinaMonthDistribution(photos []chinaRegionPhoto) []ChinaLocationMonth {
	counts := make(map[string]int)
	for _, photo := range photos {
		if !photo.captured.Valid {
			continue
		}
		counts[photo.captured.YearMonth]++
	}
	months := make([]ChinaLocationMonth, 0, len(counts))
	for month, count := range counts {
		months = append(months, ChinaLocationMonth{Month: month, Count: count})
	}
	sort.Slice(months, func(i, j int) bool { return months[i].Month < months[j].Month })
	return months
}

// chinaTrajectoryStops 把按时间排列的照片切成停靠段：连续落在同一个
// 区域的一段照片算一次停靠。
//
// 停靠点只给区划码与名字，坐标由前端用行政区几何算 —— 响应里不出现
// 照片的经纬度。
func chinaTrajectoryStops(
	photos []chinaRegionPhoto,
	key func(chinaRegionPhoto) int,
	index *chinaAdminIndex,
) []ChinaLocationStop {
	stops := make([]ChinaLocationStop, 0, 8)
	current := 0
	count := 0
	var first, last chinaCaptureTime
	for _, photo := range photos {
		if !photo.captured.Valid {
			continue
		}
		adcode := key(photo)
		if adcode == 0 {
			continue
		}
		if adcode != current {
			if current != 0 {
				stops = append(stops, chinaStop(current, index, first, last, count))
			}
			current = adcode
			count = 0
			first = photo.captured
		}
		last = photo.captured
		count++
	}
	if current != 0 {
		stops = append(stops, chinaStop(current, index, first, last, count))
	}
	return stops
}

// chinaStop 组装一个停靠点。
func chinaStop(adcode int, index *chinaAdminIndex, first, last chinaCaptureTime, count int) ChinaLocationStop {
	name := ""
	if feature, exists := index.byAdcode[adcode]; exists {
		name = feature.name
	}
	return ChinaLocationStop{
		At:         first.DayKey,
		Until:      last.DayKey,
		Adcode:     adcode,
		Name:       name,
		PhotoCount: count,
	}
}

// splitChinaVisits 把一个区域的照片切成到访。
//
// 相邻两张照片的日历日间隔超过阈值就算另一次到访：跨夜的行程算同一次，
// 隔很久回来算两次。切分与照片筛选共用这个函数，到访列表与到访里的
// 照片因此永远对得上。
func splitChinaVisits(photos []chinaRegionPhoto) []chinaVisit {
	visits := make([]chinaVisit, 0, 4)
	current := chinaVisit{}
	for _, photo := range photos {
		if !photo.captured.Valid {
			continue
		}
		if len(current.photos) > 0 {
			gap := photo.captured.dayIndex() - current.endedAt.dayIndex()
			if gap > chinaVisitMaxGapDays {
				visits = append(visits, current)
				current = chinaVisit{}
			}
		}
		if len(current.photos) == 0 {
			current.startedAt = photo.captured
		}
		current.photos = append(current.photos, photo)
		current.endedAt = photo.captured
	}
	if len(current.photos) > 0 {
		visits = append(visits, current)
	}
	return visits
}

// otherRegionsWithin 返回一次到访期间去过的其它区域。
//
// ownKey 决定「其它」是怎么比的：省级范围比省级，市级范围比市。
func (m *chinaLocationMatch) otherRegionsWithin(
	visit chinaVisit,
	ownKey func(chinaRegionPhoto) int,
	index *chinaAdminIndex,
) []ChinaLocationVisitRegion {
	if m == nil || len(visit.photos) == 0 {
		return []ChinaLocationVisitRegion{}
	}
	own := ownKey(visit.photos[0])
	counts := make(map[int]int)
	start := sort.Search(len(m.timedPhotos), func(i int) bool {
		return !m.timedPhotos[i].captured.before(visit.startedAt)
	})
	for i := start; i < len(m.timedPhotos); i++ {
		photo := m.timedPhotos[i]
		if visit.endedAt.before(photo.captured) {
			break
		}
		adcode := ownKey(photo)
		if adcode == own || adcode == 0 {
			continue
		}
		counts[adcode]++
	}
	if len(counts) == 0 {
		return []ChinaLocationVisitRegion{}
	}
	regions := make([]ChinaLocationVisitRegion, 0, len(counts))
	for adcode, count := range counts {
		name := ""
		if feature, exists := index.byAdcode[adcode]; exists {
			name = feature.name
		}
		regions = append(regions, ChinaLocationVisitRegion{Adcode: adcode, Name: name, Count: count})
	}
	sort.Slice(regions, func(i, j int) bool {
		if regions[i].Count != regions[j].Count {
			return regions[i].Count > regions[j].Count
		}
		return regions[i].Adcode < regions[j].Adcode
	})
	if len(regions) > chinaVisitMaxOtherRegions {
		regions = regions[:chinaVisitMaxOtherRegions]
	}
	return regions
}

// Summary 返回全国省级照片地图的汇总结果。
func (s *ChinaLocationService) Summary(
	snapshot CatalogSnapshot,
	records []AIAnalysisRecord,
	recordsRevision uint64,
	validatePath func(string) (string, error),
	timeRange ChinaTimeRange,
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
		Months:               []ChinaLocationMonth{},
		Trajectory:           []ChinaLocationStop{},
	}
	for _, feature := range index.provinces {
		photos := match.scopedPhotos(match.provincePhotos[feature.adcode], timeRange)
		count := len(photos)
		matched := 0
		for _, child := range index.childrenByParent[feature.adcode] {
			matched += len(match.scopedPhotos(match.regionPhotos[child.adcode], timeRange))
		}
		summary.Provinces = append(summary.Provinces, ChinaLocationProvince{
			Adcode:                  feature.adcode,
			Name:                    feature.name,
			PhotoCount:              count,
			UnmatchedAreaPhotoCount: count - matched,
			Geometry:                feature.geometry,
		})
	}
	scoped := match.scopedPhotos(match.timedPhotos, timeRange)
	summary.Months = chinaMonthDistribution(scoped)
	summary.Trajectory = chinaTrajectoryStops(scoped, func(photo chinaRegionPhoto) int {
		return photo.provinceAdcode
	}, index)
	summary.UntimedPhotoCount = match.chinaPhotoCount - len(match.timedPhotos)
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
	timeRange ChinaTimeRange,
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
		count := len(match.scopedPhotos(match.regionPhotos[child.adcode], timeRange))
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
	scope := match.scopePhotosFor(feature)
	scoped := match.scopedPhotos(scope, timeRange)
	if feature.level == chinaAdminProvinceLevel {
		info.PhotoCount = len(scoped)
		info.UnmatchedAreaPhotoCount = info.PhotoCount - matched
	} else {
		parent := feature.parentAdcode
		info.ParentAdcode = &parent
		info.PhotoCount = len(scoped)
	}
	result := ChinaLocationRegions{
		Revision:        snapshot.Revision(),
		BoundaryVersion: chinaBoundaryVersion,
		Region:          info,
		Regions:         regions,
		Months:          chinaMonthDistribution(match.scopedPhotos(match.timedPhotosInScope(feature), timeRange)),
		Trajectory: chinaTrajectoryStops(match.scopedPhotos(match.timedPhotosInScope(feature), timeRange), func(photo chinaRegionPhoto) int {
			return photo.regionAdcode
		}, index),
		UntimedPhotoCount: match.untimedPhotoCount(scope),
	}
	return result, nil
}

// Visits 返回某个区域的到访记录，按开始时间升序。
func (s *ChinaLocationService) Visits(
	snapshot CatalogSnapshot,
	records []AIAnalysisRecord,
	recordsRevision uint64,
	validatePath func(string) (string, error),
	adcode int,
	timeRange ChinaTimeRange,
) (ChinaLocationVisits, error) {
	index, err := loadChinaAdminIndex()
	if err != nil {
		return ChinaLocationVisits{}, err
	}
	feature, exists := index.byAdcode[adcode]
	if !exists {
		return ChinaLocationVisits{}, ErrChinaRegionNotFound
	}
	match, err := s.currentMatch(snapshot, records, recordsRevision, validatePath)
	if err != nil {
		return ChinaLocationVisits{}, err
	}
	scope := match.scopePhotosFor(feature)
	scoped := match.scopedPhotos(scope, timeRange)
	visits := splitChinaVisits(scoped)
	ownKey := func(photo chinaRegionPhoto) int { return photo.regionAdcode }
	if feature.level == chinaAdminProvinceLevel {
		ownKey = func(photo chinaRegionPhoto) int { return photo.provinceAdcode }
	}
	result := ChinaLocationVisits{
		Revision:        snapshot.Revision(),
		BoundaryVersion: chinaBoundaryVersion,
		Region: ChinaLocationRegionInfo{
			Adcode:     feature.adcode,
			Name:       feature.name,
			Level:      feature.level,
			PhotoCount: len(scoped),
		},
		Visits:            make([]ChinaLocationVisit, 0, len(visits)),
		UntimedPhotoCount: match.untimedPhotoCount(scope),
	}
	for _, visit := range visits {
		result.Visits = append(result.Visits, ChinaLocationVisit{
			StartedAt:  visit.startedAt.DayKey,
			EndedAt:    visit.endedAt.DayKey,
			DayCount:   visit.endedAt.dayIndex() - visit.startedAt.dayIndex() + 1,
			PhotoCount: len(visit.photos),
			Regions:    match.otherRegionsWithin(visit, ownKey, index),
		})
	}
	return result, nil
}

// RegionMedia 返回某个区域的照片墙分页。
//
// 给了时间区间或到访序号时，照片按拍摄时间排列；没给时维持相册顺序，
// 与既有地点媒体页一致。出库前按当前媒体根重新校验路径。
func (s *ChinaLocationService) RegionMedia(
	snapshot CatalogSnapshot,
	records []AIAnalysisRecord,
	recordsRevision uint64,
	validatePath func(string) (string, error),
	adcode int,
	timeRange ChinaTimeRange,
	visit int,
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
	photos := match.scopedPhotos(match.scopePhotosFor(feature), timeRange)
	byVisit := visit >= 0
	if byVisit {
		visits := splitChinaVisits(photos)
		if visit >= len(visits) {
			return ChinaRegionMediaPage{}, ErrChinaVisitNotFound
		}
		photos = visits[visit].photos
	}
	if !byVisit && timeRange.IsZero() {
		// 缓存里的顺序是拍摄时间；相册顺序要另排一份，不能动缓存。
		photos = append([]chinaRegionPhoto(nil), photos...)
		sortChinaRegionPhotosByAlbum(photos)
	}
	scope := fmt.Sprintf("china-region-media:%d:%s:%d", adcode, timeRange.scopeKey(), visit)
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
