package services

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// chinaTestRecords 为测试照片写入带 GPS 的元数据记录。
func chinaTestRecords(t *testing.T, catalog *ResourceCatalog, root string, files []string, coordinates [][2]float64) []AIAnalysisRecord {
	t.Helper()
	records := make([]AIAnalysisRecord, 0, len(files))
	for index, path := range files {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(ImageMetadata{
			Status: MetadataParseParsed,
			GPS: &GPSMetadata{
				Latitude: coordinates[index][0], Longitude: coordinates[index][1], MapDatum: "WGS-84",
			},
		})
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
	records := chinaTestRecords(t, catalog, root, files, [][2]float64{
		{39.915309, 116.366794}, // 北京西城
		{31.2304, 121.4737},     // 上海
		{40.7128, -74.006},      // 中国境外
	})

	service := NewChinaLocationService()
	summary, err := service.Summary(snapshot, records, 1, validator)
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

	beijing, err := service.Regions(snapshot, records, 1, validator, 110000)
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

	zhejiang, err := service.Regions(snapshot, records, 1, validator, 330000)
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
	})
	if err != nil {
		t.Fatal(err)
	}
	if blocked.GPSPhotoCount != 0 || blocked.ChinaPhotoCount != 0 {
		t.Fatalf("path validation failure included photos: %+v", blocked)
	}

	catalog.SetContentKindPolicy(NewContentKindPolicy([]RootKind{{Path: root, Kind: models.ContentKindComic}}))
	comicOnly, err := service.Summary(catalog.Acquire(), records, 1, validator)
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
	records := chinaTestRecords(t, catalog, root, files, [][2]float64{
		{39.915309, 116.366794},
		{31.2304, 121.4737},
	})

	service := NewChinaLocationService()
	first, err := service.Summary(snapshot, records, 1, validator)
	if err != nil {
		t.Fatal(err)
	}
	if first.ChinaPhotoCount != 2 {
		t.Fatalf("first summary = %+v", first)
	}
	cached, err := service.Summary(snapshot, records, 1, validator)
	if err != nil {
		t.Fatal(err)
	}
	if cached.ChinaPhotoCount != first.ChinaPhotoCount {
		t.Fatalf("cached summary = %+v", cached)
	}
	// 分析结果变了，版本号跟着变，统计必须跟着更新。
	updated, err := service.Summary(snapshot, records[:1], 2, validator)
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
	records := chinaTestRecords(t, catalog, root, files, [][2]float64{
		{39.915309, 116.366794},
		{39.915309, 116.366794},
	})

	service := NewChinaLocationService()
	regions, err := service.Regions(snapshot, records, 1, validator, 110000)
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
	page, err := service.RegionMedia(snapshot, records, 1, validator, target, "", 20)
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
