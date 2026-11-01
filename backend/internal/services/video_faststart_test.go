package services

import (
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// findFFmpegFaststart 与 video_cover_test 的 findFFmpeg 同源;
// 保留独立函数避免测试间相互依赖(findFFmpeg 在其它 *_test.go 也有使用)。
func findFFmpegFaststart(t *testing.T) string {
	t.Helper()
	if p := os.Getenv("FFMPEG_PATH"); p != "" {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	// 与 video_cover_test.findFFmpeg 的候选顺序保持一致
	candidates := []string{
		"../../../../bin/ffmpeg/windows/amd64/ffmpeg.exe",
		"../../../bin/ffmpeg/windows/amd64/ffmpeg.exe",
		"../../bin/ffmpeg/windows/amd64/ffmpeg.exe",
		"/usr/bin/ffmpeg",
		"/usr/local/bin/ffmpeg",
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			abs, _ := filepath.Abs(c)
			return abs
		}
	}
	t.Skip("ffmpeg not found; skipping faststart-dependent tests")
	return ""
}

// generateNonFaststartMP4 生成一个"moov 在末尾"的 MP4 源文件,模拟常见的
// 录屏/手机录制产生的非 faststart 视频。返回路径(在 t.TempDir 中)。
func generateNonFaststartMP4(t *testing.T, ffmpegPath string) string {
	t.Helper()
	dir := t.TempDir()
	// 先写到中间文件,再用 -movflags -faststart(显式关掉)再 remux 一次
	// 让 moov 落到文件末尾
	intermediate := filepath.Join(dir, "intermediate.mp4")
	cmd := exec.Command(ffmpegPath,
		"-y", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=blue:s=160x120:d=1:r=25",
		"-c:v", "libx264", "-pix_fmt", "yuv420p",
		intermediate,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("gen intermediate: %v\n%s", err, out)
	}
	nonFast := filepath.Join(dir, "non-faststart.mp4")
	cmd = exec.Command(ffmpegPath,
		"-y", "-hide_banner", "-loglevel", "error",
		"-i", intermediate,
		"-c", "copy",
		"-movflags", "-faststart", // 显式关掉 faststart
		nonFast,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("gen non-faststart: %v\n%s", err, out)
	}
	// 验证:确认 moov 真的在末尾
	if isFaststart(nonFast) {
		t.Fatalf("test setup: expected non-faststart output, but isFaststart()=true")
	}
	return nonFast
}

// generateFaststartMP4 生成一个标准的 faststart MP4(moov 在前)。
// 用于"已是 faststart 不需要重封装"路径的测试。
func generateFaststartMP4(t *testing.T, ffmpegPath string) string {
	t.Helper()
	dir := t.TempDir()
	out := filepath.Join(dir, "fast.mp4")
	cmd := exec.Command(ffmpegPath,
		"-y", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=green:s=160x120:d=1:r=25",
		"-c:v", "libx264", "-pix_fmt", "yuv420p",
		"-movflags", "+faststart",
		out,
	)
	if outBytes, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("gen faststart: %v\n%s", err, outBytes)
	}
	if !isFaststart(out) {
		t.Fatalf("test setup: expected faststart output, but isFaststart()=false")
	}
	return out
}

func TestVideoFaststartService_Available(t *testing.T) {
	ff := findFFmpegFaststart(t)
	s := NewVideoFaststartService(FaststartOptions{FFmpeg: ff})
	if !s.Available() {
		t.Errorf("expected Available()=true with valid ffmpeg")
	}

	s2 := NewVideoFaststartService(FaststartOptions{FFmpeg: ""})
	if s2.Available() {
		t.Errorf("expected Available()=false with empty ffmpeg")
	}

	s3 := NewVideoFaststartService(FaststartOptions{FFmpeg: "/no/such/ffmpeg.exe"})
	if s3.Available() {
		t.Errorf("expected Available()=false with nonexistent ffmpeg")
	}
}

