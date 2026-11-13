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
		metadata := ImageMetadata{
			Status: MetadataParseParsed,
			GPS: &GPSMetadata{
				Latitude:  photos[index].Coordinate[0],
				Longitude: photos[index].Coordinate[1],
				MapDatum:  "WGS-84",
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
	for _, region := range zhejiang.Regions {
		if len(region.Geometry) == 0 {
			t.Fatalf("sub region %d is missing its geometry", region.Adcode)
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
