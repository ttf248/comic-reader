package services

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/disintegration/imaging"
)

func TestThumbnailRenditionWidthsAreIndependent(t *testing.T) {
	svc := newTestService(t)
	src := makeTestImage(t, t.TempDir(), "page.jpg", 128, 128)
	for _, size := range []int{8, 32, 16} {
		data, err := svc.GetOrCreate(src, size)
		if err != nil {
			t.Fatal(err)
		}
		cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil || cfg.Width != size || cfg.Height != size {
			t.Fatalf("size=%d got=%+v err=%v", size, cfg, err)
		}
	}
}

func TestThumbnailConcurrentRenditionsAndClear(t *testing.T) {
	svc := newTestService(t)
	src := makeTestImage(t, t.TempDir(), "page.jpg", 128, 128)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			if err := svc.UpdateOptions(ThumbnailOptions{LRUSize: i + 1}); err != nil {
				t.Error(err)
			}
			if _, _, err := svc.ClearThumbnails(); err != nil {
				t.Error(err)
			}
		}(i)
		go func() {
			defer wg.Done()
			size := 8 + i%2*8
			data, err := svc.GetOrCreate(src, size)
			if err != nil {
				t.Error(err)
				return
			}
			cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
			if err != nil || cfg.Width != cfg.Height || (cfg.Width != 8 && cfg.Width != 16) {
				t.Errorf("inconsistent dimensions: %+v %v", cfg, err)
			}
		}()
	}
	wg.Wait()
}

// makeTestImage 生成指定尺寸的 RGBA 测试图片并保存为 JPEG。
func makeTestImage(t *testing.T, dir, name string, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	// 用简单渐变填充，避免空图被某些编码器压缩为 0 字节
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x % 256), uint8(y % 256), 128, 255})
		}
	}
	path := filepath.Join(dir, name)
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := jpeg.Encode(f, img, &jpeg.Options{Quality: 85}); err != nil {
		t.Fatal(err)
	}
	return path
}

func newTestService(t *testing.T) *ThumbnailService {
	t.Helper()
	// 三类缓存各占一个子目录，和生产环境的 derived 布局一致：
	// 否则预览图目录会落在缩略图目录里，统计磁盘文件数时多出一条。
	root := t.TempDir()
	svc, err := NewThumbnailService(ThumbnailOptions{
		CacheDir:     filepath.Join(root, "thumbnails"),
		ConvertedDir: filepath.Join(root, "converted"),
		PreviewDir:   filepath.Join(root, "previews"),
		MaxAgeDays:   30,
		LRUSize:      100,
	})
	if err != nil {
		t.Fatalf("NewThumbnailService: %v", err)
	}
	return svc
}

