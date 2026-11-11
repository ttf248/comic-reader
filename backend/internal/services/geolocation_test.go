package services

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
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
