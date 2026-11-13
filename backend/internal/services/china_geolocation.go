package services

import (
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

//go:embed geodata/china-admin.geojson.gz
var chinaAdminArchive embed.FS

var (
	chinaAdminOnce sync.Once
	chinaAdmin     *chinaAdminIndex
	chinaAdminErr  error
)

// chinaBoundaryVersion 是内嵌边界数据的版本标识。
//
// 更换 geodata/china-admin.geojson.gz 时必须同步更新它：前端缓存与端点的
// ETag 都靠它判断边界数据是否换代。
const chinaBoundaryVersion = "areacity-2025.251231.260403"

type chinaAdminIndex struct {
	provinces []*chinaAdminFeature
	areas     []*chinaAdminFeature
	// byAdcode 按区划码索引全部要素，供按区域查询。
	byAdcode map[int]*chinaAdminFeature
	// childrenByParent 按上级区划码索引直属下级。
	// 省级下级可能是城市或省直辖区县；城市下级是区县。
	childrenByParent map[int][]*chinaAdminFeature
	// hash 是内嵌边界数据的内容指纹。换了文件就换指纹，
	// 端点的 ETag 随之改变，浏览器缓存自动失效。
	hash string
}

type chinaAdminFeature struct {
	adcode         int
	parentAdcode   int
	provinceAdcode int
	name           string
	level          string
	polygons       []chinaPolygon
	minX           float64
	minY           float64
	maxX           float64
	maxY           float64
}

type chinaPolygon struct {
	rings      [][]chinaPoint
	ringLatIdx []chinaRingLatitudeIndex
	minX       float64
	minY       float64
	maxX       float64
	maxY       float64
}

type chinaRingLatitudeIndex struct {
	firstBucket int
	buckets     [][]int
}

const chinaLatitudeBucketDegrees = 0.1

type chinaPoint struct {
	x int32
	y int32
}

type chinaCoordinate struct {
	x float64
	y float64
}

const chinaCoordinateScale = 1_000_000

type chinaAdminRawFeature struct {
	Properties struct {
		Adcode int    `json:"adcode"`
		Name   string `json:"name"`
		Level  string `json:"level"`
		Parent struct {
			Adcode int `json:"adcode"`
		} `json:"parent"`
	} `json:"properties"`
	Geometry json.RawMessage `json:"geometry"`
}

type chinaAdminGeometry struct {
	Type        string          `json:"type"`
	Coordinates json.RawMessage `json:"coordinates"`
}

const (
	chinaAdminProvinceLevel = "province"
	chinaAdminDistrictLevel = "district"
	chinaAdminCityLevel     = "city"
)

// chinaRegionPhoto 是一个落在某个行政区内的照片。
//
// 匹配阶段只保留资源 ID 与相册内序号，不保留路径：路径在出库时按当前
// 媒体根重新校验，资源 ID 不是授权凭据。
type chinaRegionPhoto struct {
	resourceID string
	albumID    string
	albumRank  int
	index      int
	// captured 是 EXIF 拍摄时间。相机记录的墙上时间，通常不含时区。
	captured chinaCaptureTime
	// provinceAdcode 是省级归属；regionAdcode 是下级区域归属，
	// 只匹配到省级时为 0。
	provinceAdcode int
	regionAdcode   int
	// longitude 与 latitude 是照片的位置，与边界同一坐标系（GCJ-02）。
	//
	// 匹配时算出来过，用完就丢；现在留住它是为了画点位。点位只以网格
	// 聚合下发，不还原到单张照片的坐标。
	longitude float64
	latitude  float64
}

// chinaCaptureTime 是按日历口径比较的拍摄时间。
//
// EXIF 的 DateTimeOriginal 通常不含时区，保留相机记录的墙上时间：
// 「拍摄地当地的那一天」正是轨迹叙事需要的口径 —— 晚上八点拍的那张
// 属于那一天，而不是某个绝对时刻。
type chinaCaptureTime struct {
	Year   int
	Month  int
	Day    int
	Hour   int
	Minute int
	Second int
	// YearMonth 是 "2024-06"，DayKey 是 "2024-06-24"。
	YearMonth string
	DayKey    string
	// Valid 表示这个时间可信。
	Valid bool
}

// before 判断 a 是否早于 b。只有可信的时间才比较。
func (a chinaCaptureTime) before(b chinaCaptureTime) bool {
	if a.Year != b.Year {
		return a.Year < b.Year
	}
	if a.Month != b.Month {
		return a.Month < b.Month
	}
	if a.Day != b.Day {
		return a.Day < b.Day
	}
	if a.Hour != b.Hour {
		return a.Hour < b.Hour
	}
	if a.Minute != b.Minute {
		return a.Minute < b.Minute
	}
	return a.Second < b.Second
}

// dayIndex 是这一天在日历上的序号，用来算两个日期隔了几天。
func (c chinaCaptureTime) dayIndex() int {
	return int(time.Date(c.Year, time.Month(c.Month), c.Day, 0, 0, 0, 0, time.UTC).Unix() / 86400)
}

// chinaCaptureMinYear 是可信拍摄时间的下限。数字照片早于这个年份的，
// 基本都是相机时钟没设对。
const chinaCaptureMinYear = 1990

// chinaCaptureTimeLayouts 是 EXIF 拍摄时间的两种写法：
// 不带时区的墙上时间，以及带偏移的 RFC3339。
var chinaCaptureTimeLayouts = []string{
	"2006-01-02T15:04:05.999999999",
	time.RFC3339Nano,
}

// parseChinaCaptureTime 解析 EXIF 拍摄时间。
//
// 解析不出来、年份早于 1990 或晚于当年的时间都算不可信：这类照片照常
// 计入空间统计，但不进时间轴与到访。
//
// 不拿文件修改时间来校验：照片常常是拷进库的，修改时间与拍摄时间差上
// 几个月是常事，拿它当基准会误杀大量正常照片。
func parseChinaCaptureTime(raw string) chinaCaptureTime {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return chinaCaptureTime{}
	}
	var parsed time.Time
	parsedOK := false
	for _, layout := range chinaCaptureTimeLayouts {
		value, err := time.Parse(layout, raw)
		if err == nil {
			parsed = value
			parsedOK = true
			break
		}
	}
	if !parsedOK {
		return chinaCaptureTime{}
	}
	if parsed.Year() < chinaCaptureMinYear || parsed.Year() > time.Now().Year()+1 {
		return chinaCaptureTime{}
	}
	return chinaCaptureTime{
		Year:      parsed.Year(),
		Month:     int(parsed.Month()),
		Day:       parsed.Day(),
		Hour:      parsed.Hour(),
		Minute:    parsed.Minute(),
		Second:    parsed.Second(),
		YearMonth: fmt.Sprintf("%04d-%02d", parsed.Year(), int(parsed.Month())),
		DayKey:    fmt.Sprintf("%04d-%02d-%02d", parsed.Year(), int(parsed.Month()), parsed.Day()),
		Valid:     true,
	}
}