// TestResizeToWidthMatchesDirectLanczos 验证「先 Box 预缩放再 Lanczos」
// 与直接 Lanczos 的结果在平滑图像上基本一致。
//
// 预缩放是渲染提速的关键：24MP 原图直接跑 Lanczos 仅缩放一步就要
// 40ms 以上。误差过大说明预缩放参数需要调整。
func TestResizeToWidthMatchesDirectLanczos(t *testing.T) {
	const w, h = 2400, 1800
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			// 平滑的低频渐变：真实照片的局部统计特征更接近这种分布。
			img.Set(x, y, color.RGBA{
				R: uint8(40 + 180*x/w),
				G: uint8(60 + 150*y/h),
				B: uint8((x + y) % 200),
				A: 255,
			})
		}
	}
	direct := imaging.Resize(img, 320, 0, imaging.Lanczos)
	stepped := resizeToWidth(img, 320)
	if direct.Bounds() != stepped.Bounds() {
		t.Fatalf("size mismatch: direct=%v stepped=%v", direct.Bounds(), stepped.Bounds())
	}
	var sum float64
	count := 0
	for y := 0; y < direct.Bounds().Dy(); y++ {
		for x := 0; x < direct.Bounds().Dx(); x++ {
			dr, dg, db, _ := direct.At(x, y).RGBA()
			sr, sg, sb, _ := stepped.At(x, y).RGBA()
			sum += float64(absInt(int(dr)-int(sr)) + absInt(int(dg)-int(sg)) + absInt(int(db)-int(sb)))
			count += 3
		}
	}
	mean := sum / float64(count) / 257.0 // 16bit → 8bit
	if mean > 3 {
		t.Errorf("预缩放与直接 Lanczos 平均误差过大: %.2f (>3/255)", mean)
	}
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// TestDecodePixelWeightUsesImageHeader 验证像素权重取自图片头，
// 且读不到图片头时退回保守的大图权重（宁可少并行也不要打爆内存）。
func TestDecodePixelWeightUsesImageHeader(t *testing.T) {
	dir := t.TempDir()
	src := makeTestImage(t, dir, "big.jpg", 2000, 1500) // 3MP
	weight, oversized, err := decodePixelWeight(src)
	if err != nil {
		t.Fatal(err)
	}
	if weight != 3 {
		t.Errorf("weight=%d, want 3 (2000x1500 = 3MP)", weight)
	}
	if oversized {
		t.Error("3MP 的图不该被判为超预算")
	}

	small := makeTestImage(t, dir, "small.jpg", 100, 100)
	weight, oversized, err = decodePixelWeight(small)
	if err != nil {
		t.Fatal(err)
	}
	if weight != 1 {
		t.Errorf("weight=%d, want 1", weight)
	}
	if oversized {
		t.Error("小图不该被判为超预算")
	}

	// 非图片文件读不到头部：不能报错（解码阶段才给真正的错误），
	// 但要按大图保守处理。
	broken := filepath.Join(dir, "broken.jpg")
	if err := os.WriteFile(broken, []byte("not an image"), 0o644); err != nil {
		t.Fatal(err)
	}
	weight, _, err = decodePixelWeight(broken)
	if err != nil {
		t.Fatalf("读不到图片头不应报错: %v", err)
	}
	if weight != thumbnailUnknownPixelWeight {
		t.Errorf("weight=%d, want %d", weight, thumbnailUnknownPixelWeight)
	}
}

// 超过预算的大图不能进进程内解码：加权信号量的容量就是预算，
// 申请超过容量的权重会永远阻塞，整条渲染链路跟着挂死
// （本机实测：6184×44767 的全景拼接把重建任务卡在最后一项）。
func TestPlanDecodeWeightCapsOversizedImages(t *testing.T) {
	weight, oversized := planDecodeWeight(6184, 44767)
	if !oversized {
		t.Error("277MP 的图应判为超预算")
	}
	if weight > thumbnailDecodePixelBudget {
		t.Errorf("weight=%d 超过预算 %d，Acquire 会永远阻塞", weight, thumbnailDecodePixelBudget)
	}

	// 刚好在预算内的图按真实像素计权重。
	weight, oversized = planDecodeWeight(4000, 4000) // 16MP
	if oversized {
		t.Error("16MP 的图不该被判为超预算")
	}
	if weight != 16 {
		t.Errorf("weight=%d, want 16", weight)
	}
}

