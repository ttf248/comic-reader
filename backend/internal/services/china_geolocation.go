package services

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"sync"

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
const chinaBoundaryVersion = "datav-areas_v3-2021.5"

type chinaAdminIndex struct {
	provinces []*chinaAdminFeature
	areas     []*chinaAdminFeature
	// byAdcode 按区划码索引全部要素，供按区域查询。
	byAdcode map[int]*chinaAdminFeature
	// childrenByParent 按上级区划码索引直属下级。
	// 省级要素的下级是地级市；直辖市与特别行政区的下级是区县。
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
	geometry       json.RawMessage
	polygons       []chinaPolygon
	minX           float64
	minY           float64
	maxX           float64
	maxY           float64
}

type chinaPolygon struct {
	rings [][]chinaPoint
	minX  float64
	minY  float64
	maxX  float64
	maxY  float64
}

type chinaPoint struct {
	x float64
	y float64
}

type chinaAdminCollection struct {
	Features []struct {
		Properties struct {
			Adcode int    `json:"adcode"`
			Name   string `json:"name"`
			Level  string `json:"level"`
			Parent struct {
				Adcode int `json:"adcode"`
			} `json:"parent"`
		} `json:"properties"`
		Geometry json.RawMessage `json:"geometry"`
	} `json:"features"`
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
}

// chinaLocationMatch 是一次匹配的结果：照片按行政区归位。
type chinaLocationMatch struct {
	gpsPhotoCount   int
	chinaPhotoCount int
	// provincePhotos 按省级区划码归集照片。
	provincePhotos map[int][]chinaRegionPhoto
	// regionPhotos 按下级区划码归集照片。
	regionPhotos map[int][]chinaRegionPhoto
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
			resourceID: record.ResourceID,
			albumID:    fileRef.albumID,
			albumRank:  albumRanks[fileRef.albumID],
			index:      fileRef.index,
		}
		match.provincePhotos[province.adcode] = append(match.provincePhotos[province.adcode], photo)
		match.chinaPhotoCount++
		area := matchingChinaFeature(index.childrenByParent[province.adcode], longitude, latitude)
		if area == nil {
			continue
		}
		match.regionPhotos[area.adcode] = append(match.regionPhotos[area.adcode], photo)
	}
	// 照片按相册顺序与相册内序号排列，照片墙看起来才是「按相册分组」的。
	for _, photos := range match.provincePhotos {
		sortChinaRegionPhotos(photos)
	}
	for _, photos := range match.regionPhotos {
		sortChinaRegionPhotos(photos)
	}
	return match, nil
}

// sortChinaRegionPhotos 按相册顺序与相册内序号排序。
func sortChinaRegionPhotos(photos []chinaRegionPhoto) {
	sort.SliceStable(photos, func(i, j int) bool {
		if photos[i].albumRank != photos[j].albumRank {
			return photos[i].albumRank < photos[j].albumRank
		}
		return photos[i].index < photos[j].index
	})
}

// regionPhotoCount 返回某个区划下的照片数。
func (m *chinaLocationMatch) regionPhotoCount(adcode int) int {
	if m == nil {
		return 0
	}
	return len(m.regionPhotos[adcode])
}

// provincePhotoCount 返回某个省份下的照片数。
func (m *chinaLocationMatch) provincePhotoCount(adcode int) int {
	if m == nil {
		return 0
	}
	return len(m.provincePhotos[adcode])
}

