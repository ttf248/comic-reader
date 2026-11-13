package services

import (
	"fmt"
	"testing"
)

// chinaPlaceByAdcode 在地点索引里找一个地方。
func chinaPlaceByAdcode(places []ChinaPlace, adcode int) (ChinaPlace, bool) {
	for _, place := range places {
		if place.Adcode == adcode {
			return place, true
		}
	}
	return ChinaPlace{}, false
}

// chinaTripByIndex 取第 n 段行程。
func chinaTripByIndex(trips []ChinaTrip, index int) ChinaTrip {
	if index < 0 || index >= len(trips) {
		return ChinaTrip{}
	}
	return trips[index]
}

func TestChinaPlacesIndexesOnlyVisitedPlaces(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 3)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-02T10:00:00"},
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-03T10:00:00"},
		{Coordinate: [2]float64{31.230416, 121.473701}, Datum: "GCJ-02", CapturedAt: "2019-06-10T10:00:00"},
	})
	service := NewChinaLocationService()

	provinces, err := service.Places(snapshot, records, 1, validator, chinaAdminProvinceLevel, 0, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if provinces.Total != 2 {
		t.Fatalf("province places = %d, want 2: %+v", provinces.Total, provinces.Items)
	}
	zhejiang, exists := chinaPlaceByAdcode(provinces.Items, 330000)
	if !exists {
		t.Fatalf("Zhejiang is missing from the place index: %+v", provinces.Items)
	}
	if zhejiang.PhotoCount != 2 || zhejiang.VisitCount != 1 {
		t.Fatalf("Zhejiang place = %+v", zhejiang)
	}
	if zhejiang.FirstAt != "2019-05-02" || zhejiang.LastAt != "2019-05-03" {
		t.Fatalf("Zhejiang first/last = %q..%q", zhejiang.FirstAt, zhejiang.LastAt)
	}
	if len(zhejiang.CoverResourceIDs) == 0 {
		t.Fatal("Zhejiang place has no cover photo")
	}
	shanghai, exists := chinaPlaceByAdcode(provinces.Items, 310000)
	if !exists || shanghai.PhotoCount != 1 {
		t.Fatalf("Shanghai place = %+v", shanghai)
	}

	// 市级粒度：杭州的照片归到杭州市，直辖市的照片没有市一级，
	// 往上退到上海本身 —— 这正是用户心里的说法。
	cities, err := service.Places(snapshot, records, 1, validator, chinaAdminCityLevel, 0, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if cities.Total != 2 {
		t.Fatalf("city places = %d, want 2: %+v", cities.Total, cities.Items)
	}
	hangzhou, exists := chinaPlaceByAdcode(cities.Items, 330100)
	if !exists || hangzhou.PhotoCount != 2 {
		t.Fatalf("Hangzhou place = %+v", hangzhou)
	}
	shanghaiCity, exists := chinaPlaceByAdcode(cities.Items, 310000)
	if !exists || shanghaiCity.PhotoCount != 1 {
		t.Fatalf("Shanghai city place = %+v", shanghaiCity)
	}

	// 区县级粒度：能落到区县的落在区县，落不到的上��退一级。
	districts, err := service.Places(snapshot, records, 1, validator, chinaAdminDistrictLevel, 0, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	xihu, exists := chinaPlaceByAdcode(districts.Items, 330106)
	if !exists || xihu.PhotoCount != 2 {
		t.Fatalf("Xihu place = %+v", xihu)
	}
}

func TestChinaPlacesRespectsTimeRangeAndParent(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 3)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-02T10:00:00"},
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2021-06-12T10:00:00"},
		{Coordinate: [2]float64{31.230416, 121.473701}, Datum: "GCJ-02", CapturedAt: "2019-06-10T10:00:00"},
	})
	service := NewChinaLocationService()

	scoped, err := service.Places(
		snapshot, records, 1, validator,
		chinaAdminProvinceLevel, 0,
		ChinaTimeRange{From: "2019-01", To: "2019-12"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if scoped.Total != 2 {
		t.Fatalf("scoped places = %d, want 2: %+v", scoped.Total, scoped.Items)
	}
	zhejiang, _ := chinaPlaceByAdcode(scoped.Items, 330000)
	if zhejiang.PhotoCount != 1 {
		t.Fatalf("Zhejiang place in 2019 = %+v", zhejiang)
	}

	// 限定在浙江省之下：只剩浙江自己的市。
	inside, err := service.Places(snapshot, records, 1, validator, chinaAdminCityLevel, 330000, ChinaTimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if inside.Total != 1 {
		t.Fatalf("places under Zhejiang = %d, want 1: %+v", inside.Total, inside.Items)
	}
	if _, exists := chinaPlaceByAdcode(inside.Items, 330100); !exists {
		t.Fatalf("Hangzhou is missing from the scoped index: %+v", inside.Items)
	}
}

func TestChinaTripsDistinguishStaysAndTrips(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 4)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		// 同一处连着两天：一次停留。
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-02T10:00:00"},
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-03T10:00:00"},
		// 隔了两天到了上海：同一次行程里的第二个停留。
		{Coordinate: [2]float64{31.230416, 121.473701}, Datum: "GCJ-02", CapturedAt: "2019-05-05T10:00:00"},
		// 半年后又在杭州：另一次行程。
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2021-06-12T10:00:00"},
	})
	service := NewChinaLocationService()

	trips, err := service.Trips(snapshot, records, 1, validator, chinaAdminCityLevel, ChinaTimeRange{}, ChinaTripMaxGapDays)
	if err != nil {
		t.Fatal(err)
	}
	if trips.Total != 2 {
		t.Fatalf("trips = %d, want 2: %+v", trips.Total, trips.Items)
	}
	first := chinaTripByIndex(trips.Items, 0)
	if first.Kind != chinaTripKindTrip {
		t.Fatalf("first trip kind = %q, want a trip: %+v", first.Kind, first)
	}
	if len(first.Stops) != 2 {
		t.Fatalf("first trip stops = %d, want 2: %+v", len(first.Stops), first.Stops)
	}
	if first.Stops[0].Adcode != 330100 || first.Stops[1].Adcode != 310000 {
		t.Fatalf("first trip route = %+v", first.Stops)
	}
	if first.StartedAt != "2019-05-02" || first.EndedAt != "2019-05-05" {
		t.Fatalf("first trip window = %s..%s", first.StartedAt, first.EndedAt)
	}
	if first.PhotoCount != 3 {
		t.Fatalf("first trip photo count = %d, want 3", first.PhotoCount)
	}
	if len(first.CoverResourceIDs) == 0 {
		t.Fatal("first trip has no cover photo")
	}
	second := chinaTripByIndex(trips.Items, 1)
	if second.Kind != chinaTripKindStay {
		t.Fatalf("second trip kind = %q, want a stay: %+v", second.Kind, second)
	}
	if len(second.Stops) != 1 || second.Stops[0].Adcode != 330100 {
		t.Fatalf("second trip stops = %+v", second.Stops)
	}
}

