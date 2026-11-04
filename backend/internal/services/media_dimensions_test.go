package services

import (
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func writeTestPNG(t *testing.T, path string, width, height int) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x % 255), G: uint8(y % 255), B: 40, A: 255})
		}
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("create %s: %v", path, err)
	}
	defer file.Close()
	if err := png.Encode(file, img); err != nil {
		t.Fatalf("encode %s: %v", path, err)
	}
}

func TestMediaDimensionServiceReadsImageHeader(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wide.png")
	writeTestPNG(t, path, 120, 40)

	service, err := NewMediaDimensionService(filepath.Join(t.TempDir(), "dimensions.jsonl"))
	if err != nil {
		t.Fatalf("create service: %v", err)
	}
	dimensions := service.Dimensions(path)
	if dimensions.Width != 120 || dimensions.Height != 40 {
		t.Fatalf("dimensions = %dx%d, want 120x40", dimensions.Width, dimensions.Height)
	}
	if !dimensions.Known() {
		t.Fatal("dimensions should be known")
	}
	if ratio := dimensions.Ratio(); ratio < 2.9 || ratio > 3.1 {
		t.Fatalf("ratio = %v, want ~3", ratio)
	}
}

func TestMediaDimensionServiceCachesAcrossInstances(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tall.png")
	writeTestPNG(t, path, 30, 90)
	cachePath := filepath.Join(dir, "dimensions.jsonl")

	first, err := NewMediaDimensionService(cachePath)
	if err != nil {
		t.Fatalf("create service: %v", err)
	}
	if got := first.Dimensions(path); got.Height != 90 {
		t.Fatalf("height = %d, want 90", got.Height)
	}

	second, err := NewMediaDimensionService(cachePath)
	if err != nil {
		t.Fatalf("recreate service: %v", err)
	}
	if got := second.Dimensions(path); got.Width != 30 || got.Height != 90 {
		t.Fatalf("cached dimensions = %dx%d, want 30x90", got.Width, got.Height)
	}
}

func TestMediaDimensionServiceIgnoresMissingFile(t *testing.T) {
	service, err := NewMediaDimensionService(filepath.Join(t.TempDir(), "dimensions.jsonl"))
	if err != nil {
		t.Fatalf("create service: %v", err)
	}
	if got := service.Dimensions(filepath.Join(t.TempDir(), "missing.png")); got.Known() {
		t.Fatalf("expected unknown dimensions, got %+v", got)
	}
}

func TestMediaDimensionServiceRefreshesChangedFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "photo.png")
	writeTestPNG(t, path, 100, 50)

	service, err := NewMediaDimensionService(filepath.Join(dir, "dimensions.jsonl"))
	if err != nil {
		t.Fatalf("create service: %v", err)
	}
	if got := service.Dimensions(path); got.Width != 100 {
		t.Fatalf("width = %d, want 100", got.Width)
	}

	writeTestPNG(t, path, 20, 80)
	got := service.Dimensions(path)
	if got.Width != 20 || got.Height != 80 {
		t.Fatalf("dimensions after replace = %dx%d, want 20x80", got.Width, got.Height)
	}
}
