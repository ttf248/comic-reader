package services

import (
	"fmt"
	"sort"
)

// ChinaPlace 是一个地点索引项。
//
// 地点索引回答「我去过哪些地方」：与地图的排行不同，它只列有照片的
// 地方 —— 没有照片的省不需要在主栏里占一行，地图上仍然完整可见。
type ChinaPlace struct {
	Adcode int    `json:"adcode"`
	Name   string `json:"name"`
	Level  string `json:"level"`
	// PhotoCount 是归并到这一层的照片数（含下级）。
	PhotoCount int `json:"photoCount"`
	// UnmatchedCount 是这个地点的照片里没有落到任何直接下级的数量。
	UnmatchedCount int `json:"unmatchedCount"`
	// VisitCount 是按到访口径切出的次数。
	VisitCount int `json:"visitCount"`
	// FirstAt 与 LastAt 是这个地点有可信拍摄时间的第一天与最后一天，
	// 没有可信时间时是空串。
	FirstAt string `json:"firstAt"`
	LastAt  string `json:"lastAt"`
	// CoverResourceIDs 是代表照的资源 ID，最多 4 张。
	CoverResourceIDs []string `json:"coverResourceIds"`
}

// ChinaPlaces 是地点索引的响应。
type ChinaPlaces struct {
	Revision             uint64       `json:"revision"`
	BoundaryVersion      string       `json:"boundaryVersion"`
	Level                string       `json:"level"`
	Total                int          `json:"total"`
	GPSPhotoCount        int          `json:"gpsPhotoCount"`
	ChinaPhotoCount      int          `json:"chinaPhotoCount"`
	UnassignedPhotoCount int          `json:"unassignedPhotoCount"`
	UntimedPhotoCount    int          `json:"untimedPhotoCount"`
	Places               []ChinaPlace `json:"places"`
}

// ChinaTripStop 是一次行程里的一个停留段。
type ChinaTripStop struct {
	Adcode     int    `json:"adcode"`
	Name       string `json:"name"`
	Level      string `json:"level"`
	At         string `json:"at"`
	Until      string `json:"until"`
	DayCount   int    `json:"dayCount"`
	PhotoCount int    `json:"photoCount"`
}

// ChinaTrip 是一段行程或一次停留。
//
// 行程与到访用同一个切分口径（相邻照片的日历日间隔超过 2 天就断开），
// 区别只在粒度：到访比的是同一个地方，行程比的是「去了哪些地方」。
// 一段里只出现了一个地方，那是「停留」而不是「行程」。
type ChinaTrip struct {
	// Id 是稳定标识：起始日 + 第一个停留点的区划码。
	Id string `json:"id"`
	// Kind 是 "trip"（走过多个地方）或 "stay"（只在一个地方）。
	Kind             string          `json:"kind"`
	StartedAt        string          `json:"startedAt"`
	EndedAt          string          `json:"endedAt"`
	DayCount         int             `json:"dayCount"`
	PhotoCount       int             `json:"photoCount"`
	Stops            []ChinaTripStop `json:"stops"`
	CoverResourceIDs []string        `json:"coverResourceIds"`
}

// ChinaTrips 是行程的响应。
type ChinaTrips struct {
	Revision          uint64      `json:"revision"`
	BoundaryVersion   string      `json:"boundaryVersion"`
	Granularity       string      `json:"granularity"`
	Total             int         `json:"total"`
	Trips             []ChinaTrip `json:"trips"`
	UntimedPhotoCount int         `json:"untimedPhotoCount"`
}

// 行政层级的公开名字。界面按这些名字显示层级徽标。
const (
	ChinaProvinceLevel = chinaAdminProvinceLevel
	ChinaCityLevel     = chinaAdminCityLevel
	ChinaDistrictLevel = chinaAdminDistrictLevel
)

// chinaPlaceGranularities 是地点索引支持的归并粒度。
var chinaPlaceGranularities = []string{
	chinaAdminProvinceLevel,
	chinaAdminCityLevel,
	chinaAdminDistrictLevel,
}

// IsChinaPlaceGranularity 判断是不是受支持的归并粒度。
func IsChinaPlaceGranularity(level string) bool {
	for _, candidate := range chinaPlaceGranularities {
		if candidate == level {
			return true
		}
	}
	return false
}

