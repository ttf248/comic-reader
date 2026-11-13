package services

import (
	"math"
	"sort"
)

// ChinaPointCell 是一个网格里的照片聚合。
//
// 一格是一段约 1 公里到 50 公里的范围：格里的照片可能横跨一条街，也
// 可能是一整个景区。响应里只有「这一格在哪儿、有多少张照片」，没有单张
// 照片的坐标 —— 坐标是匹配阶段算出来的中间量，不是对外的数据。
type ChinaPointCell struct {
	// Longitude 与 Latitude 是格心的经纬度（GCJ-02）。
	Longitude float64 `json:"lon"`
	Latitude  float64 `json:"lat"`
	// Count 是这一格里的照片数。
	Count int `json:"count"`
	// Untimed 是其中没有可信拍摄时间的张数。
	Untimed int `json:"untimed"`
	// FirstAt 与 LastAt 是这一格里有可信拍摄时间的照片的首末日期，
	// 这一格全是没时间的照片时是空串。
	FirstAt string `json:"firstAt"`
	LastAt  string `json:"lastAt"`
}

// ChinaPoints 是点位聚合的响应。
type ChinaPoints struct {
	Revision uint64 `json:"revision"`
	// Cell 是实际生效的格边长（度）。
	//
	// 请求给的是最小值，格数超上限时服务端会调粗；前端拿这个值画点，
	// 不用自己再合并。
	Cell float64 `json:"cell"`
	// Total 是落进这些格子的照片总数。
	Total int `json:"total"`
	// Cells 是网格数。
	Cells int `json:"cells"`
	// Items 是网格本身，按张数降序。
	Items []ChinaPointCell `json:"items"`
}

const (
	// ChinaPointDefaultCell 是缺省的格边长（度，约 2 km）。
	ChinaPointDefaultCell = 0.02
	// chinaPointMaxCells 是一次响应里最多给多少个网格。
	//
	// 大库如果按最细的格子铺，几万张照片会摊出几万个点，浏览器画不动
	// 也看不完。超了就调粗格子。
	chinaPointMaxCells = 4000
)

// chinaPointCells 是允许的格边长（度）。
//
// 只认这几档：格边长是「画多细」的档位，不是一个连续的参数。白名单让
// 前端能按缩放级别挑档，也让「最细的一档是多少」有确定的答案 ——
// 0.01 度约 1.1 公里，这是点位对外给出的最细粒度。
var chinaPointCells = []float64{0.01, 0.02, 0.05, 0.1, 0.2, 0.5}

// IsChinaPointCell 判断格边长是不是允许的一档。
func IsChinaPointCell(cell float64) bool {
	for _, candidate := range chinaPointCells {
		if candidate == cell {
			return true
		}
	}
	return false
}

// chinaPointCellKey 是一个网格的键。
type chinaPointCellKey struct {
	column int
	row    int
}

// chinaPointAggregate 是聚合过程中的可变状态。
type chinaPointAggregate struct {
	longitude float64
	latitude  float64
	count     int
	untimed   int
	firstAt   string
	lastAt    string
}