// chinaLocationMatch 是一次匹配的结果：照片按行政区归位。
type chinaLocationMatch struct {
	gpsPhotoCount   int
	chinaPhotoCount int
	// provincePhotos 按省级区划码归集照片，按拍摄时间升序。
	provincePhotos map[int][]chinaRegionPhoto
	// regionPhotos 按下级区划码归集照片，按拍摄时间升序。
	regionPhotos map[int][]chinaRegionPhoto
	// timedPhotos 是全部有可信拍摄时间的照片，按时间升序。
	// 全国层级的月份分布与停靠序列从它算。
	timedPhotos []chinaRegionPhoto
}

// matchChinaLocations 在当前快照上重新校验照片版本，并将 GPS 坐标匹配到离线省级及下级边界。
func matchChinaLocations(
	snapshot CatalogSnapshot,
	records []AIAnalysisRecord,
	validatePath func(string) (string, error),
) (*chinaLocationMatch, error) {
	if !snapshot.Ready() || validatePath == nil {
		return nil, ErrLibraryNotReady
	}
	index, err := loadChinaAdminIndex()
	if err != nil {
		return nil, err
	}
	if snapshot.state == nil || snapshot.state.library == nil {
		return nil, ErrLibraryNotReady
	}

	albumRanks := make(map[string]int, len(snapshot.state.library.albums))
	for rank, album := range snapshot.state.library.albums {
		albumRanks[album.ID] = rank
	}
	match := &chinaLocationMatch{
		provincePhotos: make(map[int][]chinaRegionPhoto),
		regionPhotos:   make(map[int][]chinaRegionPhoto),
	}
	for _, record := range records {
		if record.Type != AIJobTypeMetadata || record.Status != MetadataParseParsed || len(record.Data) == 0 {
			continue
		}
		ref, ok := snapshot.Lookup(record.ResourceID)
		if !ok || ref.Kind != ResourceFile || !models.IsImageFile(ref.AbsolutePath) {
			continue
		}
		path, err := validatePath(ref.AbsolutePath)
		if err != nil {
			continue
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() != record.Size || info.ModTime().UnixNano() != record.MTimeNs {
			continue
		}
		fileRef, ok := snapshot.state.library.mediaByFile[record.ResourceID]
		if !ok {
			continue
		}
		album, ok := snapshot.state.library.nodes[fileRef.albumID]
		if !ok || album.ContentKind != string(models.ContentKindPhoto) {
			continue
		}
		media := snapshot.state.library.media[fileRef.albumID]
		if fileRef.index < 0 || fileRef.index >= len(media) || media[fileRef.index].Kind != "image" {
			continue
		}
		var metadata ImageMetadata
		if json.Unmarshal(record.Data, &metadata) != nil || metadata.GPS == nil || !validCoordinates(metadata.GPS.Latitude, metadata.GPS.Longitude) {
			continue
		}
		match.gpsPhotoCount++
		longitude, latitude, validDatum := coordinatesToChinaMap(metadata.GPS.Longitude, metadata.GPS.Latitude, metadata.GPS.MapDatum)
		if !validDatum {
			continue
		}
		province := matchingChinaFeature(index.provinces, longitude, latitude)
		if province == nil {
			continue
		}
		photo := chinaRegionPhoto{
			resourceID:     record.ResourceID,
			albumID:        fileRef.albumID,
			albumRank:      albumRanks[fileRef.albumID],
			index:          fileRef.index,
			captured:       parseChinaCaptureTime(metadata.DateTimeOriginal),
			provinceAdcode: province.adcode,
			longitude:      longitude,
			latitude:       latitude,
		}
		// 最深命中要在归集之前定下来：省里的照片也要带着它命中了哪个
		// 下级，否则「未细分」的数量与省级轨迹都算不出来。
		if area := deepestChinaFeature(index, province, longitude, latitude); area != nil {
			photo.regionAdcode = area.adcode
		}
		match.provincePhotos[province.adcode] = append(match.provincePhotos[province.adcode], photo)
		match.chinaPhotoCount++
		if photo.regionAdcode != 0 {
			for current := index.byAdcode[photo.regionAdcode]; current != nil && current.level != chinaAdminProvinceLevel; {
				match.regionPhotos[current.adcode] = append(match.regionPhotos[current.adcode], photo)
				parent, exists := index.byAdcode[current.parentAdcode]
				if !exists {
					break
				}
				current = parent
			}
		}
		if photo.captured.Valid {
			match.timedPhotos = append(match.timedPhotos, photo)
		}
	}
	// 照片按拍摄时间排列：时间轴、到访与轨迹都按这个顺序读。
	for _, photos := range match.provincePhotos {
		sortChinaRegionPhotos(photos)
	}
	for _, photos := range match.regionPhotos {
		sortChinaRegionPhotos(photos)
	}
	sortChinaRegionPhotos(match.timedPhotos)
	return match, nil
}

// sortChinaRegionPhotos 按拍摄时间排列；没有可信时间的排在末尾，
// 末尾内部仍按相册顺序，照片墙看起来依旧是「按相册分组」的。
func sortChinaRegionPhotos(photos []chinaRegionPhoto) {
	sort.SliceStable(photos, func(i, j int) bool {
		left, right := photos[i].captured, photos[j].captured
		if left.Valid != right.Valid {
			return left.Valid
		}
		if left.Valid {
			return left.before(right)
		}
		if photos[i].albumRank != photos[j].albumRank {
			return photos[i].albumRank < photos[j].albumRank
		}
		return photos[i].index < photos[j].index
	})
}

// sortChinaRegionPhotosByAlbum 按相册顺序与相册内序号排序。
func sortChinaRegionPhotosByAlbum(photos []chinaRegionPhoto) {
	sort.SliceStable(photos, func(i, j int) bool {
		if photos[i].albumRank != photos[j].albumRank {
			return photos[i].albumRank < photos[j].albumRank
		}
		return photos[i].index < photos[j].index
	})
}

// scopePhotosFor 返回某个区域下的照片：省级要素取省级归集，下级要素取
// 它自己的归集。
func (m *chinaLocationMatch) scopePhotosFor(feature *chinaAdminFeature) []chinaRegionPhoto {
	if m == nil || feature == nil {
		return nil
	}
	if feature.level == chinaAdminProvinceLevel {
		return m.provincePhotos[feature.adcode]
	}
	return m.regionPhotos[feature.adcode]
}

// timedPhotosInScope 返回某个区域下有可信拍摄时间的照片，按时间升序。
func (m *chinaLocationMatch) timedPhotosInScope(feature *chinaAdminFeature) []chinaRegionPhoto {
	if m == nil || feature == nil {
		return nil
	}
	scope := m.regionPhotos[feature.adcode]
	if feature.level == chinaAdminProvinceLevel {
		scope = m.provincePhotos[feature.adcode]
	}
	photos := make([]chinaRegionPhoto, 0, len(scope))
	for _, photo := range scope {
		if photo.captured.Valid {
			photos = append(photos, photo)
		}
	}
	return photos
}

// scopedPhotos 返回落在时间区间内的照片。
//
// 区间为空时原样返回：此时空间统计仍按全部照片算，只有时间轴与轨迹
// 受拍摄时间限制。有区间时只留下时间可信且落在区间里的照片。
func (m *chinaLocationMatch) scopedPhotos(photos []chinaRegionPhoto, timeRange ChinaTimeRange) []chinaRegionPhoto {
	if m == nil || timeRange.IsZero() {
		return photos
	}
	scoped := make([]chinaRegionPhoto, 0, len(photos))
	for _, photo := range photos {
		if timeRange.includes(photo.captured) {
			scoped = append(scoped, photo)
		}
	}
	return scoped
}

// untimedPhotoCount 返回没有可信拍摄时间的照片数。
func (m *chinaLocationMatch) untimedPhotoCount(photos []chinaRegionPhoto) int {
	if m == nil {
		return 0
	}
	count := 0
	for _, photo := range photos {
		if !photo.captured.Valid {
			count++
		}
	}
	return count
}

// PrewarmChinaBoundaries 在后台预热离线边界索引。
//
// 匹配索引有 797 万个坐标点，加载要 6 秒、常驻约 1.4GB。放着不管的话
// 第一个打开地点页的人要等这 6 秒。启动时先在后台加载，第一次请求就能
// 直接用上已经建好的索引。
func PrewarmChinaBoundaries() {
	go func() {
		if _, err := loadChinaAdminIndex(); err != nil {
			log.Printf("预热离线边界索引失败: %v", err)
			return
		}
		if _, err := loadChinaOutlineIndex(); err != nil {
			log.Printf("预热离线边界轮廓失败: %v", err)
		}
	}()
}

func loadChinaAdminIndex() (*chinaAdminIndex, error) {
	chinaAdminOnce.Do(func() {
		archiveFile, err := chinaAdminArchive.Open("geodata/china-admin.geojson.gz")
		if err != nil {
			chinaAdminErr = fmt.Errorf("read embedded China boundaries: %w", err)
			return
		}
		digest := sha256.New()
		if _, err := io.Copy(digest, archiveFile); err != nil {
			_ = archiveFile.Close()
			chinaAdminErr = fmt.Errorf("hash embedded China boundaries: %w", err)
			return
		}
		if err := archiveFile.Close(); err != nil {
			chinaAdminErr = fmt.Errorf("close embedded China boundaries: %w", err)
			return
		}
		boundaryHash := hex.EncodeToString(digest.Sum(nil)[:8])
		archiveFile, err = chinaAdminArchive.Open("geodata/china-admin.geojson.gz")
		if err != nil {
			chinaAdminErr = fmt.Errorf("reopen embedded China boundaries: %w", err)
			return
		}
		reader, err := gzip.NewReader(archiveFile)
		if err != nil {
			_ = archiveFile.Close()
			chinaAdminErr = fmt.Errorf("open embedded China boundaries: %w", err)
			return
		}
		defer reader.Close()
		defer archiveFile.Close()
		decoder := json.NewDecoder(reader)
		opening, err := decoder.Token()
		if err != nil || opening != json.Delim('{') {
			chinaAdminErr = errors.New("decode embedded China boundaries: invalid feature collection")
			return
		}
		index := &chinaAdminIndex{
			byAdcode:         make(map[int]*chinaAdminFeature),
			childrenByParent: make(map[int][]*chinaAdminFeature),
			hash:             boundaryHash,
		}
		featuresFound := false
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				chinaAdminErr = fmt.Errorf("decode embedded China boundaries: %w", err)
				return
			}
			key, ok := keyToken.(string)
			if !ok {
				chinaAdminErr = errors.New("decode embedded China boundaries: invalid collection key")
				return
			}
			if key != "features" {
				var ignored json.RawMessage
				if err := decoder.Decode(&ignored); err != nil {
					chinaAdminErr = fmt.Errorf("decode embedded China boundaries: %w", err)
					return
				}
				continue
			}
			featuresFound = true
			featuresToken, err := decoder.Token()
			if err != nil || featuresToken != json.Delim('[') {
				chinaAdminErr = errors.New("decode embedded China boundaries: invalid features list")
				return
			}
			for decoder.More() {
				var rawFeature chinaAdminRawFeature
				if err := decoder.Decode(&rawFeature); err != nil {
					chinaAdminErr = fmt.Errorf("decode embedded China boundary feature: %w", err)
					return
				}
				properties := rawFeature.Properties
				if properties.Adcode == 0 || strings.TrimSpace(properties.Name) == "" || len(rawFeature.Geometry) == 0 {
					chinaAdminErr = errors.New("embedded China boundaries contain an incomplete feature")
					return
				}
				feature, err := decodeChinaAdminFeature(rawFeature.Geometry, properties.Adcode, properties.Parent.Adcode, properties.Name, properties.Level)
				if err != nil {
					chinaAdminErr = err
					return
				}
				if _, exists := index.byAdcode[feature.adcode]; exists {
					chinaAdminErr = fmt.Errorf("embedded China boundaries contain duplicate adcode %d", feature.adcode)
					return
				}
				index.byAdcode[feature.adcode] = feature
				switch properties.Level {
				case chinaAdminProvinceLevel:
					index.provinces = append(index.provinces, feature)
				case chinaAdminCityLevel, chinaAdminDistrictLevel:
					index.areas = append(index.areas, feature)
				default:
					chinaAdminErr = fmt.Errorf("embedded China boundaries contain unknown level %q", properties.Level)
					return
				}
			}
			if _, err := decoder.Token(); err != nil {
				chinaAdminErr = fmt.Errorf("decode embedded China boundaries: %w", err)
				return
			}
		}
		if _, err := decoder.Token(); err != nil || !featuresFound {
			chinaAdminErr = errors.New("decode embedded China boundaries: missing features list")
			return
		}
		districts := 0
		for _, feature := range index.areas {
			if feature.level == chinaAdminDistrictLevel {
				districts++
			}
		}
		if len(index.provinces) != 34 || len(index.areas) < 3_000 || districts < 2_800 {
			chinaAdminErr = fmt.Errorf("embedded China boundaries are incomplete: provinces=%d areas=%d districts=%d", len(index.provinces), len(index.areas), districts)
			return
		}
		// 省级区划码的上级是全国，其余要素逐级向上找到省级，
		// 这样无论下级要素挂在市下面还是省下面，都归得到同一个省。
		for _, feature := range index.areas {
			if _, exists := index.byAdcode[feature.parentAdcode]; !exists {
				chinaAdminErr = fmt.Errorf("embedded China boundary %d has missing parent %d", feature.adcode, feature.parentAdcode)
				return
			}
			feature.provinceAdcode = feature.parentAdcode
			foundProvince := false
			for depth := 0; depth < 4; depth++ {
				parent, exists := index.byAdcode[feature.provinceAdcode]
				if !exists {
					break
				}
				if parent.level == chinaAdminProvinceLevel {
					foundProvince = true
					break
				}
				feature.provinceAdcode = parent.parentAdcode
			}
			if !foundProvince {
				chinaAdminErr = fmt.Errorf("embedded China boundary %d has no province ancestor", feature.adcode)
				return
			}
			index.childrenByParent[feature.parentAdcode] = append(index.childrenByParent[feature.parentAdcode], feature)
		}
		sort.Slice(index.provinces, func(i, j int) bool { return index.provinces[i].adcode < index.provinces[j].adcode })
		sort.Slice(index.areas, func(i, j int) bool {
			if index.areas[i].provinceAdcode != index.areas[j].provinceAdcode {
				return index.areas[i].provinceAdcode < index.areas[j].provinceAdcode
			}
			if index.areas[i].level != index.areas[j].level {
				return index.areas[i].level == chinaAdminDistrictLevel
			}
			return index.areas[i].adcode < index.areas[j].adcode
		})
		for _, features := range index.childrenByParent {
			sort.Slice(features, func(i, j int) bool {
				if features[i].level != features[j].level {
					return features[i].level == chinaAdminDistrictLevel
				}
				return features[i].adcode < features[j].adcode
			})
		}
		chinaAdmin = index
	})
	return chinaAdmin, chinaAdminErr
}