// writeFakeJPEGHeader 写一个只带图片头的 JPEG：尺寸是真的，
// 像素数据是假的。用来验证超大图的处理路径，不必真造一张 277MP 的图。
//
// 头里要有 SOI + SOF0 + SOS：image.DecodeConfig 读到 SOS 才返回配置，
// 只给 SOF 会被判成「文件截断」。
func writeFakeJPEGHeader(t *testing.T, path string, width, height int) {
	t.Helper()
	sof := []byte{
		0x08, // 精度
		byte(height >> 8), byte(height),
		byte(width >> 8), byte(width),
		0x03, // 分量数
		0x01, 0x22, 0x00,
		0x02, 0x11, 0x01,
		0x03, 0x11, 0x01,
	}
	sos := []byte{
		0x03,       // 扫描中的分量数
		0x01, 0x00, // 分量 1：选择器 + 霍夫曼表
		0x02, 0x11,
		0x03, 0x11,
		0x00, 0x3F, 0x00, // 谱选择 + 近似 + 逐点
	}
	var buf bytes.Buffer
	buf.Write([]byte{0xFF, 0xD8}) // SOI
	buf.Write([]byte{0xFF, 0xC0}) // SOF0
	buf.Write([]byte{byte((len(sof)+2) >> 8), byte(len(sof) + 2)})
	buf.Write(sof)
	buf.Write([]byte{0xFF, 0xDA}) // SOS
	buf.Write([]byte{byte((len(sos)+2) >> 8), byte(len(sos) + 2)})
	buf.Write(sos)
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

// 超大图（拼接全景）读图片头时就要被认出：它的像素权重超过解码闸门
// 的容量，进程内解码会让 Acquire 永远阻塞。
func TestDecodePixelWeightFlagsOversizedImage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "panorama.jpg")
	writeFakeJPEGHeader(t, path, 6184, 44767)

	weight, oversized, err := decodePixelWeight(path)
	if err != nil {
		t.Fatal(err)
	}
	if !oversized {
		t.Error("277MP 的图应判为超预算")
	}
	if weight > thumbnailDecodePixelBudget {
		t.Errorf("weight=%d 超过预算 %d", weight, thumbnailDecodePixelBudget)
	}
}

func TestCacheKey_StableAndUnique(t *testing.T) {
	now := time.Now()
	k1 := CacheKey("/a/b.jpg", now, 123)
	k2 := CacheKey("/a/b.jpg", now, 123)
	if k1 != k2 {
		t.Errorf("key should be stable, got %s vs %s", k1, k2)
	}
	if CacheKey("/a/b.jpg", now, 124) == k1 {
		t.Errorf("key should differ by size")
	}
	if CacheKey("/a/c.jpg", now, 123) == k1 {
		t.Errorf("key should differ by path")
	}
	if CacheKey("/a/b.jpg", now.Add(time.Second), 123) == k1 {
		t.Errorf("key should differ by mtime")
	}
}

func TestGetOrCreate_GeneratesAndCaches(t *testing.T) {
	svc := newTestService(t)
	src := makeTestImage(t, t.TempDir(), "test.jpg", 800, 600)

	// 第一次：生成
	data1, err := svc.GetOrCreate(src, 320)
	if err != nil {
		t.Fatalf("first GetOrCreate: %v", err)
	}
	if len(data1) == 0 {
		t.Fatal("empty thumbnail data")
	}
	if !isJPEG(data1) {
		t.Error("output should be valid JPEG")
	}

	// 第二次：命中（内存或磁盘），返回相同数据
	data2, err := svc.GetOrCreate(src, 320)
	if err != nil {
		t.Fatalf("second GetOrCreate: %v", err)
	}
	if !bytes.Equal(data1, data2) {
		t.Error("second call should return cached bytes")
	}

	// 磁盘文件存在（.jpg 扩展名）
	entries, _ := os.ReadDir(svc.cacheDir)
	if len(entries) != 1 {
		t.Errorf("expected 1 disk file, got %d", len(entries))
	}
	if !strings.HasSuffix(entries[0].Name(), ".jpg") {
		t.Errorf("disk file should be .jpg, got %q", entries[0].Name())
	}

	// 解码验证尺寸
	img, err := jpeg.Decode(bytes.NewReader(data1))
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() > 320 || img.Bounds().Dy() > 350 {
		t.Errorf("thumbnail too large: %dx%d", img.Bounds().Dx(), img.Bounds().Dy())
	}
}

func TestGetOrCreate_MissingSource(t *testing.T) {
	svc := newTestService(t)
	_, err := svc.GetOrCreate(filepath.Join(t.TempDir(), "nope.jpg"), 320)
	if err != ErrSourceMissing {
		t.Errorf("expected ErrSourceMissing, got %v", err)
	}
}

func TestGetOrCreate_UnsupportedFormat(t *testing.T) {
	svc := newTestService(t)
	// 写一个 .png 后缀但内容是文本
	path := filepath.Join(t.TempDir(), "fake.png")
	os.WriteFile(path, []byte("not an image"), 0o644)
	_, err := svc.GetOrCreate(path, 320)
	if err == nil {
		t.Fatal("expected error for unsupported format")
	}
	if !strings.Contains(err.Error(), "unsupported") &&
		!strings.Contains(err.Error(), "format") {
		t.Errorf("expected format-related error, got: %v", err)
	}
}

