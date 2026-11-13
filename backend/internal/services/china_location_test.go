package services

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// chinaTestPhoto 是测试里的一张照片：坐标与可选的 EXIF 拍摄时间。
type chinaTestPhoto struct {
	Coordinate [2]float64
	Datum      string
	// CapturedAt 是 EXIF 拍摄时间（相机墙上时间）。空表示没有。
	CapturedAt string
}

// chinaTestRecords 为测试照片写入带 GPS 的元数据记录。
func chinaTestRecords(t *testing.T, catalog *ResourceCatalog, files []string, photos []chinaTestPhoto) []AIAnalysisRecord {
	t.Helper()
	records := make([]AIAnalysisRecord, 0, len(files))
	for index, path := range files {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		datum := photos[index].Datum
		if datum == "" {
			datum = "WGS-84"
		}
		metadata := ImageMetadata{
			Status: MetadataParseParsed,
			GPS: &GPSMetadata{
				Latitude:  photos[index].Coordinate[0],
				Longitude: photos[index].Coordinate[1],
				MapDatum:  datum,
			},
		}
		if photos[index].CapturedAt != "" {
			metadata.DateTimeOriginal = photos[index].CapturedAt
		}
		data, err := json.Marshal(metadata)
		if err != nil {
			t.Fatal(err)
		}
		records = append(records, AIAnalysisRecord{
			Type: AIJobTypeMetadata, ResourceID: catalog.ExternalID(path, ResourceFile),
			Size: info.Size(), MTimeNs: info.ModTime().UnixNano(), Status: MetadataParseParsed, Data: data,
		})
	}
	return records
}

func TestChinaBoundaryIndexIncludesCountyHierarchy(t *testing.T) {
	index, err := loadChinaAdminIndex()
	if err != nil {
		t.Fatal(err)
	}
	districts := 0
	for _, area := range index.areas {
		if area.level == chinaAdminDistrictLevel {
			districts++
		}
	}
	if len(index.provinces) != 34 || len(index.areas) < 3_000 || districts < 2_800 {
		t.Fatalf("boundary hierarchy = %d provinces, %d areas, %d districts", len(index.provinces), len(index.areas), districts)
	}
	xihu, exists := index.byAdcode[330106]
	if !exists || xihu.level != chinaAdminDistrictLevel || xihu.parentAdcode != 330100 {
		t.Fatalf("Xihu boundary is missing or has the wrong parent: %+v", xihu)
	}
	if _, exists := index.byAdcode[110100]; exists {
		t.Fatal("Beijing municipality alias was not folded into its province")
	}
	if districtsUnderProvince := index.childrenByParent[110000]; len(districtsUnderProvince) == 0 {
		t.Fatal("Beijing districts are not attached directly to the municipality")
	}
}