func decodeChinaAdminFeature(rawGeometry json.RawMessage, adcode, parentAdcode int, name, level string) (*chinaAdminFeature, error) {
	var geometry chinaAdminGeometry
	if err := json.Unmarshal(rawGeometry, &geometry); err != nil {
		return nil, fmt.Errorf("decode China boundary %d: %w", adcode, err)
	}
	var rawPolygons [][][][2]float64
	switch geometry.Type {
	case "Polygon":
		var rings [][][2]float64
		if err := json.Unmarshal(geometry.Coordinates, &rings); err != nil {
			return nil, fmt.Errorf("decode China polygon %d: %w", adcode, err)
		}
		rawPolygons = [][][][2]float64{rings}
	case "MultiPolygon":
		if err := json.Unmarshal(geometry.Coordinates, &rawPolygons); err != nil {
			return nil, fmt.Errorf("decode China multipolygon %d: %w", adcode, err)
		}
	default:
		return nil, fmt.Errorf("unsupported China boundary geometry %q for %d", geometry.Type, adcode)
	}
	feature := &chinaAdminFeature{
		adcode: adcode, parentAdcode: parentAdcode, name: name, level: level,
		minX: math.Inf(1), minY: math.Inf(1), maxX: math.Inf(-1), maxY: math.Inf(-1),
	}
	for _, rawRings := range rawPolygons {
		if len(rawRings) == 0 {
			continue
		}
		polygon := chinaPolygon{minX: math.Inf(1), minY: math.Inf(1), maxX: math.Inf(-1), maxY: math.Inf(-1)}
		for _, rawRing := range rawRings {
			ring := make([]chinaPoint, 0, len(rawRing))
			for _, coordinates := range rawRing {
				longitude, latitude := coordinates[0], coordinates[1]
				if math.IsNaN(longitude) || math.IsInf(longitude, 0) || math.IsNaN(latitude) || math.IsInf(latitude, 0) || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90 {
					return nil, fmt.Errorf("China boundary %d has invalid coordinates", adcode)
				}
				point := chinaPoint{
					x: int32(math.Round(longitude * chinaCoordinateScale)),
					y: int32(math.Round(latitude * chinaCoordinateScale)),
				}
				ring = append(ring, point)
				polygon.minX = math.Min(polygon.minX, longitude)
				polygon.maxX = math.Max(polygon.maxX, longitude)
				polygon.minY = math.Min(polygon.minY, latitude)
				polygon.maxY = math.Max(polygon.maxY, latitude)
			}
			if len(ring) >= 3 {
				polygon.rings = append(polygon.rings, ring)
				polygon.ringLatIdx = append(polygon.ringLatIdx, buildChinaRingLatitudeIndex(ring))
			}
		}
		if len(polygon.rings) == 0 {
			continue
		}
		feature.polygons = append(feature.polygons, polygon)
		feature.minX = math.Min(feature.minX, polygon.minX)
		feature.maxX = math.Max(feature.maxX, polygon.maxX)
		feature.minY = math.Min(feature.minY, polygon.minY)
		feature.maxY = math.Max(feature.maxY, polygon.maxY)
	}
	if len(feature.polygons) == 0 {
		return nil, errors.New("China boundary has no valid polygons")
	}
	return feature, nil
}