func loadChinaAdminIndex() (*chinaAdminIndex, error) {
	chinaAdminOnce.Do(func() {
		archive, err := chinaAdminArchive.ReadFile("geodata/china-admin.geojson.gz")
		if err != nil {
			chinaAdminErr = fmt.Errorf("read embedded China boundaries: %w", err)
			return
		}
		digest := sha256.Sum256(archive)
		boundaryHash := hex.EncodeToString(digest[:8])
		reader, err := gzip.NewReader(bytes.NewReader(archive))
		if err != nil {
			chinaAdminErr = fmt.Errorf("open embedded China boundaries: %w", err)
			return
		}
		defer reader.Close()
		var collection chinaAdminCollection
		if err := json.NewDecoder(reader).Decode(&collection); err != nil {
			chinaAdminErr = fmt.Errorf("decode embedded China boundaries: %w", err)
			return
		}
		index := &chinaAdminIndex{
			byAdcode:         make(map[int]*chinaAdminFeature),
			childrenByParent: make(map[int][]*chinaAdminFeature),
			hash:             boundaryHash,
		}
		for _, rawFeature := range collection.Features {
			properties := rawFeature.Properties
			if properties.Adcode == 0 || strings.TrimSpace(properties.Name) == "" || len(rawFeature.Geometry) == 0 {
				continue
			}
			feature, err := decodeChinaAdminFeature(rawFeature.Geometry, properties.Adcode, properties.Parent.Adcode, properties.Name, properties.Level)
			if err != nil {
				chinaAdminErr = err
				return
			}
			index.byAdcode[feature.adcode] = feature
			switch properties.Level {
			case chinaAdminProvinceLevel:
				index.provinces = append(index.provinces, feature)
			case chinaAdminCityLevel, chinaAdminDistrictLevel:
				index.areas = append(index.areas, feature)
			}
		}
		if len(index.provinces) != 34 || len(index.areas) < 400 {
			chinaAdminErr = fmt.Errorf("embedded China boundaries are incomplete: provinces=%d areas=%d", len(index.provinces), len(index.areas))
			return
		}
		// 省级区划码的上级是全国，其余要素逐级向上找到省级，
		// 这样无论下级要素挂在市下面还是省下面，都归得到同一个省。
		for _, feature := range index.areas {
			feature.provinceAdcode = feature.parentAdcode
			for depth := 0; depth < 4; depth++ {
				parent, exists := index.byAdcode[feature.provinceAdcode]
				if !exists || parent.level == chinaAdminProvinceLevel {
					break
				}
				feature.provinceAdcode = parent.parentAdcode
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
		geometry: append(json.RawMessage(nil), rawGeometry...),
		minX:     math.Inf(1), minY: math.Inf(1), maxX: math.Inf(-1), maxY: math.Inf(-1),
	}
	for _, rawRings := range rawPolygons {
		if len(rawRings) == 0 {
			continue
		}
		polygon := chinaPolygon{minX: math.Inf(1), minY: math.Inf(1), maxX: math.Inf(-1), maxY: math.Inf(-1)}
		for _, rawRing := range rawRings {
			ring := make([]chinaPoint, 0, len(rawRing))
			for _, coordinates := range rawRing {
				point := chinaPoint{x: coordinates[0], y: coordinates[1]}
				ring = append(ring, point)
				polygon.minX = math.Min(polygon.minX, point.x)
				polygon.maxX = math.Max(polygon.maxX, point.x)
				polygon.minY = math.Min(polygon.minY, point.y)
				polygon.maxY = math.Max(polygon.maxY, point.y)
			}
			if len(ring) >= 3 {
				polygon.rings = append(polygon.rings, ring)
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
	point := chinaPoint{x: longitude, y: latitude}
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

func pointInChinaPolygon(point chinaPoint, polygon chinaPolygon) bool {
	if len(polygon.rings) == 0 || !pointInChinaRing(point, polygon.rings[0]) {
		return false
	}
	for _, hole := range polygon.rings[1:] {
		if pointInChinaRing(point, hole) {
			return false
		}
	}
	return true
}

func pointInChinaRing(point chinaPoint, ring []chinaPoint) bool {
	inside := false
	for i, j := 0, len(ring)-1; i < len(ring); j, i = i, i+1 {
		a, b := ring[j], ring[i]
		cross := (point.x-a.x)*(b.y-a.y) - (point.y-a.y)*(b.x-a.x)
		if math.Abs(cross) < 1e-9 && point.x >= math.Min(a.x, b.x)-1e-9 && point.x <= math.Max(a.x, b.x)+1e-9 && point.y >= math.Min(a.y, b.y)-1e-9 && point.y <= math.Max(a.y, b.y)+1e-9 {
			return true
		}
		if (a.y > point.y) != (b.y > point.y) && point.x < (b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x {
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
