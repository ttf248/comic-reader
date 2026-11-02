package services

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCacheStatsService_Usage_Missing(t *testing.T) {
	svc := NewCacheStatsService(100 * time.Millisecond)
	u, _, err := svc.Usage(filepath.Join(t.TempDir(), "nope"))
	if err != nil {
		t.Fatalf("missing dir should not error, got: %v", err)
	}
	if u.Available {
		t.Error("Available should be false for missing dir")
	}
	if u.TotalBytes != 0 || u.FileCount != 0 {
		t.Errorf("missing dir should be empty, got %+v", u)
	}
}

func TestCacheStatsService_Usage_Basic(t *testing.T) {
	dir := t.TempDir()
	layout, err := EnsureCacheLayout(dir)
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]int{
		"a.txt": 100,
		"b.txt": 200,
		"c.txt": 300,
	}
	for n, sz := range files {
		if err := os.WriteFile(filepath.Join(layout.ThumbnailDir, n), make([]byte, sz), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// 子目录里的文件也应计入
	if err := os.MkdirAll(filepath.Join(layout.DerivedDir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(layout.DerivedDir, "sub", "d.txt"), make([]byte, 50), 0o644); err != nil {
		t.Fatal(err)
	}

	svc := NewCacheStatsService(100 * time.Millisecond)
	u, _, err := svc.Usage(dir)
	if err != nil {
		t.Fatalf("Usage: %v", err)
	}
	if !u.Available {
		t.Error("Available should be true")
	}
	if u.FileCount != 4 {
		t.Errorf("FileCount: got %d want 4", u.FileCount)
	}
	if u.TotalBytes != 650 {
		t.Errorf("TotalBytes: got %d want 650", u.TotalBytes)
	}
}

func TestCacheStatsService_TTL(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	svc := NewCacheStatsService(200 * time.Millisecond)
	u1, exp1, err := svc.Usage(dir)
	if err != nil {
		t.Fatal(err)
	}
	if exp1 == nil {
		t.Fatal("expiresAt should not be nil after first call")
	}
	// 立即再调,应该命中缓存
	u2, exp2, _ := svc.Usage(dir)
	if u2.ScannedAt != u1.ScannedAt {
		t.Errorf("TTL hit: ScannedAt changed: %v vs %v", u1.ScannedAt, u2.ScannedAt)
	}
	if exp2 == nil || !exp2.Equal(*exp1) {
		t.Errorf("expiresAt should be stable within TTL, got %v vs %v", exp1, exp2)
	}
	// 等过期
	time.Sleep(250 * time.Millisecond)
	u3, _, _ := svc.Usage(dir)
	if u3.ScannedAt.Equal(u1.ScannedAt) {
		t.Error("after TTL, ScannedAt should refresh")
	}
}

func TestCacheStatsService_Invalidate(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	svc := NewCacheStatsService(10 * time.Second)
	u1, _, _ := svc.Usage(dir)
	svc.Invalidate()
	// 强制不同时间戳(避免毫秒级碰撞,虽然极小概率)
	time.Sleep(2 * time.Millisecond)
	u2, _, _ := svc.Usage(dir)
	if u2.ScannedAt.Equal(u1.ScannedAt) {
		t.Errorf("after Invalidate, ScannedAt should refresh: u1=%v u2=%v", u1.ScannedAt, u2.ScannedAt)
	}
}

func TestCacheStatsService_PathChange(t *testing.T) {
	// 切换到不同路径时应重算(即使在 TTL 内)
	d1 := t.TempDir()
	d2 := t.TempDir()
	l1, _ := EnsureCacheLayout(d1)
	l2, _ := EnsureCacheLayout(d2)
	os.WriteFile(filepath.Join(l1.ThumbnailDir, "a.txt"), []byte("12345"), 0o644)
	os.WriteFile(filepath.Join(l2.ThumbnailDir, "a.txt"), []byte("1234567890"), 0o644)
	svc := NewCacheStatsService(10 * time.Second)
	u1, _, _ := svc.Usage(d1)
	u2, _, _ := svc.Usage(d2)
	if u1.Path == u2.Path {
		t.Error("different paths should produce different snapshots")
	}
	if u1.TotalBytes == u2.TotalBytes {
		t.Error("different file sizes should produce different totals")
	}
}

// 子目录细分:derived/thumbnails + video-faststart / video-transcode 三类独立统计。
// 验证:
//  1. thumbs:cacheDir 顶层 .jpg,Available=true,bytes/count 与实际相符
//  2. 子目录不存在 → Available=false,bytes/count=0
//  3. 子目录存在 → Available=true,bytes/count 与目录内实际相符
//  4. 顶层 TotalBytes 包含 thumbs + 两个子目录 + 顶层元数据(主 + 三 sub 各自独立)
func TestCacheStatsService_SubDir(t *testing.T) {
	dir := t.TempDir()
	layout, err := EnsureCacheLayout(dir)
	if err != nil {
		t.Fatal(err)
	}
	// 模拟三种缓存各有不同字节数 + 顶层放一个非 jpg 元数据
	mkFile := func(rel string, sz int) {
		full := filepath.Join(dir, rel)
		os.MkdirAll(filepath.Dir(full), 0o755)
		os.WriteFile(full, make([]byte, sz), 0o644)
	}
	mkFile(filepath.Join("derived", "thumbnails", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg"), 1000)
	mkFile(filepath.Join("derived", "thumbnails", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpg"), 2000)
	mkFile(filepath.Join("derived", "video-faststart", "xyz.mp4"), 5000)
	mkFile(filepath.Join("derived", "video-transcode", "pqr.mp4"), 8000)
	mkFile(filepath.Join("state", "prefs.json"), 100)
	_ = layout

	svc := NewCacheStatsService(time.Second)
	u, _, err := svc.Usage(dir)
	if err != nil {
		t.Fatal(err)
	}
	// 只统计 derived 下的 4 个派生文件，state 不属于可清理缓存。
	if u.FileCount != 4 {
		t.Errorf("FileCount: got %d want 4", u.FileCount)
	}
	if u.TotalBytes != 16000 {
		t.Errorf("TotalBytes: got %d want 16000", u.TotalBytes)
	}

	// Thumbs:2 文件 3KB
	if !u.Thumbs.Available {
		t.Error("Thumbs.Available should be true")
	}
	if u.Thumbs.FileCount != 2 || u.Thumbs.Bytes != 3000 {
		t.Errorf("Thumbs: got %+v want 2 files / 3000 bytes", u.Thumbs)
	}

	// VideoFaststart:1 文件 5KB
	if !u.VideoFaststart.Available {
		t.Error("VideoFaststart.Available should be true")
	}
	if u.VideoFaststart.FileCount != 1 || u.VideoFaststart.Bytes != 5000 {
		t.Errorf("VideoFaststart: got %+v want 1 file / 5000 bytes", u.VideoFaststart)
	}

	// VideoTranscode:1 文件 8KB
	if !u.VideoTranscode.Available {
		t.Error("VideoTranscode.Available should be true")
	}
	if u.VideoTranscode.FileCount != 1 || u.VideoTranscode.Bytes != 8000 {
		t.Errorf("VideoTranscode: got %+v want 1 file / 8000 bytes", u.VideoTranscode)
	}
}

// 新布局创建 thumbnails，其他派生目录尚不存在。
func TestCacheStatsService_SubDirMissing(t *testing.T) {
	dir := t.TempDir()
	if _, err := EnsureCacheLayout(dir); err != nil {
		t.Fatal(err)
	}
	svc := NewCacheStatsService(time.Second)
	u, _, err := svc.Usage(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Thumbs:cacheDir 顶层扫描,目录存在 → Available=true,文件数 0
	if !u.Thumbs.Available {
		t.Errorf("Thumbs.Available should be true when cacheDir exists, got false")
	}
	if u.Thumbs.FileCount != 0 || u.Thumbs.Bytes != 0 {
		t.Errorf("Thumbs should be empty in fresh dir, got %+v", u.Thumbs)
	}
	// Faststart / Transcode:子目录不存在 → Available=false
	for name, sub := range map[string]SubUsage{
		"VideoFaststart": u.VideoFaststart,
		"VideoTranscode": u.VideoTranscode,
	} {
		if sub.Available {
			t.Errorf("%s.Available should be false when subdir missing", name)
		}
		if sub.Bytes != 0 || sub.FileCount != 0 {
			t.Errorf("%s should be empty when subdir missing, got %+v", name, sub)
		}
	}
}

// 回归测试:thumbs 只统计 derived/thumbnails 子树。
func TestCacheStatsService_ThumbsDirectory(t *testing.T) {
	dir := t.TempDir()
	layout, err := EnsureCacheLayout(dir)
	if err != nil {
		t.Fatal(err)
	}
	// 三个 jpg,一个 jpeg,一个 png(应被忽略),一个 .json 元数据(应被忽略)
	if err := os.WriteFile(filepath.Join(layout.ThumbnailDir, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg"), make([]byte, 100), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(layout.ThumbnailDir, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpg"), make([]byte, 200), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(layout.ThumbnailDir, "cccccccccccccccccccccccccccccccc.JPG"), make([]byte, 300), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(layout.ThumbnailDir, "thumb.png"), make([]byte, 999), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(layout.ScanCachePath, make([]byte, 50), 0o644); err != nil {
		t.Fatal(err)
	}
	// 子目录里的 jpg(应被忽略,不是顶层;faststart 子目录是合法子目录)
	if err := os.MkdirAll(filepath.Join(layout.DerivedDir, "video-faststart"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(layout.DerivedDir, "video-faststart", "nested.jpg"), make([]byte, 888), 0o644); err != nil {
		t.Fatal(err)
	}

	svc := NewCacheStatsService(100 * time.Millisecond)
	u, _, err := svc.Usage(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !u.Thumbs.Available {
		t.Error("Thumbs.Available should be true")
	}
	if u.Thumbs.FileCount != 3 {
		t.Errorf("Thumbs.FileCount: got %d want 3 (3 .jpg/.jpeg at top level)", u.Thumbs.FileCount)
	}
	if u.Thumbs.Bytes != 600 {
		t.Errorf("Thumbs.Bytes: got %d want 600 (100+200+300)", u.Thumbs.Bytes)
	}
	// video-faststart 下的 nested.jpg 不应泄漏进 thumbnails 统计。
	if u.Thumbs.FileCount != 3 {
		t.Errorf("nested.jpg leaked into thumbs.FileCount: %+v", u.Thumbs)
	}
}

// 整图转换缓存(HEIC/HEIF/TIFF → JPEG)必须单独统计。
//
// 它单张可达 MB 级,和缩略图混在一起时,设置页的细分之和会与总占用对不上,
// 用户既看不到大头在哪,也没法只清这一类。
func TestCacheStatsService_ConvertedSubDir(t *testing.T) {
	dir := t.TempDir()
	if _, err := EnsureCacheLayout(dir); err != nil {
		t.Fatal(err)
	}
	converted := filepath.Join(dir, "derived", "converted", "0123456789abcdef0123456789abcdef.jpg")
	if err := os.WriteFile(converted, make([]byte, 4096), 0o644); err != nil {
		t.Fatal(err)
	}
	thumb := filepath.Join(dir, "derived", "thumbnails", "fedcba9876543210fedcba9876543210.jpg")
	if err := os.WriteFile(thumb, make([]byte, 1000), 0o644); err != nil {
		t.Fatal(err)
	}

	svc := NewCacheStatsService(time.Second)
	u, _, err := svc.Usage(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !u.Converted.Available {
		t.Error("Converted.Available should be true")
	}
	if u.Converted.FileCount != 1 || u.Converted.Bytes != 4096 {
		t.Errorf("Converted: got %+v want 1 file / 4096 bytes", u.Converted)
	}
	// 各细分之和必须等于总占用，否则设置页展示的细分对不上总数。
	sum := u.Thumbs.Bytes + u.Converted.Bytes + u.VideoFaststart.Bytes + u.VideoTranscode.Bytes
	if sum != u.TotalBytes {
		t.Errorf("细分之和=%d, totalBytes=%d, want equal", sum, u.TotalBytes)
	}
}