func matchingChinaFeature(features []*chinaAdminFeature, longitude, latitude float64) *chinaAdminFeature {
	point := chinaCoordinate{x: longitude, y: latitude}
	for _, feature := range features {
		if point.x < feature.minX || point.x > feature.maxX || point.y < feature.minY || point.y > feature.maxY {
			continue
		}
		for _, polygon := range feature.polygons {
			if point.x < polygon.minX || point.x > polygon.maxX || point.y < polygon.minY || point.y > polygon.maxY {
				continue
			}
			if pointInChinaPolygon(point, polygon) {
				return feature
			}
		}
	}
	return nil
}

func deepestChinaFeature(index *chinaAdminIndex, parent *chinaAdminFeature, longitude, latitude float64) *chinaAdminFeature {
	if index == nil || parent == nil {
		return nil
	}
	var matched *chinaAdminFeature
	current := parent
	for depth := 0; depth < 3; depth++ {
		child := matchingChinaFeature(index.childrenByParent[current.adcode], longitude, latitude)
		if child == nil {
			break
		}
		matched = child
		current = child
	}
	return matched
}

func chinaRegionAtScope(photo chinaRegionPhoto, scope *chinaAdminFeature, index *chinaAdminIndex) int {
	if scope == nil || index == nil || photo.regionAdcode == 0 {
		return 0
	}
	current, exists := index.byAdcode[photo.regionAdcode]
	for depth := 0; exists && depth < 4; depth++ {
		if current.adcode == scope.adcode {
			return 0
		}
		if current.parentAdcode == scope.adcode {
			return current.adcode
		}
		current, exists = index.byAdcode[current.parentAdcode]
	}
	return 0
}