func TestChinaLocationMatchesCountyAndAggregatesToCity(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 2)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-02T10:00:00"},
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-03T10:00:00"},
	})
	service := NewChinaLocationService()

	province, err := service.Regions(snapshot, records, 1, validator, 330000, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	var hangzhouCount int
	for _, region := range province.Regions {
		if region.Adcode == 330100 {
			hangzhouCount = region.PhotoCount
		}
	}
	if hangzhouCount != 2 {
		t.Fatalf("Hangzhou aggregate count = %d, want 2", hangzhouCount)
	}

	city, err := service.Regions(snapshot, records, 1, validator, 330100, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if city.Region.PhotoCount != 2 || city.Region.UnmatchedAreaPhotoCount != 0 {
		t.Fatalf("Hangzhou aggregate = %+v", city.Region)
	}
	if len(city.Region.Ancestors) != 1 || city.Region.Ancestors[0].Adcode != 330000 {
		t.Fatalf("Hangzhou ancestors = %+v", city.Region.Ancestors)
	}
	var xihuCount int
	for _, region := range city.Regions {
		if region.Adcode == 330106 {
			xihuCount = region.PhotoCount
		}
	}
	if xihuCount != 2 {
		t.Fatalf("Xihu district count = %d, want 2", xihuCount)
	}
	if len(city.Trajectory) != 1 || city.Trajectory[0].Adcode != 330106 || city.Trajectory[0].PhotoCount != 2 {
		t.Fatalf("city trajectory did not use its county-level stop: %+v", city.Trajectory)
	}

	county, err := service.Regions(snapshot, records, 1, validator, 330106, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if len(county.Region.Ancestors) != 2 || county.Region.Ancestors[0].Adcode != 330000 || county.Region.Ancestors[1].Adcode != 330100 {
		t.Fatalf("Xihu ancestors = %+v", county.Region.Ancestors)
	}
	page, err := service.RegionMedia(snapshot, records, 1, validator, 330100, ChinaTimeRange{}, -1, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 {
		t.Fatalf("city media total = %d, want 2", page.Total)
	}
}

func TestChinaLocationsMatchCurrentGPSPhotosToProvinceAndDistrict(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 3)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		{Coordinate: [2]float64{39.915309, 116.366794}}, // 北京西城
		{Coordinate: [2]float64{31.2304, 121.4737}},     // 上海
		{Coordinate: [2]float64{40.7128, -74.006}},      // 中国境外
	})

	service := NewChinaLocationService()
	summary, err := service.Summary(snapshot, records, 1, validator, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if summary.GPSPhotoCount != 3 || summary.ChinaPhotoCount != 2 || summary.UnassignedPhotoCount != 1 {
		t.Fatalf("photo totals = GPS %d, China %d, unassigned %d", summary.GPSPhotoCount, summary.ChinaPhotoCount, summary.UnassignedPhotoCount)
	}
	if len(summary.Provinces) != 34 {
		t.Fatalf("embedded administrative areas = %d provinces", len(summary.Provinces))
	}
	provinceCounts := make(map[int]int, len(summary.Provinces))
	for _, province := range summary.Provinces {
		provinceCounts[province.Adcode] = province.PhotoCount
	}
	if provinceCounts[110000] != 1 || provinceCounts[310000] != 1 {
		t.Fatalf("Beijing/Shanghai locations were not assigned to their boundaries: %v", provinceCounts)
	}

	beijing, err := service.Regions(snapshot, records, 1, validator, 110000, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if beijing.Region.Name != "北京市" || beijing.Region.ParentAdcode != nil {
		t.Fatalf("province info is wrong: %+v", beijing.Region)
	}
	districtCounts := make(map[int]int, len(beijing.Regions))
	for _, region := range beijing.Regions {
		districtCounts[region.Adcode] = region.PhotoCount
	}
	if districtCounts[110102] != 1 {
		t.Fatalf("Beijing districts were not assigned: %v", districtCounts)
	}

	zhejiang, err := service.Regions(snapshot, records, 1, validator, 330000, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if len(zhejiang.Regions) == 0 || zhejiang.Region.ParentAdcode != nil {
		t.Fatalf("province sub regions are missing: %+v", zhejiang.Region)
	}
	// 统计响应不再带几何；绘图几何由单独的端点下发，
	// 这里确认下钻到的每个区域都能在轮廓索引里找到对应要素。
	outline, hash, err := ChinaOutline(chinaAdminCityLevel, 330000)
	if err != nil {
		t.Fatal(err)
	}
	if hash == "" {
		t.Fatal("outline index is missing its content hash")
	}
	outlined := make(map[int]bool, len(outline))
	for _, feature := range outline {
		outlined[feature.Adcode] = true
	}
	for _, region := range zhejiang.Regions {
		if !outlined[region.Adcode] {
			t.Fatalf("sub region %d has no outline feature", region.Adcode)
		}
	}

	blocked, err := service.Summary(snapshot, records, 1, func(string) (string, error) {
		return "", os.ErrPermission
	}, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if blocked.GPSPhotoCount != 0 || blocked.ChinaPhotoCount != 0 {
		t.Fatalf("path validation failure included photos: %+v", blocked)
	}

	catalog.SetContentKindPolicy(NewContentKindPolicy([]RootKind{{Path: root, Kind: models.ContentKindComic}}))
	comicOnly, err := service.Summary(catalog.Acquire(), records, 1, validator, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if comicOnly.GPSPhotoCount != 0 {
		t.Fatalf("comic images were counted as photos: %+v", comicOnly)
	}
}

func TestChinaLocationServiceRecomputesWhenRecordsChange(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 2)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		{Coordinate: [2]float64{39.915309, 116.366794}},
		{Coordinate: [2]float64{31.2304, 121.4737}},
	})

	service := NewChinaLocationService()
	first, err := service.Summary(snapshot, records, 1, validator, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if first.ChinaPhotoCount != 2 {
		t.Fatalf("first summary = %+v", first)
	}
	cached, err := service.Summary(snapshot, records, 1, validator, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if cached.ChinaPhotoCount != first.ChinaPhotoCount {
		t.Fatalf("cached summary = %+v", cached)
	}
	// 分析结果变了，版本号跟着变，统计必须跟着更新。
	updated, err := service.Summary(snapshot, records[:1], 2, validator, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if updated.ChinaPhotoCount != 1 {
		t.Fatalf("summary was not recomputed after the records changed: %+v", updated)
	}
}

func TestChinaLocationRegionMediaReturnsRegionPhotos(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 2)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		{Coordinate: [2]float64{39.915309, 116.366794}},
		{Coordinate: [2]float64{39.915309, 116.366794}},
	})

	service := NewChinaLocationService()
	regions, err := service.Regions(snapshot, records, 1, validator, 110000, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if len(regions.Regions) == 0 {
		t.Fatal("province response has no sub regions")
	}
	var target int
	for _, region := range regions.Regions {
		if region.PhotoCount > 0 {
			target = region.Adcode
		}
	}
	if target == 0 {
		t.Fatal("no Beijing district received the photos")
	}
	page, err := service.RegionMedia(snapshot, records, 1, validator, target, ChinaTimeRange{}, -1, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	if page.Region.Adcode != target || page.Total != 2 {
		t.Fatalf("region media page = %+v", page.Region)
	}
	if len(page.Items) != 2 {
		t.Fatalf("region media items = %d", len(page.Items))
	}
	if page.Region.PhotoCount != page.Total {
		t.Fatalf("map count %d and media total %d disagree", page.Region.PhotoCount, page.Total)
	}
}

func TestChinaLocationTimeRangeFiltersCountsAndMonths(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 3)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		{Coordinate: [2]float64{39.915309, 116.366794}, CapturedAt: "2019-05-02T10:00:00"},
		{Coordinate: [2]float64{39.915309, 116.366794}, CapturedAt: "2019-08-11T09:30:00"},
		{Coordinate: [2]float64{31.2304, 121.4737}, CapturedAt: "2021-06-12T18:00:00"},
	})

	service := NewChinaLocationService()
	all, err := service.Summary(snapshot, records, 1, validator, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if len(all.Months) != 3 {
		t.Fatalf("month distribution = %+v", all.Months)
	}
	if all.Months[0].Month != "2019-05" || all.Months[0].Count != 1 {
		t.Fatalf("month distribution is wrong: %+v", all.Months)
	}

	scoped, err := service.Summary(snapshot, records, 1, validator, ChinaTimeRange{From: "2019-01", To: "2019-12"})
	if err != nil {
		t.Fatal(err)
	}
	provinceCounts := make(map[int]int, len(scoped.Provinces))
	for _, province := range scoped.Provinces {
		provinceCounts[province.Adcode] = province.PhotoCount
	}
	if provinceCounts[110000] != 2 || provinceCounts[310000] != 0 {
		t.Fatalf("time range did not filter province counts: %v", provinceCounts)
	}
	if len(scoped.Months) != 2 {
		t.Fatalf("scoped month distribution = %+v", scoped.Months)
	}
}

func TestChinaLocationTrajectoryStopsFollowRegionChanges(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 4)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		{Coordinate: [2]float64{39.915309, 116.366794}, CapturedAt: "2019-05-02T10:00:00"},
		{Coordinate: [2]float64{39.915309, 116.366794}, CapturedAt: "2019-05-02T18:00:00"},
		{Coordinate: [2]float64{31.2304, 121.4737}, CapturedAt: "2019-05-03T09:00:00"},
		{Coordinate: [2]float64{39.915309, 116.366794}, CapturedAt: "2021-06-12T10:00:00"},
	})

	service := NewChinaLocationService()
	summary, err := service.Summary(snapshot, records, 1, validator, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if len(summary.Trajectory) != 3 {
		t.Fatalf("trajectory stops = %+v", summary.Trajectory)
	}
	if summary.Trajectory[0].Adcode != 110000 || summary.Trajectory[0].PhotoCount != 2 {
		t.Fatalf("first stop is wrong: %+v", summary.Trajectory[0])
	}
	if summary.Trajectory[1].Adcode != 310000 || summary.Trajectory[1].PhotoCount != 1 {
		t.Fatalf("second stop is wrong: %+v", summary.Trajectory[1])
	}
	if summary.Trajectory[0].At != "2019-05-02" || summary.Trajectory[0].Until != "2019-05-02" {
		t.Fatalf("stop time span is wrong: %+v", summary.Trajectory[0])
	}
}

