package services

import (
	"bytes"
	"image"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// ffmpegPathForTest 返回测试可用的 ffmpeg 路径。
//
// 仓库不提交二进制，测试按以下顺序找：
//  1. 环境变量 THUMB_TEST_FFMPEG；
//  2. 仓库内 <repo>/bin/ffmpeg/windows/amd64/ffmpeg(.exe)。
//
// 找不到时跳过依赖 ffmpeg 的用例（CI 环境没有 ffmpeg 也能通过）。
func ffmpegPathForTest(t *testing.T) string {
	t.Helper()
	if p := os.Getenv("THUMB_TEST_FFMPEG"); p != "" {
		return p
	}
	exe := "ffmpeg"
	if _, err := os.Stat("/proc/self/exe"); err == nil {
		// 非 Windows
	} else {
		exe = "ffmpeg.exe"
	}
	candidates := []string{
		filepath.Join("..", "..", "bin", "ffmpeg", "windows", "amd64", exe),
		filepath.Join("..", "..", "..", "bin", "ffmpeg", "windows", "amd64", exe),
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	if out, err := exec.LookPath("ffmpeg"); err == nil {
		return out
	}
	return ""
}

// TestImageConverterUnavailableWithoutFFmpeg 验证没有 ffmpeg 时转换器
// 优雅降级，而不是 panic 或报未知错误。
func TestImageConverterUnavailableWithoutFFmpeg(t *testing.T) {
	conv := NewImageConverter(ImageConverterOptions{FFmpegPath: ""})
	if conv.Available() {
		t.Fatal("空 ffmpeg 路径不应报告可用")
	}
	if _, err := conv.Convert("whatever.heic"); err == nil {
		t.Fatal("不可用时应返回错误")
	}
}

// TestImageConverterConvertsHEIC 验证 ffmpeg 能把 HEIC 转成缩略图位图。
//
// 用一张真实 HEIC 样本（需要仓库外的素材）：设置 THUMB_TEST_HEIC
// 指向文件；未设置时跳过。
func TestImageConverterConvertsHEIC(t *testing.T) {
	ffmpeg := ffmpegPathForTest(t)
	if ffmpeg == "" {
		t.Skip("未找到 ffmpeg，跳过 HEIC 转换用例")
	}
	sample := os.Getenv("THUMB_TEST_HEIC")
	if sample == "" {
		t.Skip("设置 THUMB_TEST_HEIC 指向一张真实 HEIC 样本后再跑")
	}
	if _, err := os.Stat(sample); err != nil {
		t.Skipf("HEIC 样本不存在: %v", err)
	}

	conv := NewImageConverter(ImageConverterOptions{
		FFmpegPath: ffmpeg,
		Width:      320,
		Height:     350,
		Quality:    85,
		Timeout:    30_000_000_000,
	})
	if !conv.Available() {
		t.Fatalf("ffmpeg 不可用: %s", ffmpeg)
	}
	img, err := conv.Convert(sample)
	if err != nil {
		t.Fatalf("转换 HEIC 失败: %v", err)
	}
	// 转换器返回的是"解码尺寸"（默认缩略图的两倍），最终缩放由缩略图
	// 服务统一完成，保证与其它格式的输出完全一致。
	if img.Bounds().Dx() > 640 || img.Bounds().Dy() > 700 {
		t.Fatalf("转换结果尺寸超限: %v", img.Bounds())
	}
	if img.Bounds().Dx() == 0 || img.Bounds().Dy() == 0 {
		t.Fatalf("转换结果尺寸为空: %v", img.Bounds())
	}
}

// TestThumbnailServiceFallsBackToConverter 验证缩略图服务在纯 Go 解不了
// 时会走 ffmpeg 转换，而不是直接返回"不支持的格式"。
func TestThumbnailServiceFallsBackToConverter(t *testing.T) {
	ffmpeg := ffmpegPathForTest(t)
	if ffmpeg == "" {
		t.Skip("未找到 ffmpeg，跳过转换回退用例")
	}
	sample := os.Getenv("THUMB_TEST_HEIC")
	if sample == "" {
		t.Skip("设置 THUMB_TEST_HEIC 指向一张真实 HEIC 样本后再跑")
	}

	dir := t.TempDir()
	// 复制样本到临时目录并改成 .heic 扩展名（服务按扩展名判定格式）。
	local := filepath.Join(dir, "sample.heic")
	data, err := os.ReadFile(sample)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(local, data, 0o644); err != nil {
		t.Fatal(err)
	}

	svc, err := NewThumbnailService(ThumbnailOptions{
		CacheDir: filepath.Join(dir, "cache"),
		Width:    320,
		Height:   350,
		ImageConverter: NewImageConverter(ImageConverterOptions{
			FFmpegPath: ffmpeg,
			Width:      320,
			Height:     350,
			Timeout:    30_000_000_000,
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	out, err := svc.GetOrCreate(local)
	if err != nil {
		t.Fatalf("HEIC 缩略图应能生成: %v", err)
	}
	if len(out) == 0 || !isJPEG(out) {
		t.Fatal("HEIC 缩略图应是有效 JPEG")
	}
	// 输出尺寸与其它格式保持一致（不超过缩略图目标尺寸）。
	cfg, _, err := image.DecodeConfig(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Width > 320 || cfg.Height > 350 {
		t.Fatalf("缩略图尺寸超限: %dx%d", cfg.Width, cfg.Height)
	}
}

// TestDecodeImageReportsUnsupportedFormat 验证解不出来的格式统一返回
// ErrUnsupportedFormat（调用方据此决定是否走 ffmpeg 兜底）。
func TestDecodeImageReportsUnsupportedFormat(t *testing.T) {
	dir := t.TempDir()
	heic := filepath.Join(dir, "photo.heic")
	if err := os.WriteFile(heic, []byte("not really an image"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := decodeImage(heic); err != ErrUnsupportedFormat {
		t.Fatalf("HEIC 应返回 ErrUnsupportedFormat, got %v", err)
	}

	broken := filepath.Join(dir, "photo.jpg")
	if err := os.WriteFile(broken, []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := decodeImage(broken); err != ErrUnsupportedFormat {
		t.Fatalf("认不出格式的损坏文件应返回 ErrUnsupportedFormat, got %v", err)
	}
}

// TestGetConvertedImageRequiresConverter 验证没有转换器时整图转换直接
// 返回"不支持的格式"，而不是把原文件（HEIC）当成图片发出去。
func TestGetConvertedImageRequiresConverter(t *testing.T) {
	dir := t.TempDir()
	sample := filepath.Join(dir, "photo.heic")
	if err := os.WriteFile(sample, []byte("not really an image"), 0o644); err != nil {
		t.Fatal(err)
	}
	svc, err := NewThumbnailService(ThumbnailOptions{CacheDir: filepath.Join(dir, "cache")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.GetConvertedImage(sample); err != ErrUnsupportedFormat {
		t.Fatalf("无转换器时应返回 ErrUnsupportedFormat, got %v", err)
	}
}

// TestGetConvertedImageConvertsAndCaches 验证整图转换能产出 JPEG，
// 且第二次访问命中磁盘缓存（不重复调用 ffmpeg）。
func TestGetConvertedImageConvertsAndCaches(t *testing.T) {
	ffmpeg := ffmpegPathForTest(t)
	if ffmpeg == "" {
		t.Skip("未找到 ffmpeg，跳过整图转换用例")
	}
	sample := os.Getenv("THUMB_TEST_HEIC")
	if sample == "" {
		t.Skip("设置 THUMB_TEST_HEIC 指向一张真实 HEIC 样本后再跑")
	}
	if _, err := os.Stat(sample); err != nil {
		t.Skipf("HEIC 样本不存在: %v", err)
	}

	dir := t.TempDir()
	local := filepath.Join(dir, "sample.heic")
	data, err := os.ReadFile(sample)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(local, data, 0o644); err != nil {
		t.Fatal(err)
	}

	cacheDir := filepath.Join(dir, "cache")
	svc, err := NewThumbnailService(ThumbnailOptions{
		CacheDir: cacheDir,
		ImageConverter: NewImageConverter(ImageConverterOptions{
			FFmpegPath: ffmpeg,
			Timeout:    30_000_000_000,
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	out, err := svc.GetConvertedImage(local)
	if err != nil {
		t.Fatalf("整图转换失败: %v", err)
	}
	if len(out) == 0 || !isJPEG(out) {
		t.Fatal("整图转换结果应是有效 JPEG")
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Width > convertedMaxDim || cfg.Height > convertedMaxDim {
		t.Fatalf("整图尺寸超限: %dx%d", cfg.Width, cfg.Height)
	}

	// 磁盘缓存：转换目录里应有一个 jpg。
	entries, err := os.ReadDir(filepath.Join(cacheDir, "converted"))
	if err != nil {
		t.Fatalf("读取转换缓存目录失败: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("转换缓存应有 1 个文件, got %d", len(entries))
	}

	// 第二次访问命中缓存，返回同样的字节。
	again, err := svc.GetConvertedImage(local)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out, again) {
		t.Fatal("缓存命中时应返回同样的字节")
	}
}
