package services

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

// newPreviewService 构造带独立预览目录的服务。
func newPreviewService(t *testing.T) (*ThumbnailService, string) {
	t.Helper()
	root := t.TempDir()
	svc, err := NewThumbnailService(ThumbnailOptions{
		CacheDir:     filepath.Join(root, "thumbs"),
		ConvertedDir: filepath.Join(root, "converted"),
		PreviewDir:   filepath.Join(root, "previews"),
		Width:        320,
		Height:       350,
		MaxAgeDays:   30,
		LRUSize:      100,
	})
	if err != nil {
		t.Fatalf("NewThumbnailService: %v", err)
	}
	return svc, filepath.Join(root, "previews")
}

// TestPreviewScalesDownToRequestedWidth 验证预览图按请求宽度等比缩放。
func TestPreviewScalesDownToRequestedWidth(t *testing.T) {
	svc, previewDir := newPreviewService(t)
	src := makeTestImage(t, t.TempDir(), "page.jpg", 800, 400)

	preview, err := svc.GetOrCreatePreview(src, 400)
	if err != nil {
		t.Fatalf("GetOrCreatePreview: %v", err)
	}
	if preview.ContentType != "image/jpeg" {
		t.Fatalf("content type = %q", preview.ContentType)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(preview.Data))
	if err != nil {
		t.Fatalf("decode preview: %v", err)
	}
	if cfg.Width != 400 || cfg.Height != 200 {
		t.Fatalf("preview size = %dx%d, want 400x200", cfg.Width, cfg.Height)
	}

	// 磁盘缓存：同一份预览应落到 previews 目录里。
	entries, err := os.ReadDir(previewDir)
	if err != nil {
		t.Fatalf("read preview dir: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("preview cache files = %d, want 1", len(entries))
	}

	// 再取一次应命中缓存（内容一致）。
	again, err := svc.GetOrCreatePreview(src, 400)
	if err != nil {
		t.Fatalf("GetOrCreatePreview (cached): %v", err)
	}
	if !bytes.Equal(again.Data, preview.Data) {
		t.Fatal("cached preview differs from generated one")
	}
	if again.ETag != preview.ETag {
		t.Fatalf("etag changed between calls: %q vs %q", again.ETag, preview.ETag)
	}
}

// TestPreviewKeepsOriginalWhenNarrower 验证源图比目标宽度还窄时直接复用原图。
//
// 这种情况下再缩放只会白白损失画质，重新编码也纯属浪费 CPU。
func TestPreviewKeepsOriginalWhenNarrower(t *testing.T) {
	svc, _ := newPreviewService(t)
	src := makeTestImage(t, t.TempDir(), "page.jpg", 200, 100)

	preview, err := svc.GetOrCreatePreview(src, 1600)
	if err != nil {
		t.Fatalf("GetOrCreatePreview: %v", err)
	}
	original, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(preview.Data, original) {
		t.Fatal("narrow source was re-encoded instead of reused")
	}
}

// TestPreviewWidthIsClamped 验证请求宽度被夹在允许范围内。
func TestPreviewWidthIsClamped(t *testing.T) {
	svc, _ := newPreviewService(t)
	src := makeTestImage(t, t.TempDir(), "page.jpg", 800, 400)

	tooSmall, err := svc.GetOrCreatePreview(src, 1)
	if err != nil {
		t.Fatalf("GetOrCreatePreview: %v", err)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(tooSmall.Data))
	if err != nil {
		t.Fatalf("decode preview: %v", err)
	}
	if cfg.Width != previewMinWidth {
		t.Fatalf("clamped width = %d, want %d", cfg.Width, previewMinWidth)
	}

	tooBig, err := svc.GetOrCreatePreview(src, previewMaxWidth*4)
	if err != nil {
		t.Fatalf("GetOrCreatePreview: %v", err)
	}
	cfg2, _, err := image.DecodeConfig(bytes.NewReader(tooBig.Data))
	if err != nil {
		t.Fatalf("decode preview: %v", err)
	}
	if cfg2.Width != 800 {
		t.Fatalf("width = %d, want 800 (source is narrower, no upscale)", cfg2.Width)
	}
}

// TestPreviewDistinctWidthsUseDistinctCacheEntries 验证不同宽度各存一份缓存。
func TestPreviewDistinctWidthsUseDistinctCacheEntries(t *testing.T) {
	svc, previewDir := newPreviewService(t)
	src := makeTestImage(t, t.TempDir(), "page.jpg", 800, 400)

	for _, width := range []int{320, 640} {
		if _, err := svc.GetOrCreatePreview(src, width); err != nil {
			t.Fatalf("GetOrCreatePreview(%d): %v", width, err)
		}
	}
	entries, err := os.ReadDir(previewDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("preview cache files = %d, want 2", len(entries))
	}
}

// TestPreviewMissingSource 验证源文件缺失时返回可识别的错误。
func TestPreviewMissingSource(t *testing.T) {
	svc, _ := newPreviewService(t)
	_, err := svc.GetOrCreatePreview(filepath.Join(t.TempDir(), "nope.jpg"), 800)
	if err != ErrSourceMissing {
		t.Fatalf("err = %v, want ErrSourceMissing", err)
	}
}

// TestPreviewFlattensTransparencyOnWhite 验证带 alpha 的 PNG 压到白底。
//
// JPEG 没有 alpha 通道，直接编码会让透明区域变成黑块。
func TestPreviewFlattensTransparencyOnWhite(t *testing.T) {
	svc, _ := newPreviewService(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "transparent.png")
	img := image.NewNRGBA(image.Rect(0, 0, 40, 20))
	// 全透明：压到白底后应是白色，而不是黑色。
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(f, img); err != nil {
		f.Close()
		t.Fatal(err)
	}
	f.Close()

	preview, err := svc.GetOrCreatePreview(path, 20)
	if err != nil {
		t.Fatalf("GetOrCreatePreview: %v", err)
	}
	decoded, _, err := image.Decode(bytes.NewReader(preview.Data))
	if err != nil {
		t.Fatalf("decode preview: %v", err)
	}
	r, g, b, _ := decoded.At(0, 0).RGBA()
	if r < 0xF000 || g < 0xF000 || b < 0xF000 {
		t.Fatalf("transparent pixel became %d,%d,%d, want near-white", r, g, b)
	}
}

// TestClearPreviewsRemovesOnlyPreviews 验证清理预览图不影响其它缓存。
func TestClearPreviewsRemovesOnlyPreviews(t *testing.T) {
	svc, previewDir := newPreviewService(t)
	src := makeTestImage(t, t.TempDir(), "page.jpg", 800, 400)
	if _, err := svc.GetOrCreatePreview(src, 400); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.GetOrCreate(src); err != nil {
		t.Fatal(err)
	}

	deleted, freed, err := svc.ClearPreviews()
	if err != nil {
		t.Fatalf("ClearPreviews: %v", err)
	}
	if deleted != 1 || freed <= 0 {
		t.Fatalf("deleted=%d freed=%d, want 1 file with freed>0", deleted, freed)
	}
	entries, err := os.ReadDir(previewDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("preview dir still has %d files", len(entries))
	}
	// 缩略图缓存不受影响。
	if _, err := svc.GetOrCreate(src); err != nil {
		t.Fatalf("thumbnail broken after ClearPreviews: %v", err)
	}
}

// 确认白底合成不会把不透明像素改色。
func TestPreviewKeepsOpaquePixels(t *testing.T) {
	svc, _ := newPreviewService(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "opaque.png")
	img := image.NewNRGBA(image.Rect(0, 0, 40, 20))
	for y := 0; y < 20; y++ {
		for x := 0; x < 40; x++ {
			img.Set(x, y, color.NRGBA{R: 200, G: 30, B: 40, A: 255})
		}
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(f, img); err != nil {
		f.Close()
		t.Fatal(err)
	}
	f.Close()

	preview, err := svc.GetOrCreatePreview(path, 40)
	if err != nil {
		t.Fatal(err)
	}
	decoded, _, err := image.Decode(bytes.NewReader(preview.Data))
	if err != nil {
		t.Fatal(err)
	}
	r, g, b, _ := decoded.At(10, 10).RGBA()
	if r < 0xC000 || g > 0x4000 || b > 0x4000 {
		t.Fatalf("opaque pixel changed to %d,%d,%d", r, g, b)
	}
}