// chinaPlaceKey 返回一张照片在给定粒度下归属的区划码。
//
// 粒度是「归并到哪一层」：一张照片落到区县时，在市级粒度上归它的市，
// 在区县级粒度上归它自己。一个地方没有更细的下级（比如直辖市的区县
// 没有市一级）就往上退一级 —— 上海的照片在市级粒度上归上海，
// 这正是用户心里的说法。
//
// 返回 0 表示这张照片没有位置。
func chinaPlaceKey(photo chinaRegionPhoto, level string, index *chinaAdminIndex) int {
	if photo.regionAdcode == 0 {
		return photo.provinceAdcode
	}
	current, exists := index.byAdcode[photo.regionAdcode]
	if !exists {
		return photo.provinceAdcode
	}
	for depth := 0; depth < 4; depth++ {
		switch {
		case current.level == level:
			return current.adcode
		case level == chinaAdminCityLevel && current.level == chinaAdminCityLevel:
			return current.adcode
		case level == chinaAdminDistrictLevel && current.level == chinaAdminCityLevel:
			// 只匹配到市，没有更细的归属：留在市一级。
			return current.adcode
		}
		parent, found := index.byAdcode[current.parentAdcode]
		if !found {
			break
		}
		current = parent
	}
	return photo.provinceAdcode
}

// chinaPlaceDescendant 判断一个区划是不是在另一个区划之下（含自身）。
func chinaPlaceDescendant(adcode, ancestor int, index *chinaAdminIndex) bool {
	if ancestor == 0 {
		return true
	}
	current, exists := index.byAdcode[adcode]
	for depth := 0; exists && depth < 5; depth++ {
		if current.adcode == ancestor {
			return true
		}
		current, exists = index.byAdcode[current.parentAdcode]
	}
	return false
}

// Places 返回地点索引。
//
// level 是归并粒度：省、市或区县。parentAdcode 不为 0 时只列这个上级
// 之下的地方。结果只含有照片的地方 —— 没去过的省不进主栏。
func (s *ChinaLocationService) Places(
	snapshot CatalogSnapshot,
	records []AIAnalysisRecord,
	recordsRevision uint64,
	validatePath func(string) (string, error),
	level string,
	parentAdcode int,
	timeRange ChinaTimeRange,
) (ChinaPlaces, error) {
	if !IsChinaPlaceGranularity(level) {
		return ChinaPlaces{}, fmt.Errorf("unknown place granularity %q", level)
	}
	match, err := s.currentMatch(snapshot, records, recordsRevision, validatePath)
	if err != nil {
		return ChinaPlaces{}, err
	}
	index, err := loadChinaAdminIndex()
	if err != nil {
		return ChinaPlaces{}, err
	}
	if parentAdcode != 0 {
		if _, exists := index.byAdcode[parentAdcode]; !exists {
			return ChinaPlaces{}, ErrChinaRegionNotFound
		}
	}

	// 先按粒度把照片归到地方，再逐个地方算统计。
	photosByPlace := make(map[int][]chinaRegionPhoto)
	for _, provincePhotos := range match.provincePhotos {
		for _, photo := range match.scopedPhotos(provincePhotos, timeRange) {
			key := chinaPlaceKey(photo, level, index)
			if key == 0 {
				continue
			}
			if !chinaPlaceDescendant(key, parentAdcode, index) {
				continue
			}
			photosByPlace[key] = append(photosByPlace[key], photo)
		}
	}

	places := make([]ChinaPlace, 0, len(photosByPlace))
	for adcode, photos := range photosByPlace {
		feature, exists := index.byAdcode[adcode]
		if !exists {
			continue
		}
		sortChinaRegionPhotos(photos)
		visits := splitChinaVisits(photos)
		place := ChinaPlace{
			Adcode:           adcode,
			Name:             feature.name,
			Level:            feature.level,
			PhotoCount:       len(photos),
			VisitCount:       len(visits),
			CoverResourceIDs: chinaPlaceCoverIDs(photos, visits),
		}
		place.UnmatchedCount = unmatchedChinaRegionPhotoCount(photos, feature, index)
		for _, photo := range photos {
			if !photo.captured.Valid {
				continue
			}
			if place.FirstAt == "" {
				place.FirstAt = photo.captured.DayKey
			}
			place.LastAt = photo.captured.DayKey
		}
		places = append(places, place)
	}
	sort.Slice(places, func(i, j int) bool {
		if places[i].PhotoCount != places[j].PhotoCount {
			return places[i].PhotoCount > places[j].PhotoCount
		}
		return places[i].Adcode < places[j].Adcode
	})

	return ChinaPlaces{
		Revision:             snapshot.Revision(),
		BoundaryVersion:      chinaBoundaryVersion,
		Level:                level,
		Total:                len(places),
		GPSPhotoCount:        match.gpsPhotoCount,
		ChinaPhotoCount:      match.chinaPhotoCount,
		UnassignedPhotoCount: match.gpsPhotoCount - match.chinaPhotoCount,
		UntimedPhotoCount:    match.chinaPhotoCount - len(match.timedPhotos),
		Places:               places,
	}, nil
}

