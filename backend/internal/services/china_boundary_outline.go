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
	"sort"
	"sync"
)

// chinaOutlineArchive 是绘图用的简化边界数据。
//
// 它与匹配用的 china-admin.geojson.gz 是同一份数据的两种形态：
// 匹配要全精度（点位判定必须落在真实边界内），绘图只要形状。
// 两者必须分开 —— 简化过的边界不能拿去匹配，反过来全精度的边界
// 不该下发给浏览器（那是 18MB 的 JSON）。
//
//go:embed geodata/china-admin-outline.geojson.gz
var chinaOutlineArchive embed.FS

// chinaOutlineVersion 是绘图轮廓的版本标识。
//
// 与 chinaBoundaryVersion 分开维护：匹配数据与绘图数据可以各自独立
// 更新，客户端也据此分别缓存两类响应。
const chinaOutlineVersion = "areacity-2025.251231.260403-outline1"

// chinaOutlineIndex 是绘图轮廓的内存索引。
type chinaOutlineIndex struct {
	features         []*chinaOutlineFeature
	byAdcode         map[int]*chinaOutlineFeature
	childrenByParent map[int][]*chinaOutlineFeature
	provinces        []*chinaOutlineFeature
	// hash 是内容指纹，参与绘图端点的 ETag。
	hash string
}

// chinaOutlineFeature 是一个可绘制的行政区轮廓。
type chinaOutlineFeature struct {
	adcode       int
	name         string
	level        string
	parentAdcode int
	geometry     json.RawMessage
}

var (
	chineseOutlineOnce sync.Once
	chineseOutline     *chinaOutlineIndex
	chineseOutlineErr  error
)

// ChinaOutlineFeature 是对外的绘图要素。
type ChinaOutlineFeature struct {
	Adcode   int             `json:"adcode"`
	Name     string          `json:"name"`
	Level    string          `json:"level"`
	Geometry json.RawMessage `json:"geometry"`
}

// ChinaOutlineBoundaryHash 返回绘图轮廓的内容指纹。
func ChinaOutlineBoundaryHash() string {
	index, err := loadChinaOutlineIndex()
	if err != nil {
		return ""
	}
	return index.hash
}

// ChinaOutlineVersion 返回绘图轮廓的版本标识。
func ChinaOutlineVersion() string {
	return chinaOutlineVersion
}

// ChinaOutline 返回某一层级、某个上级之下的绘图轮廓。
//
// parentAdcode 为 0 且 level 是 province 时取全部省；level 是 children
// 时取 parent 的全部直接下级（不拘层级 —— 河南、湖北、海南、新疆的
// 省下面同时挂着市与省直辖县级区域）。
// 响应只含当前视图需要的层级 —— 整份轮廓不下发。
func ChinaOutline(level string, parentAdcode int) ([]ChinaOutlineFeature, string, error) {
	index, err := loadChinaOutlineIndex()
	if err != nil {
		return nil, "", err
	}
	var sources []*chinaOutlineFeature
	switch {
	case level == chinaOutlineChildrenLevel:
		if parentAdcode == 0 {
			for _, feature := range index.provinces {
				sources = append(sources, feature)
			}
			break
		}
		if _, exists := index.byAdcode[parentAdcode]; !exists {
			return nil, "", ErrChinaRegionNotFound
		}
		for _, feature := range index.childrenByParent[parentAdcode] {
			sources = append(sources, feature)
		}
	case isChinaAdminLevel(level):
		if parentAdcode == 0 {
			for _, feature := range index.features {
				if feature.level == level {
					sources = append(sources, feature)
				}
			}
			break
		}
		if _, exists := index.byAdcode[parentAdcode]; !exists {
			return nil, "", ErrChinaRegionNotFound
		}
		for _, feature := range index.childrenByParent[parentAdcode] {
			if feature.level == level {
				sources = append(sources, feature)
			}
		}
	default:
		return nil, "", fmt.Errorf("unknown boundary level %q", level)
	}
	features := make([]ChinaOutlineFeature, 0, len(sources))
	for _, source := range sources {
		features = append(features, ChinaOutlineFeature{
			Adcode:   source.adcode,
			Name:     source.name,
			Level:    source.level,
			Geometry: source.geometry,
		})
	}
	return features, index.hash, nil
}

// chinaOutlineChildrenLevel 表示「取上级的全部直接下级」，不拘层级。
const chinaOutlineChildrenLevel = "children"

// ChinaOutlineFeatures 按区划码取出绘图轮廓。
//
// 轮廓端点原本只按层级与上级取（某省下面的市），前端要画「去过的那些
// 地方自己的形状」时，得先知道每个地方的父级是谁 —— 而这个父级在前端
// 推不出来：直辖市的区县没有市一级，省直辖县级市在市级粒度里会卷到省。
// 直接按区划码取就没有这层推导。
//
// 查不到的区划码跳过而不是报错：台湾的区县本来就没有可用边界。
func ChinaOutlineFeatures(adcodes []int) ([]ChinaOutlineFeature, string, error) {
	index, err := loadChinaOutlineIndex()
	if err != nil {
		return nil, "", err
	}
	features := make([]ChinaOutlineFeature, 0, len(adcodes))
	seen := make(map[int]struct{}, len(adcodes))
	for _, adcode := range adcodes {
		if adcode <= 0 {
			continue
		}
		if _, exists := seen[adcode]; exists {
			continue
		}
		seen[adcode] = struct{}{}
		source, exists := index.byAdcode[adcode]
		if !exists {
			continue
		}
		features = append(features, ChinaOutlineFeature{
			Adcode:   source.adcode,
			Name:     source.name,
			Level:    source.level,
			Geometry: source.geometry,
		})
	}
	sort.Slice(features, func(i, j int) bool { return features[i].Adcode < features[j].Adcode })
	return features, index.hash, nil
}