func TestChinaLocationVisitsSplitByDayGap(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 4)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	// 5 月 2 日两张、5 月 3 日一张（跨夜算同一次）、8 月 11 日一张（另一次）。
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		{Coordinate: [2]float64{39.915309, 116.366794}, CapturedAt: "2019-05-02T20:00:00"},
		{Coordinate: [2]float64{39.915309, 116.366794}, CapturedAt: "2019-05-03T08:00:00"},
		{Coordinate: [2]float64{39.915309, 116.366794}, CapturedAt: "2019-05-03T19:00:00"},
		{Coordinate: [2]float64{39.915309, 116.366794}, CapturedAt: "2019-08-11T10:00:00"},
	})

	service := NewChinaLocationService()
	regions, err := service.Regions(snapshot, records, 1, validator, 110000, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	var target int
	for _, region := range regions.Regions {
		if region.PhotoCount > 0 {
			target = region.Adcode
		}
	}
	if target == 0 {
		t.Fatal("no Beijing district received the photos")
	}

	visits, err := service.Visits(snapshot, records, 1, validator, target, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if len(visits.Visits) != 2 {
		t.Fatalf("visits = %+v", visits.Visits)
	}
	first := visits.Visits[0]
	if first.StartedAt != "2019-05-02" || first.EndedAt != "2019-05-03" {
		t.Fatalf("first visit span is wrong: %+v", first)
	}
	if first.DayCount != 2 || first.PhotoCount != 3 {
		t.Fatalf("first visit counts are wrong: %+v", first)
	}
	second := visits.Visits[1]
	if second.StartedAt != "2019-08-11" || second.PhotoCount != 1 {
		t.Fatalf("second visit is wrong: %+v", second)
	}

	// 到访里的照片必须与列表对得上。
	page, err := service.RegionMedia(snapshot, records, 1, validator, target, ChinaTimeRange{}, 0, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != first.PhotoCount {
		t.Fatalf("visit media total %d does not match the visit list %d", page.Total, first.PhotoCount)
	}
	if _, err := service.RegionMedia(snapshot, records, 1, validator, target, ChinaTimeRange{}, 5, "", 20); err == nil {
		t.Fatal("an out of range visit should not resolve")
	}
}

func TestChinaLocationUntimedPhotosAreExcludedFromTimeAggregates(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 2)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		{Coordinate: [2]float64{39.915309, 116.366794}, CapturedAt: "2019-05-02T10:00:00"},
		{Coordinate: [2]float64{39.915309, 116.366794}},
	})

	service := NewChinaLocationService()
	summary, err := service.Summary(snapshot, records, 1, validator, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if summary.UntimedPhotoCount != 1 {
		t.Fatalf("untimed photo count = %d", summary.UntimedPhotoCount)
	}
	if len(summary.Months) != 1 {
		t.Fatalf("months should only count timed photos: %+v", summary.Months)
	}
}

// TestChinaLocationProvinceScopeKnowsItsChildren 守住省一级归集里的两个口径。
//
// 省里的照片要带着它命中了哪个下级：否则「未细分」的数量会把省里的
// 全部照片都算进去，省级轨迹也会是空的。
func TestChinaLocationProvinceScopeKnowsItsChildren(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 2)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-02T10:00:00"},
		{Coordinate: [2]float64{31.230416, 121.473701}, Datum: "GCJ-02", CapturedAt: "2019-05-03T10:00:00"},
	})
	service := NewChinaLocationService()

	province, err := service.Regions(snapshot, records, 1, validator, 330000, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if province.Region.PhotoCount != 1 {
		t.Fatalf("Zhejiang photo count = %d, want 1", province.Region.PhotoCount)
	}
	if province.Region.UnmatchedAreaPhotoCount != 0 {
		t.Fatalf("Zhejiang unmatched count = %d, want 0", province.Region.UnmatchedAreaPhotoCount)
	}
	if len(province.Trajectory) == 0 {
		t.Fatal("province trajectory is empty")
	}
	if province.Trajectory[0].Adcode != 330100 {
		t.Fatalf("province trajectory starts at %d, want the city 330100", province.Trajectory[0].Adcode)
	}
}