// chinaPlaceCoverIDs 挑代表照。
//
// 规则是确定的：按时间顺序取前几次到访的第一张，不够 4 张再用剩下的
// 照片按时间顺序补齐。这样拼贴出来的图同时代表时间与空间，而不是
// 四张同一天的照片；同一份库每次刷新拿到的也是同一批。
func chinaPlaceCoverIDs(photos []chinaRegionPhoto, visits []chinaVisit) []string {
	covers := make([]string, 0, chinaCoverCount)
	used := make(map[string]bool, len(photos))
	for _, visit := range visits {
		if len(covers) >= chinaCoverCount {
			break
		}
		for _, photo := range visit.photos {
			if used[photo.resourceID] {
				continue
			}
			used[photo.resourceID] = true
			covers = append(covers, photo.resourceID)
			break
		}
	}
	for _, photo := range photos {
		if len(covers) >= chinaCoverCount {
			break
		}
		if used[photo.resourceID] {
			continue
		}
		used[photo.resourceID] = true
		covers = append(covers, photo.resourceID)
	}
	return covers
}

// chinaCoverCount 是代表照的张数上限。
const chinaCoverCount = 4

// Trips 返回行程与停留。
//
// 切分口径与到访完全一致（相邻照片的日历日间隔超过 2 天就断开），
// 区别是粒度：到访比的是同一个地方，行程比的是「去了哪些地方」。
// 一段里只出现一个地方时它是「停留」，出现了多个地方才是「行程」。
func (s *ChinaLocationService) Trips(
	snapshot CatalogSnapshot,
	records []AIAnalysisRecord,
	recordsRevision uint64,
	validatePath func(string) (string, error),
	granularity string,
	timeRange ChinaTimeRange,
) (ChinaTrips, error) {
	if !IsChinaPlaceGranularity(granularity) {
		return ChinaTrips{}, fmt.Errorf("unknown trip granularity %q", granularity)
	}
	match, err := s.currentMatch(snapshot, records, recordsRevision, validatePath)
	if err != nil {
		return ChinaTrips{}, err
	}
	index, err := loadChinaAdminIndex()
	if err != nil {
		return ChinaTrips{}, err
	}
	scoped := match.scopedPhotos(match.timedPhotos, timeRange)
	segments := splitChinaVisits(scoped)
	trips := make([]ChinaTrip, 0, len(segments))
	for _, segment := range segments {
		stops := chinaTrajectoryStops(segment.photos, func(photo chinaRegionPhoto) int {
			return chinaPlaceKey(photo, granularity, index)
		}, index)
		if len(stops) == 0 {
			continue
		}
		kind := chinaTripKindStay
		if len(stops) > 1 {
			kind = chinaTripKindTrip
		}
		photoCount := 0
		for _, stop := range stops {
			photoCount += stop.count
		}
		trip := ChinaTrip{
			Id:               segment.startedAt.DayKey + "-" + fmt.Sprint(stops[0].adcode),
			Kind:             kind,
			StartedAt:        segment.startedAt.DayKey,
			EndedAt:          segment.endedAt.DayKey,
			DayCount:         segment.endedAt.dayIndex() - segment.startedAt.dayIndex() + 1,
			PhotoCount:       photoCount,
			Stops:            make([]ChinaTripStop, 0, len(stops)),
			CoverResourceIDs: make([]string, 0, chinaCoverCount),
		}
		for _, stop := range stops {
			trip.Stops = append(trip.Stops, ChinaTripStop{
				Adcode:     stop.adcode,
				Name:       stop.name,
				Level:      stop.level,
				At:         stop.first.DayKey,
				Until:      stop.last.DayKey,
				DayCount:   stop.last.dayIndex() - stop.first.dayIndex() + 1,
				PhotoCount: stop.count,
			})
			if len(trip.CoverResourceIDs) < chinaCoverCount && stop.coverID != "" {
				trip.CoverResourceIDs = append(trip.CoverResourceIDs, stop.coverID)
			}
		}
		trips = append(trips, trip)
	}
	sort.SliceStable(trips, func(i, j int) bool { return trips[i].StartedAt < trips[j].StartedAt })
	return ChinaTrips{
		Revision:          snapshot.Revision(),
		BoundaryVersion:   chinaBoundaryVersion,
		Granularity:       granularity,
		Total:             len(trips),
		Trips:             trips,
		UntimedPhotoCount: match.chinaPhotoCount - len(match.timedPhotos),
	}, nil
}

// 行程的两类：走过多个地方是行程，只在一个地方是停留。
const (
	chinaTripKindTrip = "trip"
	chinaTripKindStay = "stay"
)