func TestVideoFaststartService_Resolve_NilReceiver(t *testing.T) {
	var s *VideoFaststartService
	got, status := s.Resolve("/some/path.mp4", nil)
	if got != "/some/path.mp4" {
		t.Errorf("nil receiver should return original path, got %q", got)
	}
	if status != StatusFallback {
		t.Errorf("nil receiver status = %v, want Fallback", status)
	}
}

func TestVideoFaststartService_Resolve_NonMP4_Skipped(t *testing.T) {
	ff := findFFmpegFaststart(t)
	dir := t.TempDir()
	s := NewVideoFaststartService(FaststartOptions{CacheDir: dir, FFmpeg: ff})
	for _, ext := range []string{".mkv", ".webm", ".avi", ".mov", ".jpg"} {
		path := "/some/file" + ext
		got, status := s.Resolve(path, nil)
		if got != path {
			t.Errorf("ext=%s: got path=%q, want original", ext, got)
		}
		if status != StatusSkipped {
			t.Errorf("ext=%s: status=%v, want Skipped", ext, status)
		}
	}
}

func TestVideoFaststartService_Resolve_NoFFmpeg_Fallback(t *testing.T) {
	dir := t.TempDir()
	// 不用 ffmpeg(ffmpeg="" 时 Available()=false)
	s := NewVideoFaststartService(FaststartOptions{CacheDir: dir, FFmpeg: ""})
	path := filepath.Join(dir, "any.mp4")
	os.WriteFile(path, []byte("not a real mp4"), 0o644)
	got, status := s.Resolve(path, nil)
	if got != path || status != StatusFallback {
		t.Errorf("no ffmpeg: got (%q, %v), want (orig, Fallback)", got, status)
	}
}

func TestVideoFaststartService_Resolve_SourceMissing_Fallback(t *testing.T) {
	ff := findFFmpegFaststart(t)
	dir := t.TempDir()
	s := NewVideoFaststartService(FaststartOptions{CacheDir: dir, FFmpeg: ff})
	got, status := s.Resolve(filepath.Join(dir, "ghost.mp4"), nil)
	if got == "" || status != StatusFallback {
		t.Errorf("missing source: got (%q, %v), want (orig, Fallback)", got, status)
	}
}

func TestVideoFaststartService_Resolve_AlreadyFaststart(t *testing.T) {
	ff := findFFmpegFaststart(t)
	dir := t.TempDir()
	s := NewVideoFaststartService(FaststartOptions{CacheDir: dir, FFmpeg: ff})
	src := generateFaststartMP4(t, ff)
	got, status := s.Resolve(src, nil)
	if got != src {
		t.Errorf("faststart source: got %q, want original (no cache write)", got)
	}
	if status != StatusFast {
		t.Errorf("faststart source: status=%v, want Fast", status)
	}
	// 关键不变量:不应在 cacheDir 下写任何文件
	entries, _ := os.ReadDir(filepath.Join(dir, "video-faststart"))
	if len(entries) != 0 {
		t.Errorf("faststart source should not write cache, got %d entries", len(entries))
	}
}

func TestVideoFaststartService_Resolve_NonFaststart_RemuxedAndCached(t *testing.T) {
	ff := findFFmpegFaststart(t)
	dir := t.TempDir()
	s := NewVideoFaststartService(FaststartOptions{CacheDir: dir, FFmpeg: ff})
	src := generateNonFaststartMP4(t, ff)

	// 第一次:应 remux
	got, status := s.Resolve(src, nil)
	if status != StatusRemuxed {
		t.Fatalf("first resolve: status=%v, want Remuxed", status)
	}
	if got == src {
		t.Errorf("first resolve: should return cached path, not original")
	}
	if !isFaststart(got) {
		t.Errorf("cached file is not faststart: %s", got)
	}

	// 缓存文件应存在
	if _, err := os.Stat(got); err != nil {
		t.Errorf("cached file not found: %v", err)
	}

	// 第二次:应命中缓存(仍 Remuxed,但路径不变)
	got2, status2 := s.Resolve(src, nil)
	if status2 != StatusRemuxed {
		t.Errorf("second resolve: status=%v, want Remuxed (cache hit)", status2)
	}
	if got2 != got {
		t.Errorf("second resolve: path=%q, want %q (cache hit)", got2, got)
	}
}

