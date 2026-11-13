package services

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

func TestGPSLocationsGroupCurrentPhotoRecordsAndPreserveAlbumSources(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 3)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	records := make([]AIAnalysisRecord, 0, len(files))
	coordinates := [][2]float64{{-37.5, -122.25}, {-37.5002, -122.2502}, {40.7128, -74.006}}
	for index, path := range files {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		id := catalog.ExternalID(path, ResourceFile)
		data, err := json.Marshal(ImageMetadata{
			Status: MetadataParseParsed,
			GPS: &GPSMetadata{
				Latitude:  coordinates[index][0],
				Longitude: coordinates[index][1],
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		records = append(records, AIAnalysisRecord{
			Type: AIJobTypeMetadata, ResourceID: id, Size: info.Size(), MTimeNs: info.ModTime().UnixNano(),
			ModuleVersion: MetadataParserVersion, Status: MetadataParseParsed, Data: data,
		})
	}

	page, err := PageGPSLocations(snapshot, records, validator, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 || page.Items[0].FileCount != 2 || page.Items[0].AlbumCount != 1 {
		t.Fatalf("GPS groups = %+v", page.Items)
	}
	locationPage, err := PageGPSLocationMedia(snapshot, records, validator, page.Items[0].ID, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	if locationPage.Total != 2 || locationPage.Location.ID != page.Items[0].ID || len(locationPage.Albums) != 1 {
		t.Fatalf("location media page = %+v", locationPage)
	}
	if locationPage.Items[0].AlbumID == "" || locationPage.Items[0].AlbumName != "album" {
		t.Fatalf("location media lost album source: %+v", locationPage.Items[0])
	}

	changed := time.Now().Add(time.Minute)
	if err := os.Chtimes(files[0], changed, changed); err != nil {
		t.Fatal(err)
	}
	updated, err := PageGPSLocations(snapshot, records, validator, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Total != 2 || updated.Items[0].FileCount != 1 {
		t.Fatalf("modified resource was not excluded: %+v", updated.Items)
	}

	blocked, err := PageGPSLocations(snapshot, records, func(string) (string, error) {
		return "", os.ErrPermission
	}, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	if blocked.Total != 0 {
		t.Fatalf("path validation failure exposed stale locations: %+v", blocked.Items)
	}
	if filepath.IsAbs(page.Items[0].Name) || page.Items[0].Name != fmt.Sprintf("坐标 %.4f°, %.4f°", page.Items[0].Latitude, page.Items[0].Longitude) {
		t.Fatalf("unexpected location label: %+v", page.Items[0])
	}
}

func TestChinaLocationsMatchCurrentGPSPhotosToProvinceAndDistrict(t *testing.T) {
	root := t.TempDir()
	files := writeAIJobImages(t, root, 3)
	catalog := aiJobCatalog(root, files)
	snapshot := catalog.Acquire()
	validator := aiTestPathValidator(t, root)
	coordinates := [][2]float64{
		{39.915309, 116.366794}, // 北京西城
		{31.2304, 121.4737},     // 上海
		{40.7128, -74.006},      // 中国境外
	}
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

	locations, err := ChinaLocations(snapshot, records, validator)
	if err != nil {
		t.Fatal(err)
	}
	if locations.GPSPhotoCount != 3 || locations.ChinaPhotoCount != 2 || locations.UnassignedPhotoCount != 1 {
		t.Fatalf("photo totals = GPS %d, China %d, unassigned %d", locations.GPSPhotoCount, locations.ChinaPhotoCount, locations.UnassignedPhotoCount)
	}
	if len(locations.Provinces) != 34 || len(locations.Areas) < 400 {
		t.Fatalf("embedded administrative areas = %d provinces, %d cities/districts", len(locations.Provinces), len(locations.Areas))
	}
	provinceCounts := make(map[int]int, len(locations.Provinces))
	areaCounts := make(map[int]int, len(locations.Areas))
	for _, province := range locations.Provinces {
		provinceCounts[province.Adcode] = province.PhotoCount
	}
	for _, area := range locations.Areas {
		areaCounts[area.Adcode] = area.PhotoCount
	}
	if provinceCounts[110000] != 1 || areaCounts[110102] != 1 || provinceCounts[310000] != 1 {
		t.Fatalf("Beijing/Shanghai locations were not assigned to their boundaries: provinces=%v areas=%v", provinceCounts, areaCounts)
	}
	blocked, err := ChinaLocations(snapshot, records, func(string) (string, error) {
		return "", os.ErrPermission
	})
	if err != nil {
		t.Fatal(err)
	}
	if blocked.GPSPhotoCount != 0 || blocked.ChinaPhotoCount != 0 {
		t.Fatalf("path validation failure included photos: %+v", blocked)
	}

	catalog.SetContentKindPolicy(NewContentKindPolicy([]RootKind{{Path: root, Kind: models.ContentKindComic}}))
	comicOnly, err := ChinaLocations(catalog.Acquire(), records, validator)
	if err != nil {
		t.Fatal(err)
	}
	if comicOnly.GPSPhotoCount != 0 {
		t.Fatalf("comic images were counted as photos: %+v", comicOnly)
	}
}