func pointInChinaPolygon(point chinaCoordinate, polygon chinaPolygon) bool {
	if len(polygon.rings) == 0 || !pointInChinaRing(point, polygon.rings[0], polygon.ringLatIdx[0]) {
		return false
	}
	for i, hole := range polygon.rings[1:] {
		if pointInChinaRing(point, hole, polygon.ringLatIdx[i+1]) {
			return false
		}
	}
	return true
}

func buildChinaRingLatitudeIndex(ring []chinaPoint) chinaRingLatitudeIndex {
	if len(ring) == 0 {
		return chinaRingLatitudeIndex{}
	}
	minimum := math.Inf(1)
	maximum := math.Inf(-1)
	for _, point := range ring {
		latitude := float64(point.y) / chinaCoordinateScale
		minimum = math.Min(minimum, latitude)
		maximum = math.Max(maximum, latitude)
	}
	firstBucket := int(math.Floor(minimum / chinaLatitudeBucketDegrees))
	lastBucket := int(math.Floor(maximum / chinaLatitudeBucketDegrees))
	index := chinaRingLatitudeIndex{
		firstBucket: firstBucket,
		buckets:     make([][]int, lastBucket-firstBucket+1),
	}
	for edgeIndex, point := range ring {
		previous := ring[(edgeIndex+len(ring)-1)%len(ring)]
		previousLatitude := float64(previous.y) / chinaCoordinateScale
		latitude := float64(point.y) / chinaCoordinateScale
		low := math.Min(previousLatitude, latitude)
		high := math.Max(previousLatitude, latitude)
		first := int(math.Floor(low / chinaLatitudeBucketDegrees))
		last := int(math.Floor(high / chinaLatitudeBucketDegrees))
		for bucket := first; bucket <= last; bucket++ {
			index.buckets[bucket-firstBucket] = append(index.buckets[bucket-firstBucket], edgeIndex)
		}
	}
	return index
}

