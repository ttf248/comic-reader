package services

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

func TestResolveAlbumDatePrecedence(t *testing.T) {
	captured := time.Date(2023, 5, 4, 9, 30, 0, 0, time.UTC)
	modified := time.Date(2025, 1, 2, 0, 0, 0, 0, time.UTC)
	got, source := resolveAlbumDate(filepath.Join("library", "2024-08-17"), captured, nil, modified)
	if !got.Equal(captured) || source != "filename" {
		t.Fatalf("got (%v, %q), want filename (%v)", got, source, captured)
	}
}

func TestResolveAlbumDateUsesStrictFolderDate(t *testing.T) {
	modified := time.Date(2025, 1, 2, 0, 0, 0, 0, time.UTC)
	tests := []struct {
		path string
		want string
	}{
		{filepath.Join("library", "2024-08-17"), "2024-08-17"},
		{filepath.Join("library", "20240818"), "2024-08-18"},
		{filepath.Join("library", "2022", "07", "09"), "2022-07-09"},
		{filepath.Join("library", "2021_11"), "2021-11-01"},
	}
	for _, tt := range tests {
		t.Run(tt.want, func(t *testing.T) {
			got, source := resolveAlbumDate(tt.path, time.Time{}, nil, modified)
			if got.Format("2006-01-02") != tt.want || source != "folder" {
				t.Fatalf("got (%v, %q), want (%s, folder)", got, source, tt.want)
			}
		})
	}
}

func TestResolveAlbumDateRejectsEmbeddedOrInvalidDates(t *testing.T) {
	dirModified := time.Date(2020, 2, 3, 0, 0, 0, 0, time.UTC)
	fileModified := time.Date(2021, 4, 5, 0, 0, 0, 0, time.UTC)
	for _, path := range []string{
		filepath.Join("library", "trip-2024-08-17"),
		filepath.Join("library", "2024-02-31"),
	} {
		got, source := resolveAlbumDate(path, time.Time{}, []fileEntry{{modTime: fileModified}}, dirModified)
		if !got.Equal(fileModified) || source != "modified" {
			t.Fatalf("path %q: got (%v, %q), want modified (%v)", path, got, source, fileModified)
		}
	}
}

func TestCaptureFromFileNameReadsCommonCameraNames(t *testing.T) {
	tests := []struct {
		name string
		want string
	}{
		{"IMG_20240101_105902.jpg", "2024-01-01"},
		{"IMG_20240101.jpg", "2024-01-01"},
		{"VID_20230715_221355.mp4", "2023-07-15"},
		{"微信图片_20240629212933.jpg", "2024-06-29"},
		{"2024-01-02.jpg", "2024-01-02"},
		{"2024.1.3.jpg", "2024-01-03"},
		{"2024_10_01_105902.jpg", "2024-10-01"},
		{"国庆2024年10月1日.jpg", "2024-10-01"},
		{"咸鱼之王 bug 推塔 2023-3-4 1-46-44.mp4", "2023-03-04"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := captureFromFileName(tt.name)
			if got.IsZero() {
				t.Fatalf("captureFromFileName(%q) = zero", tt.name)
			}
			if got.Format("2006-01-02") != tt.want {
				t.Fatalf("captureFromFileName(%q) = %v, want %s", tt.name, got, tt.want)
			}
		})
	}
}

func TestCaptureFromFileNameReadsClockWhenPresent(t *testing.T) {
	got := captureFromFileName("IMG_20240101_105902.jpg")
	if got.Hour() != 10 || got.Minute() != 59 || got.Second() != 2 {
		t.Fatalf("clock = %v, want 10:59:02", got)
	}
	// 没有时刻时用当天正午，与目录名日期的口径一致。
	got = captureFromFileName("2024-01-01.jpg")
	if got.Hour() != 12 {
		t.Fatalf("clock = %v, want noon", got)
	}
}

func TestCaptureFromFileNameRejectsNonDates(t *testing.T) {
	for _, name := range []string{
		"photo.jpg",
		"1623724245478.jpg",   // 毫秒时间戳：开头不是 20
		"120240101.jpg",       // 数字串中间的一段不是日期
		"IMG_20241301.jpg",    // 13 月
		"IMG_20240230.jpg",    // 2 月 30 日
		"IMG_2024-01-011.jpg", // 分隔写法后面多一位数字
		"14-24_HN10-8033402445_01.webm",
	} {
		t.Run(name, func(t *testing.T) {
			if got := captureFromFileName(name); !got.IsZero() {
				t.Fatalf("captureFromFileName(%q) = %v, want zero", name, got)
			}
		})
	}
}

func TestAggregateCaptureDatesPicksMostFrequentDay(t *testing.T) {
	files := []fileEntry{
		{path: "a", captured: time.Date(2024, 1, 1, 10, 0, 0, 0, time.UTC)},
		{path: "b", captured: time.Date(2024, 1, 1, 11, 0, 0, 0, time.UTC)},
		{path: "c", captured: time.Date(2024, 5, 20, 10, 0, 0, 0, time.UTC)},
		{path: "d", captured: time.Date(2023, 8, 8, 10, 0, 0, 0, time.UTC)},
	}
	dates, day := aggregateCaptureDates(files)
	if len(dates) != 3 {
		t.Fatalf("dates = %v, want 3 entries", dates)
	}
	if dates[0] != "20230808" || dates[2] != "20240520" {
		t.Fatalf("dates = %v, want sorted", dates)
	}
	if day.Format("2006-01-02") != "2024-01-01" {
		t.Fatalf("day = %v, want 2024-01-01", day)
	}
}

func TestCollectionCaptureDateWeightsByMediaCount(t *testing.T) {
	albums := []models.Album{
		{Date: time.Date(2024, 5, 1, 12, 0, 0, 0, time.UTC), DateSource: "filename", ImageCount: 2},
		{Date: time.Date(2023, 3, 3, 12, 0, 0, 0, time.UTC), DateSource: "filename", ImageCount: 40},
		{Date: time.Date(2022, 1, 1, 12, 0, 0, 0, time.UTC), DateSource: "modified", ImageCount: 99},
	}
	got, ok := collectionCaptureDate(albums, nil)
	if !ok {
		t.Fatal("collectionCaptureDate returned no date")
	}
	if got.Format("2006-01-02") != "2023-03-03" {
		t.Fatalf("date = %v, want 2023-03-03", got)
	}
}