func TestGetOrCreate_KeyChangesWithMtime(t *testing.T) {
	svc := newTestService(t)
	src := makeTestImage(t, t.TempDir(), "test.jpg", 400, 300)

	_, err := svc.GetOrCreate(src, 320)
	if err != nil {
		t.Fatal(err)
	}

	// 修改 mtime（模拟文件被覆盖）
	future := time.Now().Add(time.Hour)
	os.Chtimes(src, future, future)

	_, err = svc.GetOrCreate(src, 320)
	if err != nil {
		t.Fatal(err)
	}

	// 磁盘上应该有 2 个不同的缓存文件
	entries, _ := os.ReadDir(svc.cacheDir)
	if len(entries) != 2 {
		t.Errorf("expected 2 disk files after mtime change, got %d", len(entries))
	}
}

func TestCleanup_RemovesOldFiles(t *testing.T) {
	cacheDir := t.TempDir()
	svc, err := NewThumbnailService(ThumbnailOptions{
		CacheDir:   cacheDir,
		MaxAgeDays: 30,
	})
	if err != nil {
		t.Fatal(err)
	}

	// 写入一个"旧"文件
	oldFile := filepath.Join(cacheDir, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg")
	os.WriteFile(oldFile, []byte("x"), 0o644)
	past := time.Now().AddDate(0, 0, -60) // 60 天前
	os.Chtimes(oldFile, past, past)

	// 一个新的
	newFile := filepath.Join(cacheDir, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpg")
	os.WriteFile(newFile, []byte("x"), 0o644)
	unknownOldFile := filepath.Join(cacheDir, "web_settings.json")
	os.WriteFile(unknownOldFile, []byte("{}"), 0o644)
	os.Chtimes(unknownOldFile, past, past)

	n, err := svc.Cleanup()
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("expected to delete 1 file, deleted %d", n)
	}
	if _, err := os.Stat(oldFile); !os.IsNotExist(err) {
		t.Error("old file should be removed")
	}
	if _, err := os.Stat(newFile); err != nil {
		t.Error("new file should remain")
	}
	if _, err := os.Stat(unknownOldFile); err != nil {
		t.Error("old non-thumbnail file should remain")
	}
}

func TestStats(t *testing.T) {
	svc := newTestService(t)
	src := makeTestImage(t, t.TempDir(), "test.jpg", 400, 300)
	svc.GetOrCreate(src, 320)

	stats := svc.Stats()
	if stats.MemoryItems < 1 {
		t.Errorf("expected memory items >= 1, got %d", stats.MemoryItems)
	}
	if stats.DiskFiles < 1 {
		t.Errorf("expected disk files >= 1, got %d", stats.DiskFiles)
	}
	if stats.CacheDir == "" {
		t.Error("CacheDir should be set")
	}
}

// isJPEG 快速校验：JPEG 头 3 字节为 FF D8 FF。
func isJPEG(data []byte) bool {
	return len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF
}

// 视频未抽帧前 GetOrCreate 返回 ErrVideoCoverMissing；
// 源文件不存在时仍按 ErrSourceMissing。
func TestGetOrCreate_VideoCoverMissing(t *testing.T) {
	svc := newTestService(t)
	srcDir := t.TempDir()
	// 写一个空文件占位，扩展名走白名单
	vidPath := filepath.Join(srcDir, "clip.mp4")
	os.WriteFile(vidPath, []byte("fake"), 0o644)

	_, err := svc.GetOrCreate(vidPath, 320)
	if err != ErrVideoCoverMissing {
		t.Errorf("expected ErrVideoCoverMissing, got %v", err)
	}

	// 源视频不存在 → ErrSourceMissing（不是 ErrVideoCoverMissing）
	missing := filepath.Join(srcDir, "nope.mp4")
	_, err = svc.GetOrCreate(missing, 320)
	if err != ErrSourceMissing {
		t.Errorf("expected ErrSourceMissing, got %v", err)
	}
}

// SaveVideoCover 后，GetOrCreate 应命中缓存（返回相同字节）。
func TestSaveVideoCover_AndReadback(t *testing.T) {
	svc := newTestService(t)
	srcDir := t.TempDir()

	vidPath := filepath.Join(srcDir, "clip.mp4")
	os.WriteFile(vidPath, []byte("fake-video-bytes"), 0o644)

	// 准备一张 800x600 的 jpeg 给"前端"上传
	cover := makeTestImage(t, srcDir, "cover.jpg", 800, 600)
	coverBytes, err := os.ReadFile(cover)
	if err != nil {
		t.Fatal(err)
	}

	if err := svc.SaveVideoCover(vidPath, coverBytes); err != nil {
		t.Fatalf("SaveVideoCover: %v", err)
	}

	// 现在 GetOrCreate 应返回 JPEG（不再是 ErrVideoCoverMissing）
	data, err := svc.GetOrCreate(vidPath, 320)
	if err != nil {
		t.Fatalf("GetOrCreate after save: %v", err)
	}
	if !isJPEG(data) {
		t.Error("output should be valid JPEG")
	}
	// 尺寸 ≤ videoCoverMasterWidth 宽
	img, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() > videoCoverMasterWidth {
		t.Errorf("cover too large: %dx%d", img.Bounds().Dx(), img.Bounds().Dy())
	}
}

// SaveVideoCover 对非视频扩展名返回错误（防御性）。
func TestSaveVideoCover_RejectsNonVideo(t *testing.T) {
	svc := newTestService(t)
	imgPath := makeTestImage(t, t.TempDir(), "pic.jpg", 100, 100)
	imgBytes, _ := os.ReadFile(imgPath)
	if err := svc.SaveVideoCover(imgPath, imgBytes); err == nil {
		t.Error("expected error when saving cover to non-video path")
	}
}

// SaveVideoCover 对垃圾数据返回 ErrUnsupportedFormat。
func TestSaveVideoCover_RejectsGarbageData(t *testing.T) {
	svc := newTestService(t)
	srcDir := t.TempDir()
	vidPath := filepath.Join(srcDir, "clip.mp4")
	os.WriteFile(vidPath, []byte("x"), 0o644)
	err := svc.SaveVideoCover(vidPath, []byte("not an image"))
	if err == nil {
		t.Fatal("expected error for garbage cover data")
	}
	if !errors.Is(err, ErrUnsupportedFormat) {
		t.Errorf("expected ErrUnsupportedFormat wrapped, got %v", err)
	}
}

// 视频 mtime 变化后旧封面失效 → 再次 GetOrCreate 返回 ErrVideoCoverMissing。
// 这是"视频被重新剪辑后前端应重新抽帧"的契约。
func TestVideoCover_MtimeInvalidates(t *testing.T) {
	svc := newTestService(t)
	srcDir := t.TempDir()

	vidPath := filepath.Join(srcDir, "clip.mp4")
	os.WriteFile(vidPath, []byte("v1"), 0o644)

	cover := makeTestImage(t, srcDir, "cover.jpg", 200, 200)
	coverBytes, _ := os.ReadFile(cover)
	if err := svc.SaveVideoCover(vidPath, coverBytes); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.GetOrCreate(vidPath, 320); err != nil {
		t.Fatalf("after save, GetOrCreate should succeed: %v", err)
	}

	// 改变视频文件 mtime（模拟视频被重新剪辑）
	future := time.Now().Add(time.Hour)
	os.Chtimes(vidPath, future, future)
	// 改变 size（覆盖内容）让 key 一定变
	os.WriteFile(vidPath, []byte("v2-changed"), 0o644)
	os.Chtimes(vidPath, future, future)

	_, err := svc.GetOrCreate(vidPath, 320)
	if err != ErrVideoCoverMissing {
		t.Errorf("after mtime+size change, expected ErrVideoCoverMissing, got %v", err)
	}
}