func TestChinaTripsRejectsUnknownGranularity(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 1)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-02T10:00:00"},
	})
	service := NewChinaLocationService()
	if _, err := service.Trips(snapshot, records, 1, validator, "township", ChinaTimeRange{}, ChinaTripMaxGapDays); err == nil {
		t.Fatal("trips accepted an unknown granularity")
	}
	if _, err := service.Places(snapshot, records, 1, validator, "township", 0, ChinaTimeRange{}); err == nil {
		t.Fatal("places accepted an unknown granularity")
	}
}

// TestChinaTripsGapWidthChangesTheSegmentation 守住行程的切分口径。
//
// 两天的口径是「回来算又一次到访」，把出门一趟切成好几段；十四天的
// 口径把两周之内还连着拍的地方算作同一段出行。
func TestChinaTripsGapWidthChangesTheSegmentation(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 4)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-02T10:00:00"},
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-05T10:00:00"},
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-10T10:00:00"},
		{Coordinate: [2]float64{31.230416, 121.473701}, Datum: "GCJ-02", CapturedAt: "2019-05-11T10:00:00"},
	})
	service := NewChinaLocationService()

	narrow, err := service.Trips(snapshot, records, 1, validator, chinaAdminCityLevel, ChinaTimeRange{}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if narrow.Total != 3 {
		t.Fatalf("two-day trips = %d, want 3: %+v", narrow.Total, narrow.Items)
	}
	wide, err := service.Trips(snapshot, records, 1, validator, chinaAdminCityLevel, ChinaTimeRange{}, 14)
	if err != nil {
		t.Fatal(err)
	}
	if wide.Total != 1 {
		t.Fatalf("fourteen-day trips = %d, want 1: %+v", wide.Total, wide.Items)
	}
	if wide.GapDays != 14 {
		t.Fatalf("gap days = %d", wide.GapDays)
	}
}