// fsCache 记录 (path, mtime, size) → isFaststart 的结果;
// 改 mtime 后缓存 key 变化,新一次 Resolve 必须重新走 isFaststart 逻辑。
// 这是 fsCache 设计契约:缓存不能跨"文件被覆盖"沿用。
func TestVideoFaststartService_FsCacheInvalidatesOnMtime(t *testing.T) {
	ff := findFFmpegFaststart(t)
	dir := t.TempDir()
	s := NewVideoFaststartService(FaststartOptions{CacheDir: dir, FFmpeg: ff})

	// 用一个 faststart 文件,Resolve 会命中 fsCache=true 路径
	src := generateFaststartMP4(t, ff)
	got, status := s.Resolve(src, nil)
	if status != StatusFast || got != src {
		t.Fatalf("first: got=%q status=%v, want (src, Fast)", got, status)
	}

	// fsCache 现在应该有 (src, mtime, size) → true
	k := faststartCacheKey(src, mustStat(t, src).ModTime(), mustStat(t, src).Size())
	if v, ok := s.fsCache.Load(k); !ok || v.(bool) != true {
		t.Errorf("expected fsCache hit for %s → true, got ok=%v v=%v", k, ok, v)
	}

	// 改 mtime(模拟源文件被重写),fsCache key 跟着变 → 旧条目应被孤立
	future := time.Now().Add(2 * time.Hour)
	if err := os.Chtimes(src, future, future); err != nil {
		t.Fatal(err)
	}
	oldKey := k
	_ = oldKey
	if _, ok := s.fsCache.Load(oldKey); !ok {
		// 注意:旧 key 在 Store 时已经写过;但下次 Resolve 派生的是新 key。
		// 验证"新 key 还没存"也等价于"fsCache 没沿用旧结果"。
		t.Logf("old fsCache key evicted (acceptable: bounded map cleared)")
	}
	newKey := faststartCacheKey(src, future, mustStat(t, src).Size())
	if newKey == oldKey {
		t.Fatalf("fsCache key should change when mtime changes, both = %s", newKey)
	}

	// 重新 Resolve → 用新 key;文件还是 faststart(只改 mtime,内容没变),
	// isFaststart 应仍为 true,但走的是新的 fsCache 条目。
	got2, status2 := s.Resolve(src, nil)
	if status2 != StatusFast {
		t.Errorf("after mtime change: status=%v, want Fast", status2)
	}
	if got2 != src {
		t.Errorf("after mtime change: got=%q, want src", got2)
	}
}

// mustStat 方便测试里多次取 stat 不写一堆 err 检查。
func mustStat(t *testing.T, p string) os.FileInfo {
	t.Helper()
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	return fi
}

func TestVideoFaststartService_Resolve_InvalidatesOnMtimeChange(t *testing.T) {
	ff := findFFmpegFaststart(t)
	dir := t.TempDir()
	s := NewVideoFaststartService(FaststartOptions{CacheDir: dir, FFmpeg: ff})
	src := generateNonFaststartMP4(t, ff)

	// 第一次 remux
	got1, status1 := s.Resolve(src, nil)
	if status1 != StatusRemuxed {
		t.Fatalf("first: status=%v, want Remuxed", status1)
	}
	oldCache := got1

	// 修改 mtime 模拟"源文件被覆盖/重编码"
	future := time.Now().Add(2 * time.Hour)
	if err := os.Chtimes(src, future, future); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	// 第二次:cache key 变了,应重新 remux,旧缓存孤立但不影响正确性
	got2, status2 := s.Resolve(src, nil)
	if status2 != StatusRemuxed {
		t.Errorf("after mtime change: status=%v, want Remuxed", status2)
	}
	if got2 == oldCache {
		t.Errorf("after mtime change: should produce new cache, got same %q", got2)
	}
}

