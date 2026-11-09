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

// 图片头读不出来的文件是坏文件：标成「无法解码」，界面上不画破图图标。
func TestMediaDimensionServiceFlagsUnreadableHeader(t *testing.T) {
	dir := t.TempDir()
	broken := filepath.Join(dir, "broken.jpg")
	if err := os.WriteFile(broken, []byte("not an image at all"), 0o644); err != nil {
		t.Fatal(err)
	}

	service, err := NewMediaDimensionService(filepath.Join(dir, "dimensions.jsonl"))
	if err != nil {
		t.Fatalf("create service: %v", err)
	}
	got := service.Dimensions(broken)
	if !got.Undecodable {
		t.Fatal("读不出图片头的文件应标为无法解码")
	}
	if got.Known() {
		t.Fatalf("坏文件不该有尺寸: %+v", got)
	}

	// 需要转换的格式（HEIC/HEIF/TIFF）不算坏：它们由服务端转换。
	heic := filepath.Join(dir, "photo.heic")
	if err := os.WriteFile(heic, []byte("not an image at all"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := service.Dimensions(heic); got.Undecodable {
		t.Fatal("HEIC 由服务端转换，不该判为坏文件")
	}
}

// 渲染时整张解码失败（头能读、像素数据是截断的）也要标出来，
// 而且标记要跟着文件走：文件被替换后判定作废。
func TestMediaDimensionServiceMarksUndecodable(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "photo.png")
	writeTestPNG(t, path, 40, 30)
	cachePath := filepath.Join(dir, "dimensions.jsonl")

	service, err := NewMediaDimensionService(cachePath)
	if err != nil {
		t.Fatalf("create service: %v", err)
	}
	if got := service.Dimensions(path); got.Undecodable {
		t.Fatal("正常图片不该被标为无法解码")
	}

	service.MarkUndecodable(path)
	got := service.Dimensions(path)
	if !got.Undecodable {
		t.Fatal("补记之后应标为无法解码")
	}
	if got.Width != 40 || got.Height != 30 {
		t.Fatalf("补记不该改掉已知尺寸: %+v", got)
	}

	// 标记要落盘：重启后仍然记得。
	second, err := NewMediaDimensionService(cachePath)
	if err != nil {
		t.Fatalf("recreate service: %v", err)
	}
	if got := second.Dimensions(path); !got.Undecodable {
		t.Fatal("标记应跨实例保留")
	}

	// 文件被替换后重新判定：换了一张好图就不该再标坏。
	writeTestPNG(t, path, 60, 20)
	if got := service.Dimensions(path); got.Undecodable {
		t.Fatal("文件被替换后旧判定应作废")
	}
}