// isChinaAdminLevel 判断是不是边界数据里的层级。
func isChinaAdminLevel(level string) bool {
	switch level {
	case chinaAdminProvinceLevel, chinaAdminCityLevel, chinaAdminDistrictLevel:
		return true
	default:
		return false
	}
}

// loadChinaOutlineIndex 加载并索引绘图轮廓。
//
// 轮廓比匹配数据小两个数量级（77 万个点对 797 万个点），解析在
// 0.6 秒以内，可以整份常驻。这里不做与匹配索引的交叉校验 ——
// 那会把 6 秒的匹配索引加载拖进绘图端点；两者的区划码一致性由
// 测试守住。
func loadChinaOutlineIndex() (*chinaOutlineIndex, error) {
	chineseOutlineOnce.Do(func() {
		chineseOutline, chineseOutlineErr = readChinaOutlineIndex()
	})
	return chineseOutline, chineseOutlineErr
}

func readChinaOutlineIndex() (*chinaOutlineIndex, error) {
	archiveFile, err := chinaOutlineArchive.Open("geodata/china-admin-outline.geojson.gz")
	if err != nil {
		return nil, fmt.Errorf("read embedded China outline: %w", err)
	}
	digest := sha256.New()
	if _, err := io.Copy(digest, archiveFile); err != nil {
		archiveFile.Close()
		return nil, fmt.Errorf("hash embedded China outline: %w", err)
	}
	if err := archiveFile.Close(); err != nil {
		return nil, fmt.Errorf("close embedded China outline: %w", err)
	}
	archiveFile, err = chinaOutlineArchive.Open("geodata/china-admin-outline.geojson.gz")
	if err != nil {
		return nil, fmt.Errorf("reopen embedded China outline: %w", err)
	}
	defer archiveFile.Close()
	reader, err := gzip.NewReader(archiveFile)
	if err != nil {
		return nil, fmt.Errorf("open embedded China outline: %w", err)
	}
	defer reader.Close()

	decoder := json.NewDecoder(reader)
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return nil, errors.New("decode embedded China outline: invalid feature collection")
	}
	index := &chinaOutlineIndex{
		byAdcode:         make(map[int]*chinaOutlineFeature),
		childrenByParent: make(map[int][]*chinaOutlineFeature),
		hash:             hex.EncodeToString(digest.Sum(nil)[:8]),
	}
	found := false
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, fmt.Errorf("decode embedded China outline: %w", err)
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, errors.New("decode embedded China outline: invalid collection key")
		}
		if key != "features" {
			var ignored json.RawMessage
			if err := decoder.Decode(&ignored); err != nil {
				return nil, fmt.Errorf("decode embedded China outline: %w", err)
			}
			continue
		}
		found = true
		featuresToken, err := decoder.Token()
		if err != nil || featuresToken != json.Delim('[') {
			return nil, errors.New("decode embedded China outline: invalid features list")
		}
		for decoder.More() {
			var rawFeature chinaAdminRawFeature
			if err := decoder.Decode(&rawFeature); err != nil {
				return nil, fmt.Errorf("decode embedded China outline feature: %w", err)
			}
			properties := rawFeature.Properties
			if properties.Adcode == 0 || properties.Name == "" || len(rawFeature.Geometry) == 0 {
				return nil, errors.New("embedded China outline contains an incomplete feature")
			}
			if !isChinaAdminLevel(properties.Level) {
				return nil, fmt.Errorf("embedded China outline contains unknown level %q", properties.Level)
			}
			feature := &chinaOutlineFeature{
				adcode:       properties.Adcode,
				name:         properties.Name,
				level:        properties.Level,
				parentAdcode: properties.Parent.Adcode,
				geometry:     rawFeature.Geometry,
			}
			if _, exists := index.byAdcode[feature.adcode]; exists {
				return nil, fmt.Errorf("embedded China outline contains duplicate adcode %d", feature.adcode)
			}
			index.byAdcode[feature.adcode] = feature
			index.features = append(index.features, feature)
			index.childrenByParent[feature.parentAdcode] = append(index.childrenByParent[feature.parentAdcode], feature)
			if feature.level == chinaAdminProvinceLevel {
				index.provinces = append(index.provinces, feature)
			}
		}
		if _, err := decoder.Token(); err != nil {
			return nil, fmt.Errorf("decode embedded China outline: %w", err)
		}
	}
	if len(index.provinces) != 34 || len(index.features) < 3_000 {
		return nil, fmt.Errorf(
			"embedded China outline is incomplete: provinces=%d features=%d",
			len(index.provinces), len(index.features),
		)
	}
	if !found {
		return nil, errors.New("embedded China outline: missing features list")
	}
	sort.Slice(index.features, func(i, j int) bool { return index.features[i].adcode < index.features[j].adcode })
	for _, features := range index.childrenByParent {
		sort.Slice(features, func(i, j int) bool { return features[i].adcode < features[j].adcode })
	}
	return index, nil
}
