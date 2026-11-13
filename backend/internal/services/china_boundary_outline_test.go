package services

import (
	"encoding/json"
	"testing"
)

// geometryPolygonsOfOutline 数一个轮廓要素里的环。
func geometryPolygonsOfOutline(raw json.RawMessage) [][][][2]float64 {
	var probe struct {
		Type        string          `json:"type"`
		Coordinates json.RawMessage `json:"coordinates"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return nil
	}
	if probe.Type == "Polygon" {
		var rings [][][2]float64
		if err := json.Unmarshal(probe.Coordinates, &rings); err != nil {
			return nil
		}
		return [][][][2]float64{rings}
	}
	var polygons [][][][2]float64
	if err := json.Unmarshal(probe.Coordinates, &polygons); err != nil {
		return nil
	}
	return polygons
}

// chinaMatchingFeatures 返回匹配索引里的全部要素。
func chinaMatchingFeatures(index *chinaAdminIndex) []*chinaAdminFeature {
	features := make([]*chinaAdminFeature, 0, len(index.provinces)+len(index.areas))
	features = append(features, index.provinces...)
	features = append(features, index.areas...)
	return features
}

// chinaFeaturePointCount 数一个要素里的坐标点。
func chinaFeaturePointCount(feature *chinaAdminFeature) int {
	count := 0
	for _, polygon := range feature.polygons {
		for _, ring := range polygon.rings {
			count += len(ring)
		}
	}
	return count
}

// TestChinaOutlineMatchesTheMatchingBoundaries 守住两份边界数据的一致性。
//
// 绘图轮廓是匹配数据的简化形态，两者的区划码、层级与上级必须一一对应：
// 对不上就会出现「地图上画着一个区，统计里算的是另一个区」。
// 这个断言放在测试里而不是运行时 —— 运行时校验会把 6 秒的匹配索引
// 加载拖进绘图端点。
func TestChinaOutlineMatchesTheMatchingBoundaries(t *testing.T) {
	match, err := loadChinaAdminIndex()
	if err != nil {
		t.Fatal(err)
	}
	outline, err := loadChinaOutlineIndex()
	if err != nil {
		t.Fatal(err)
	}
	matching := chinaMatchingFeatures(match)
	if len(outline.features) != len(matching) {
		t.Fatalf("outline has %d features, matching data has %d", len(outline.features), len(matching))
	}
	for _, feature := range outline.features {
		counterpart, exists := match.byAdcode[feature.adcode]
		if !exists {
			t.Fatalf("outline adcode %d is missing from the matching boundaries", feature.adcode)
		}
		if counterpart.name != feature.name {
			t.Fatalf("outline %d is named %q, matching data says %q", feature.adcode, feature.name, counterpart.name)
		}
		if counterpart.level != feature.level {
			t.Fatalf("outline %d is a %q, matching data says %q", feature.adcode, feature.level, counterpart.level)
		}
		if counterpart.parentAdcode != feature.parentAdcode {
			t.Fatalf(
				"outline %d has parent %d, matching data says %d",
				feature.adcode, feature.parentAdcode, counterpart.parentAdcode,
			)
		}
	}
}

// TestChinaOutlineIsSubstantiallySmallerThanTheMatchingBoundaries 守住
// 「绘图数据确实被简化过」这件事。
//
// 简化一旦失效，绘图端点就会重新变回 18MB —— 那正是这次要修的问题。
func TestChinaOutlineIsSubstantiallySmallerThanTheMatchingBoundaries(t *testing.T) {
	match, err := loadChinaAdminIndex()
	if err != nil {
		t.Fatal(err)
	}
	outline, err := loadChinaOutlineIndex()
	if err != nil {
		t.Fatal(err)
	}
	matchPoints := 0
	for _, feature := range chinaMatchingFeatures(match) {
		matchPoints += chinaFeaturePointCount(feature)
	}
	outlinePoints := 0
	for _, feature := range outline.features {
		for _, polygon := range geometryPolygonsOfOutline(feature.geometry) {
			for _, ring := range polygon {
				outlinePoints += len(ring)
			}
		}
	}
	if outlinePoints*4 > matchPoints {
		t.Fatalf(
			"outline has %d points, matching data has %d: the outline was not simplified",
			outlinePoints, matchPoints,
		)
	}
	t.Logf("outline %d points vs matching %d points", outlinePoints, matchPoints)
}