func TestVideoFaststartService_Resolve_CorruptCacheRebuilds(t *testing.T) {
	ff := findFFmpegFaststart(t)
	dir := t.TempDir()
	s := NewVideoFaststartService(FaststartOptions{CacheDir: dir, FFmpeg: ff})
	src := generateNonFaststartMP4(t, ff)

	// 第一次:正常 remux 出缓存
	got1, status1 := s.Resolve(src, nil)
	if status1 != StatusRemuxed {
		t.Fatalf("first: status=%v, want Remuxed", status1)
	}

	// 把缓存文件清空(模拟"半截写入的损坏缓存")
	if err := os.Truncate(got1, 0); err != nil {
		t.Fatalf("truncate: %v", err)
	}

	// 空文件不得作为命中返回，应重新生成完整的 faststart 缓存。
	got2, status2 := s.Resolve(src, nil)
	if got2 != got1 || status2 != StatusRemuxed || mustStat(t, got2).Size() == 0 || !isFaststart(got2) {
		t.Fatalf("empty cache was not rebuilt: path=%q status=%v", got2, status2)
	}
	entries, err := os.ReadDir(filepath.Dir(got2))
	if err != nil || len(entries) != 1 {
		t.Fatalf("remux left temporary files: entries=%v err=%v", entries, err)
	}
}

