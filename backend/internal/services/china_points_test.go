package services

import (
	"math"
	"testing"
)

// chinaPointByLocation 在点云里找一个网格。
func chinaPointByLocation(points ChinaPoints, longitude, latitude float64) (ChinaPointCell, bool) {
	for _, cell := range points.Items {
		if cell.Longitude == longitude && cell.Latitude == latitude {
			return cell, true
		}
	}
	return ChinaPointCell{}, false
}

func TestChinaPointsAggregatePhotoPositionsIntoGrid(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 4)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	// 三张在同一格里，一张在邻格。
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-02T10:00:00"},
		{Coordinate: [2]float64{30.259300, 120.130500}, Datum: "GCJ-02", CapturedAt: "2019-05-03T10:00:00"},
		{Coordinate: [2]float64{30.259900, 120.130800}, Datum: "GCJ-02", CapturedAt: "2021-06-10T10:00:00"},
		{Coordinate: [2]float64{31.230416, 121.473701}, Datum: "GCJ-02", CapturedAt: "2021-06-11T10:00:00"},
	})
	service := NewChinaLocationService()

	points, err := service.Points(snapshot, records, 1, validator, ChinaTimeRange{}, ChinaPointDefaultCell)
	if err != nil {
		t.Fatal(err)
	}
	if points.Cells != 2 {
		t.Fatalf("cells = %d, want 2: %+v", points.Cells, points.Items)
	}
	if points.Total != 4 {
		t.Fatalf("total = %d, want 4", points.Total)
	}
	if points.Cell != ChinaPointDefaultCell {
		t.Fatalf("cell = %v, want %v", points.Cell, ChinaPointDefaultCell)
	}
	// 杭州那张格子：格心而不是照片的坐标。
	hangzhou, exists := chinaPointByLocation(points, 120.13, 30.25)
	if !exists {
		t.Fatalf("Hangzhou cell is missing: %+v", points.Items)
	}
	if hangzhou.Count != 3 {
		t.Fatalf("Hangzhou count = %d, want 3", hangzhou.Count)
	}
	if hangzhou.FirstAt != "2019-05-02" || hangzhou.LastAt != "2021-06-10" {
		t.Fatalf("Hangzhou first/last = %q..%q", hangzhou.FirstAt, hangzhou.LastAt)
	}
	// 格心是格子的中心，不是照片坐标的平均值。
	if math.Abs(hangzhou.Longitude-120.13) > 1e-9 || math.Abs(hangzhou.Latitude-30.25) > 1e-9 {
		t.Fatalf("Hangzhou cell center = %v,%v", hangzhou.Longitude, hangzhou.Latitude)
	}
}

func TestChinaPointsRespectTimeRange(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 2)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-02T10:00:00"},
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2021-06-10T10:00:00"},
	})
	service := NewChinaLocationService()

	points, err := service.Points(snapshot, records, 1, validator, ChinaTimeRange{From: "2019-01", To: "2019-12"}, ChinaPointDefaultCell)
	if err != nil {
		t.Fatal(err)
	}
	if points.Total != 1 {
		t.Fatalf("total = %d, want 1", points.Total)
	}
	if len(points.Items) != 1 {
		t.Fatalf("cells = %d, want 1", len(points.Items))
	}
	if points.Items[0].Count != 1 || points.Items[0].FirstAt != "2019-05-02" {
		t.Fatalf("cell = %+v", points.Items[0])
	}
}

func TestChinaPointsKeepUntimedPhotos(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 2)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-02T10:00:00"},
		// 没有拍摄时间：位置是真的，只是不知道什么时候。
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02"},
	})
	service := NewChinaLocationService()

	points, err := service.Points(snapshot, records, 1, validator, ChinaTimeRange{From: "2019-01", To: "2019-12"}, ChinaPointDefaultCell)
	if err != nil {
		t.Fatal(err)
	}
	if points.Total != 2 {
		t.Fatalf("total = %d, want 2", points.Total)
	}
	cell, exists := chinaPointByLocation(points, 120.13, 30.25)
	if !exists {
		t.Fatalf("cell is missing: %+v", points.Items)
	}
	if cell.Untimed != 1 {
		t.Fatalf("untimed = %d, want 1", cell.Untimed)
	}
	if cell.Count != 2 {
		t.Fatalf("count = %d, want 2", cell.Count)
	}
	// 没有可信时间的照片不参与首末日期。
	if cell.FirstAt != "2019-05-02" || cell.LastAt != "2019-05-02" {
		t.Fatalf("cell first/last = %q..%q", cell.FirstAt, cell.LastAt)
	}
}

func TestChinaPointsCoarsenWhenCellLimitExceeded(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 3)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	// 三张相距很远，各占一格。
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-02T10:00:00"},
		{Coordinate: [2]float64{31.230416, 121.473701}, Datum: "GCJ-02", CapturedAt: "2019-06-02T10:00:00"},
		{Coordinate: [2]float64{23.129163, 113.264435}, Datum: "GCJ-02", CapturedAt: "2019-07-02T10:00:00"},
	})
	service := NewChinaLocationService()

	points, err := service.Points(snapshot, records, 1, validator, ChinaTimeRange{}, 0.01)
	if err != nil {
		t.Fatal(err)
	}
	if points.Cell < 0.01 {
		t.Fatalf("cell = %v, want at least 0.01", points.Cell)
	}
	if points.Cells > chinaPointMaxCells {
		t.Fatalf("cells = %d, want at most %d", points.Cells, chinaPointMaxCells)
	}
	if points.Total != 3 {
		t.Fatalf("total = %d, want 3", points.Total)
	}
}

func TestChinaPointCellWhitelist(t *testing.T) {
	for _, cell := range []float64{0.01, 0.02, 0.05, 0.1, 0.2, 0.5} {
		if !IsChinaPointCell(cell) {
			t.Fatalf("cell %v should be allowed", cell)
		}
	}
	for _, cell := range []float64{0, -1, 0.03, 0.7, 1} {
		if IsChinaPointCell(cell) {
			t.Fatalf("cell %v should be rejected", cell)
		}
	}
}