// TestChinaTripsCarryTheirOwnPhotos 守住「行程带自己的照片」。
//
// 行程要能被当成一段内容读出来，靠的就是照片带；照片按序号寻址，
// 段与照片必须用同一套切分口径，否则按序号取回的是另一段。
func TestChinaTripsCarryTheirOwnPhotos(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 4)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-02T10:00:00"},
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-03T10:00:00"},
		{Coordinate: [2]float64{31.230416, 121.473701}, Datum: "GCJ-02", CapturedAt: "2019-05-05T10:00:00"},
		// 半年后：另一次行程。
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2021-06-12T10:00:00"},
	})
	service := NewChinaLocationService()

	trips, err := service.Trips(snapshot, records, 1, validator, chinaAdminCityLevel, ChinaTimeRange{}, ChinaTripMaxGapDays)
	if err != nil {
		t.Fatal(err)
	}
	if trips.Total != 2 {
		t.Fatalf("trips = %d, want 2: %+v", trips.Total, trips.Items)
	}
	for position, trip := range trips.Items {
		if trip.Index != position {
			t.Fatalf("trip %d reports index %d", position, trip.Index)
		}
	}
	if len(trips.Items[0].BandResourceIDs) != 3 {
		t.Fatalf("first trip band = %v, want three photos", trips.Items[0].BandResourceIDs)
	}
	if len(trips.Items[1].BandResourceIDs) != 1 {
		t.Fatalf("second trip band = %v, want one photo", trips.Items[1].BandResourceIDs)
	}

	// 按序号取回的就是同一段。
	page, err := service.TripMedia(snapshot, records, 1, validator, chinaAdminCityLevel, ChinaTimeRange{}, ChinaTripMaxGapDays, 0, "", 200)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 3 || len(page.Items) != 3 {
		t.Fatalf("trip media = %d items, want 3: %+v", page.Total, page.Items)
	}
	if page.Trip.Id != trips.Items[0].Id {
		t.Fatalf("trip media trip = %q, want %q", page.Trip.Id, trips.Items[0].Id)
	}
	if len(page.Items) > 0 && page.Items[0].ID != trips.Items[0].BandResourceIDs[0] {
		t.Fatalf("trip media first item = %q, want %q", page.Items[0].ID, trips.Items[0].BandResourceIDs[0])
	}

	// 越界的序号是 404，不是空页。
	if _, err := service.TripMedia(snapshot, records, 1, validator, chinaAdminCityLevel, ChinaTimeRange{}, ChinaTripMaxGapDays, 9, "", 200); err == nil {
		t.Fatal("trip media accepted an unknown trip index")
	}
}

// TestChinaTripBandSamplesAcrossTheWholeSegment 守住照片带的采样。
//
// 一段行程是一个跨度：只取开头几张会把这段讲成「刚到那儿」。
// 均匀采样要照顾到首尾。
func TestChinaTripBandSamplesAcrossTheWholeSegment(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 14)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	photos := make([]chinaTestPhoto, 0, 14)
	for day := 1; day <= 14; day++ {
		photos = append(photos, chinaTestPhoto{
			Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02",
			CapturedAt: fmt.Sprintf("2019-05-%02dT10:00:00", day),
		})
	}
	records := chinaTestRecords(t, catalog, files, photos)
	service := NewChinaLocationService()

	trips, err := service.Trips(snapshot, records, 1, validator, chinaAdminCityLevel, ChinaTimeRange{}, ChinaTripMaxGapDays)
	if err != nil {
		t.Fatal(err)
	}
	if trips.Total != 1 {
		t.Fatalf("trips = %d, want 1: %+v", trips.Total, trips.Items)
	}
	band := trips.Items[0].BandResourceIDs
	if len(band) != chinaTripBandCount {
		t.Fatalf("band = %d photos, want %d: %v", len(band), chinaTripBandCount, band)
	}
	page, err := service.TripMedia(snapshot, records, 1, validator, chinaAdminCityLevel, ChinaTimeRange{}, ChinaTripMaxGapDays, 0, "", 200)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 14 {
		t.Fatalf("trip media total = %d, want 14", page.Total)
	}
	if band[0] != page.Items[0].ID {
		t.Fatalf("band starts at %q, want %q", band[0], page.Items[0].ID)
	}
	if band[len(band)-1] != page.Items[len(page.Items)-1].ID {
		t.Fatalf("band ends at %q, want %q", band[len(band)-1], page.Items[len(page.Items)-1].ID)
	}
}

// TestChinaTripStopsCarryTheirParent 守住停留点的上级。
//
// 段落的地图按「停留点的直接上级」去取那一层轮廓：停留点是市就取
// 该省的城市，停留点是省就没有上级，取全国各省。
func TestChinaTripStopsCarryTheirParent(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 3)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	records := chinaTestRecords(t, catalog, files, []chinaTestPhoto{
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-02T10:00:00"},
		{Coordinate: [2]float64{31.230416, 121.473701}, Datum: "GCJ-02", CapturedAt: "2019-05-05T10:00:00"},
		{Coordinate: [2]float64{30.259242, 120.130396}, Datum: "GCJ-02", CapturedAt: "2019-05-06T10:00:00"},
	})
	service := NewChinaLocationService()

	trips, err := service.Trips(snapshot, records, 1, validator, chinaAdminCityLevel, ChinaTimeRange{}, ChinaTripMaxGapDays)
	if err != nil {
		t.Fatal(err)
	}
	if trips.Total != 1 {
		t.Fatalf("trips = %d, want 1: %+v", trips.Total, trips.Items)
	}
	stops := trips.Items[0].Stops
	if len(stops) != 3 {
		t.Fatalf("stops = %d, want 3: %+v", len(stops), stops)
	}
	// 杭州市的上级是浙江省。
	if stops[0].ParentAdcode == nil || *stops[0].ParentAdcode != 330000 {
		t.Fatalf("Hangzhou stop parent = %v, want 330000", stops[0].ParentAdcode)
	}
	// 直辖市没有市一级，停留点就是上海本身，没有上级。
	if stops[1].ParentAdcode != nil {
		t.Fatalf("Shanghai stop parent = %v, want null", *stops[1].ParentAdcode)
	}
}