func (index chinaRingLatitudeIndex) edgesAt(latitude float64) []int {
	bucket := int(math.Floor(latitude/chinaLatitudeBucketDegrees)) - index.firstBucket
	if bucket < 0 || bucket >= len(index.buckets) {
		return nil
	}
	return index.buckets[bucket]
}

func pointInChinaRing(point chinaCoordinate, ring []chinaPoint, index chinaRingLatitudeIndex) bool {
	inside := false
	edges := index.edgesAt(point.y)
	if len(edges) == 0 {
		return false
	}
	for _, edgeIndex := range edges {
		previousIndex := edgeIndex - 1
		if previousIndex < 0 {
			previousIndex = len(ring) - 1
		}
		a, b := ring[previousIndex], ring[edgeIndex]
		ax := float64(a.x) / chinaCoordinateScale
		ay := float64(a.y) / chinaCoordinateScale
		bx := float64(b.x) / chinaCoordinateScale
		by := float64(b.y) / chinaCoordinateScale
		cross := (point.x-ax)*(by-ay) - (point.y-ay)*(bx-ax)
		if math.Abs(cross) < 1e-9 && point.x >= math.Min(ax, bx)-1e-9 && point.x <= math.Max(ax, bx)+1e-9 && point.y >= math.Min(ay, by)-1e-9 && point.y <= math.Max(ay, by)+1e-9 {
			return true
		}
		if (ay > point.y) != (by > point.y) && point.x < (bx-ax)*(point.y-ay)/(by-ay)+ax {
			inside = !inside
		}
	}
	return inside
}