func TestVideoFaststartService_Resolve_DirectoryCacheFallsBack(t *testing.T) {
	ff := findFFmpegFaststart(t)
	s := NewVideoFaststartService(FaststartOptions{CacheDir: t.TempDir(), FFmpeg: ff})
	src := generateNonFaststartMP4(t, ff)
	fi := mustStat(t, src)
	cachePath := filepath.Join(s.cacheDir, "video-faststart", faststartKey(src, fi.ModTime(), fi.Size())+".mp4")
	if err := os.MkdirAll(cachePath, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(cachePath, "index.html")
	if err := os.WriteFile(marker, []byte("preserve-directory-content"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, status := s.Resolve(src, fi)
	if got != src || status != StatusFallback {
		t.Errorf("directory cache: path=%q status=%v, want source fallback", got, status)
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "preserve-directory-content" {
		t.Fatalf("invalid cache directory was modified: data=%q err=%v", data, err)
	}
}

func TestVideoCacheLinksAreNotHits(t *testing.T) {
	ff := findFFmpegFaststart(t)
	src := generateFaststartMP4(t, ff)
	cache := t.TempDir()
	foreign := filepath.Join(t.TempDir(), "foreign.mp4")
	if err := os.WriteFile(foreign, []byte("foreign-cache-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	fi := mustStat(t, src)
	faststart := NewVideoFaststartService(FaststartOptions{CacheDir: cache, FFmpeg: ff})
	transcode := NewTranscodeService(TranscodeOptions{CacheDir: cache, FFmpeg: ff})
	for _, cachePath := range []string{
		filepath.Join(cache, "video-faststart", faststartKey(src, fi.ModTime(), fi.Size())+".mp4"),
		transcode.cachePathFor(transcode.cacheKey(src, fi)),
	} {
		if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(foreign, cachePath); err != nil {
			t.Skipf("file symlinks unavailable: %v", err)
		}
	}
	if path, status := faststart.Resolve(src, fi); path != src || status != StatusFast {
		t.Errorf("faststart followed cache link: path=%q status=%v", path, status)
	}
	if info := transcode.GetStatus(src); info.Status != TranscodeStatusFailed {
		t.Errorf("transcode accepted cache link: %+v", info)
	}
	if data, err := os.ReadFile(foreign); err != nil || string(data) != "foreign-cache-bytes" {
		t.Fatalf("cache link target was modified: data=%q err=%v", data, err)
	}
}

func TestVideoFaststartService_StatsCounters(t *testing.T) {
	ff := findFFmpegFaststart(t)
	dir := t.TempDir()
	s := NewVideoFaststartService(FaststartOptions{CacheDir: dir, FFmpeg: ff})

	// 1 次 Skipped
	s.Resolve("/some/file.mkv", nil)
	// 1 次 Fallback(不存在的 mp4)
	s.Resolve(filepath.Join(dir, "ghost.mp4"), nil)
	// 1 次 Fast
	fast := generateFaststartMP4(t, ff)
	s.Resolve(fast, nil)
	// 1 次 Remuxed(非 faststart)
	nonFast := generateNonFaststartMP4(t, ff)
	s.Resolve(nonFast, nil)

	skipped, fastN, remuxed, fallback := s.Stats()
	if skipped != 1 || fastN != 1 || remuxed != 1 || fallback != 1 {
		t.Errorf("stats: skipped=%d fast=%d remuxed=%d fallback=%d, want all 1",
			skipped, fastN, remuxed, fallback)
	}
}

func TestVideoFaststartService_ConcurrentSafe(t *testing.T) {
	ff := findFFmpegFaststart(t)
	dir := t.TempDir()
	s := NewVideoFaststartService(FaststartOptions{CacheDir: dir, FFmpeg: ff})
	src := generateNonFaststartMP4(t, ff)

	// 10 个协程同时触发 Resolve,singleflight 应确保 ffmpeg 只跑一次
	var wg sync.WaitGroup
	results := make([]string, 10)
	statuses := make([]FaststartStatus, 10)
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], statuses[i] = s.Resolve(src, nil)
		}(i)
	}
	wg.Wait()

	// 所有结果应是同一个缓存文件(StatusRemuxed)
	for i, st := range statuses {
		if st != StatusRemuxed {
			t.Errorf("goroutine %d: status=%v, want Remuxed", i, st)
		}
		if results[i] != results[0] {
			t.Errorf("goroutine %d: path=%q differs from %q", i, results[i], results[0])
		}
	}
}

func TestIsFaststart_DetectsCorrectly(t *testing.T) {
	ff := findFFmpegFaststart(t)

	fast := generateFaststartMP4(t, ff)
	if !isFaststart(fast) {
		t.Error("expected isFaststart=true for faststart file")
	}

	nonFast := generateNonFaststartMP4(t, ff)
	if isFaststart(nonFast) {
		t.Error("expected isFaststart=false for non-faststart file")
	}
}

func TestContainsAtom(t *testing.T) {
	// 构造一个 16 字节的 box 序列:[size=8][type="ftyp"] [size=8][type="moov"]
	boxes := []byte{
		0, 0, 0, 8, 'f', 't', 'y', 'p',
		0, 0, 0, 8, 'm', 'o', 'o', 'v',
	}
	if !containsAtom(boxes, "moov") {
		t.Error("containsAtom failed to find moov")
	}
	if !containsAtom(boxes, "ftyp") {
		t.Error("containsAtom failed to find ftyp")
	}
	if containsAtom(boxes, "mdat") {
		t.Error("containsAtom should not find mdat")
	}
}

func TestVideoFaststartService_ClearCache(t *testing.T) {
	ff := findFFmpegFaststart(t)
	dir := t.TempDir()
	s := NewVideoFaststartService(FaststartOptions{CacheDir: dir, FFmpeg: ff})
	src := generateNonFaststartMP4(t, ff)
	s.Resolve(src, nil)

	// 缓存目录应该有文件
	entries, _ := os.ReadDir(filepath.Join(dir, "video-faststart"))
	if len(entries) == 0 {
		t.Fatal("expected cache files after resolve")
	}

	deleted, freed, err := s.ClearCache()
	if err != nil {
		t.Fatalf("ClearCache: %v", err)
	}
	if deleted == 0 {
		t.Error("expected deleted > 0")
	}
	if freed == 0 {
		t.Error("expected freedBytes > 0")
	}
	entries, _ = os.ReadDir(filepath.Join(dir, "video-faststart"))
	if len(entries) != 0 {
		t.Errorf("expected empty cache after clear, got %d entries", len(entries))
	}

	// 二次清空(目录已不存在)应返回 0, 0, nil,而非报错
	deleted2, freed2, err2 := s.ClearCache()
	if err2 != nil {
		t.Fatalf("ClearCache on empty dir: %v", err2)
	}
	if deleted2 != 0 || freed2 != 0 {
		t.Errorf("expected (0, 0) on empty, got (%d, %d)", deleted2, freed2)
	}
}