// Points 返回照片位置的网格聚合。
//
// 它给的是「照片具体在哪儿」：行政区匹配只知道落在哪个省、市、区县，
// 点位才画得出城市的样子。坐标只以网格聚合下发，不还原到单张照片。
func (s *ChinaLocationService) Points(
	snapshot CatalogSnapshot,
	records []AIAnalysisRecord,
	recordsRevision uint64,
	validatePath func(string) (string, error),
	timeRange ChinaTimeRange,
	cell float64,
) (ChinaPoints, error) {
	match, err := s.currentMatch(snapshot, records, recordsRevision, validatePath)
	if err != nil {
		return ChinaPoints{}, err
	}
	if !IsChinaPointCell(cell) {
		cell = ChinaPointDefaultCell
	}
	aggregates, total := aggregateChinaPoints(match, timeRange, cell)
	// 格子太细就调粗：调粗之后点少了，密度读起来反而更清楚。
	for len(aggregates) > chinaPointMaxCells {
		next := nextChinaPointCell(cell)
		if next <= cell {
			break
		}
		cell = next
		aggregates, _ = aggregateChinaPoints(match, timeRange, cell)
	}
	items := make([]ChinaPointCell, 0, len(aggregates))
	for _, aggregate := range aggregates {
		items = append(items, ChinaPointCell{
			Longitude: aggregate.longitude,
			Latitude:  aggregate.latitude,
			Count:     aggregate.count,
			Untimed:   aggregate.untimed,
			FirstAt:   aggregate.firstAt,
			LastAt:    aggregate.lastAt,
		})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Count != items[j].Count {
			return items[i].Count > items[j].Count
		}
		if items[i].Longitude != items[j].Longitude {
			return items[i].Longitude < items[j].Longitude
		}
		return items[i].Latitude < items[j].Latitude
	})
	return ChinaPoints{
		Revision: snapshot.Revision(),
		Cell:     cell,
		Total:    total,
		Cells:    len(items),
		Items:    items,
	}, nil
}

// aggregateChinaPoints 按给定的格边长聚合照片位置。
//
// 数据源是 provincePhotos —— 它收录每一张有位置的照片，包括没有可信
// 拍摄时间的那些（timedPhotos 只收有时间的，用它会漏掉一整类照片）。
func aggregateChinaPoints(
	match *chinaLocationMatch,
	timeRange ChinaTimeRange,
	cell float64,
) (map[chinaPointCellKey]*chinaPointAggregate, int) {
	aggregates := map[chinaPointCellKey]*chinaPointAggregate{}
	total := 0
	for _, photos := range match.provincePhotos {
		for _, photo := range photos {
			if !chinaPointInRange(photo, timeRange) {
				continue
			}
			total++
			key := chinaPointKeyOf(photo.longitude, photo.latitude, cell)
			aggregate, exists := aggregates[key]
			if !exists {
				aggregate = &chinaPointAggregate{
					longitude: chinaPointCellCenter(key, cell, true),
					latitude:  chinaPointCellCenter(key, cell, false),
				}
				aggregates[key] = aggregate
			}
			aggregate.count++
			if !photo.captured.Valid {
				aggregate.untimed++
				continue
			}
			if aggregate.firstAt == "" || photo.captured.DayKey < aggregate.firstAt {
				aggregate.firstAt = photo.captured.DayKey
			}
			if aggregate.lastAt == "" || photo.captured.DayKey > aggregate.lastAt {
				aggregate.lastAt = photo.captured.DayKey
			}
		}
	}
	return aggregates, total
}

// nextChinaPointCell 给出更粗的一档格边长。
func nextChinaPointCell(cell float64) float64 {
	for _, candidate := range chinaPointCells {
		if candidate > cell {
			return candidate
		}
	}
	return cell
}

// chinaPointInRange 判断一张照片是否落在请求的时间区间里。
//
// 没有可信拍摄时间的照片一律保留：它们有真实位置，只是没法判断在不在
// 区间里。若一并丢掉，一张没设时钟的照片就会让整张地图空掉。
func chinaPointInRange(photo chinaRegionPhoto, timeRange ChinaTimeRange) bool {
	if !photo.captured.Valid {
		return true
	}
	if timeRange.From != "" && photo.captured.YearMonth < timeRange.From {
		return false
	}
	if timeRange.To != "" && photo.captured.YearMonth > timeRange.To {
		return false
	}
	return true
}

// chinaPointKeyOf 算出坐标落在哪一格。
func chinaPointKeyOf(longitude, latitude, cell float64) chinaPointCellKey {
	return chinaPointCellKey{
		column: int(math.Floor(longitude / cell)),
		row:    int(math.Floor(latitude / cell)),
	}
}

// chinaPointCellCenter 给出格心的经度或纬度。
func chinaPointCellCenter(key chinaPointCellKey, cell float64, longitude bool) float64 {
	if longitude {
		return (float64(key.column) + 0.5) * cell
	}
	return (float64(key.row) + 0.5) * cell
}