func coordinatesToChinaMap(longitude, latitude float64, datum string) (float64, float64, bool) {
	switch strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(datum), " ", "")) {
	case "", "WGS84", "WGS-84", "WGS_84":
		longitude, latitude = wgs84ToGCJ02(longitude, latitude)
	case "GCJ02", "GCJ-02", "GCJ_02":
	default:
		return 0, 0, false
	}
	return longitude, latitude, true
}

func wgs84ToGCJ02(longitude, latitude float64) (float64, float64) {
	if longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271 {
		return longitude, latitude
	}
	const earthAxis = 6378245.0
	const eccentricity = 0.00669342162296594323
	x, y := longitude-105.0, latitude-35.0
	dLatitude := chinaTransformLatitude(x, y)
	dLongitude := chinaTransformLongitude(x, y)
	radians := latitude * math.Pi / 180.0
	sinLatitude := math.Sin(radians)
	magic := 1 - eccentricity*sinLatitude*sinLatitude
	sqrtMagic := math.Sqrt(magic)
	dLatitude = dLatitude * 180.0 / ((earthAxis * (1 - eccentricity)) / (magic * sqrtMagic) * math.Pi)
	dLongitude = dLongitude * 180.0 / (earthAxis / sqrtMagic * math.Cos(radians) * math.Pi)
	return longitude + dLongitude, latitude + dLatitude
}

func chinaTransformLatitude(x, y float64) float64 {
	value := -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*math.Sqrt(math.Abs(x))
	value += (20*math.Sin(6*x*math.Pi) + 20*math.Sin(2*x*math.Pi)) * 2 / 3
	value += (20*math.Sin(y*math.Pi) + 40*math.Sin(y/3*math.Pi)) * 2 / 3
	value += (160*math.Sin(y/12*math.Pi) + 320*math.Sin(y*math.Pi/30)) * 2 / 3
	return value
}

func chinaTransformLongitude(x, y float64) float64 {
	value := 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*math.Sqrt(math.Abs(x))
	value += (20*math.Sin(6*x*math.Pi) + 20*math.Sin(2*x*math.Pi)) * 2 / 3
	value += (20*math.Sin(x*math.Pi) + 40*math.Sin(x/3*math.Pi)) * 2 / 3
	value += (150*math.Sin(x/12*math.Pi) + 300*math.Sin(x/30*math.Pi)) * 2 / 3
	return value
}
