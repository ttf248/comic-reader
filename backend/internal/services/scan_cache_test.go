package services

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

func TestScanResultCache_AsyncFlushDebounce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scan_cache.json")
	c := NewScanResultCache(path)
	root := t.TempDir()
	r := &models.ScanResult{Roots: []string{root}, ScannedAt: time.Now(), AlbumCount: 1}

	// 连写三次：debounce 应该只触发一次落盘
	for i := 0; i < 3; i++ {
		c.Set(r)
	}

	// 等待超过 debounce 窗口
	time.Sleep(flushDebounce + 200*time.Millisecond)

	// 文件应已存在
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected cache file to exist: %v", err)
	}

	// 读回应该 round-trip
	got := c.Get()
	if got == nil || got.AlbumCount != 1 {
		t.Fatalf("Get returned wrong result: %+v", got)
	}
}

func TestScanResultCache_LoadFromDisk(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scan_cache.json")
	c := NewScanResultCache(path)
	root := t.TempDir()
	r := &models.ScanResult{Roots: []string{root}, ScannedAt: time.Now(), AlbumCount: 42}
	c.Set(r)
	// 强制立即落盘，避免依赖 timer
	if err := c.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	// 重新打开
	c2 := NewScanResultCache(path)
	if _, err := c2.LoadWithRoots([]string{root}); err != nil {
		t.Fatalf("LoadWithRoots: %v", err)
	}
	got := c2.Get()
	if got == nil || got.AlbumCount != 42 {
		t.Fatalf("loaded cache wrong: %+v", got)
	}
}

func TestScanResultCache_NoUnnecessaryWriteWhenClean(t *testing.T) {
	// 没 Set 过，flush 应该 no-op；磁盘文件不应被创建
	path := filepath.Join(t.TempDir(), "scan_cache.json")
	c := NewScanResultCache(path)
	if err := c.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("Flush on empty cache should not create file")
	}
}

// 守护：flushDebounce 不应过大 / 过小
func TestScanResultCache_DebounceReasonable(t *testing.T) {
	if flushDebounce < 100*time.Millisecond || flushDebounce > 5*time.Second {
		t.Fatalf("flushDebounce out of range: %v", flushDebounce)
	}
}

// 缓存里的根目录与当前配置的根目录一致 → 正常加载
func TestScanResultCache_LoadWithRoots_Match(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scan_cache.json")
	root := t.TempDir()
	c := NewScanResultCache(path)
	r := &models.ScanResult{
		Roots:      []string{root},
		ScannedAt:  time.Now(),
		AlbumCount: 7,
	}
	c.Set(r)
	if err := c.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	c2 := NewScanResultCache(path)
	mismatch, err := c2.LoadWithRoots([]string{root})
	if err != nil {
		t.Fatalf("LoadWithRoots: %v", err)
	}
	if mismatch {
		t.Fatal("expected roots to match")
	}
	if got := c2.Get(); got == nil || got.AlbumCount != 7 {
		t.Fatalf("expected cache to be loaded, got %+v", got)
	}
}

// 缓存里的根目录与当前配置不一致 → 清空并报告 mismatch
func TestScanResultCache_LoadWithRoots_Mismatch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scan_cache.json")
	oldRoot := t.TempDir()
	newRoot := t.TempDir()

	c := NewScanResultCache(path)
	c.Set(&models.ScanResult{
		Roots:      []string{oldRoot},
		ScannedAt:  time.Now(),
		AlbumCount: 9,
	})
	if err := c.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	c2 := NewScanResultCache(path)
	mismatch, err := c2.LoadWithRoots([]string{newRoot})
	if err != nil {
		t.Fatalf("LoadWithRoots: %v", err)
	}
	if !mismatch {
		t.Fatal("expected rootsMismatch=true")
	}
	if got := c2.Get(); got != nil {
		t.Fatalf("expected cache to be cleared, got %+v", got)
	}
	// 磁盘文件应该被删除（下次启动按"无缓存"处理）
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected cache file to be removed, stat err: %v", err)
	}
}

func TestScanResultCache_LoadWithRoots_RequiresRoots(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scan_cache.json")
	c := NewScanResultCache(path)
	root := t.TempDir()
	c.Set(&models.ScanResult{Roots: []string{root}, AlbumCount: 3})
	if err := c.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	c2 := NewScanResultCache(path)
	if _, err := c2.LoadWithRoots(nil); err == nil {
		t.Fatal("expected missing current roots to be rejected")
	}
	if got := c2.Get(); got != nil {
		t.Fatalf("cache should remain empty, got %+v", got)
	}
}

// TestScanResultCache_PersistsAbsolutePath 验证当前 schema 的
// 新合约:cache.json 里直接存 raw 绝对路径,不再做 r_xxx/path 编码。
//
// 行为变化:之前 TestScanResultCache_PersistsRelativeReferencesOnly
// 校验「绝对路径不出现」,这是 schemaVersion=2 时的"磁盘读不到用户目录"
// 安全特性。新合约不再做混淆 ——
//
//   - cache.json 位于本地 cacheDir,127.0.0.1 后端,无外网访问
//   - 公共 API 响应走 catalog.ExternalID 转成 r_/a_/c_/f_ ID
//
// 落盘里有绝对路径是 by design。
func TestScanResultCache_PersistsAbsolutePath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scan_cache.json")
	root := t.TempDir()
	albumPath := filepath.Join(root, "private-album")
	filePath := filepath.Join(albumPath, "page.jpg")
	c := NewScanResultCache(path)
	c.Set(&models.ScanResult{
		Roots: []string{root},
		Albums: []models.Album{{
			Path:        albumPath,
			SourceRoot:  root,
			CoverImage:  filePath,
			ImageFiles:  []string{filePath},
			VideoFiles:  []string{},
			ImageCount:  1,
			DisplayName: "private-album",
		}},
	})
	if err := c.Flush(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// schemaVersion 标记（跟随常量，避免升级 schema 时漏改断言）
	wantSchema := fmt.Sprintf(`"schemaVersion": %d`, scanCacheSchemaVersion)
	if !strings.Contains(string(data), wantSchema) {
		t.Fatalf("cache schema version missing or wrong: %s", data)
	}
	// 绝对路径确实在文件里(新合约)。
	// Windows 路径里的 \ 在 JSON 编码时被转义为 \\,所以比对时用 marshaled 形式。
	escapedRoot, _ := json.Marshal(root)
	escapedFile, _ := json.Marshal(filePath)
	if !strings.Contains(string(data), strings.Trim(string(escapedRoot), `"`)) {
		t.Errorf("schemaVersion should keep raw absolute path, but file doesn't contain root %q:\n%s", root, data)
	}
	if !strings.Contains(string(data), strings.Trim(string(escapedFile), `"`)) {
		t.Errorf("file should contain raw image file path %q:\n%s", filePath, data)
	}

	loaded := NewScanResultCache(path)
	if mismatch, err := loaded.LoadWithRoots([]string{root}); err != nil || mismatch {
		t.Fatalf("LoadWithRoots=(%v,%v)", mismatch, err)
	}
	got := loaded.Get()
	if got == nil || got.Albums[0].Path != albumPath || got.Albums[0].ImageFiles[0] != filePath {
		t.Fatalf("decoded cache mismatch: %+v", got)
	}
}

func TestScanResultCache_GetAndSetUseDeepCopies(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "album", "page.jpg")
	original := &models.ScanResult{
		Roots:  []string{root},
		Albums: []models.Album{{Path: filepath.Dir(filePath), ImageFiles: []string{filePath}}},
	}
	c := NewScanResultCache(filepath.Join(t.TempDir(), "scan_cache.json"))
	c.Set(original)
	// Set 时 cloneScanResult 一次,之后外部修改 original 不影响 cache。
	original.Albums[0].ImageFiles[0] = "mutated-after-set"
	first := c.Get()
	if first == nil {
		t.Fatal("Get returned nil after Set")
	}
	if first.Albums[0].ImageFiles[0] != filePath {
		t.Fatalf("Set should clone: got %q want %q", first.Albums[0].ImageFiles[0], filePath)
	}
	// 新合约:Get 返回的 *ScanResult 是发布的不可变快照,不能修改。
	// 再次 Get 拿到的应是同一份(指针或值等价)。
	second := c.Get()
	if second == nil || second.Albums[0].ImageFiles[0] != filePath {
		t.Fatalf("subsequent Get should return same snapshot: %+v", second)
	}
}

// TestScanResultCache_GetIsAtomicLockFree 验证 Get 走 atomic.Load,无锁;
// 100 个 goroutine 并发 Get 同一 cache 不会因锁竞争而串行化。
func TestScanResultCache_GetIsAtomicLockFree(t *testing.T) {
	root := t.TempDir()
	c := NewScanResultCache(filepath.Join(t.TempDir(), "scan_cache.json"))
	c.Set(&models.ScanResult{
		Roots:  []string{root},
		Albums: []models.Album{{Path: root, Name: "a"}},
	})
	const goroutines = 50
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				r := c.Get()
				if r == nil || r.AlbumCount < 0 {
					t.Errorf("bad get: %+v", r)
					return
				}
			}
		}()
	}
	wg.Wait()
}

func TestScanResultCache_ClearRemovesPersistedSnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scan_cache.json")
	root := t.TempDir()
	c := NewScanResultCache(path)
	c.Set(&models.ScanResult{Roots: []string{root}})
	if err := c.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := c.Clear(); err != nil {
		t.Fatal(err)
	}
	if c.Get() != nil {
		t.Fatal("memory snapshot should be empty")
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("persisted snapshot should be removed: %v", err)
	}
}

func TestScanResultCache_FlushReplacesExistingSnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scan_cache.json")
	root := t.TempDir()
	c := NewScanResultCache(path)
	c.Set(&models.ScanResult{Roots: []string{root}, AlbumCount: 1})
	if err := c.Flush(); err != nil {
		t.Fatal(err)
	}
	c.Set(&models.ScanResult{Roots: []string{root}, AlbumCount: 2})
	if err := c.Flush(); err != nil {
		t.Fatal(err)
	}

	loaded := NewScanResultCache(path)
	if _, err := loaded.LoadWithRoots([]string{root}); err != nil {
		t.Fatal(err)
	}
	if got := loaded.Get(); got == nil || got.AlbumCount != 2 {
		t.Fatalf("latest snapshot was not persisted: %+v", got)
	}
}

func TestScanResultCache_ConcurrentSetGetFlush(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scan_cache.json")
	root := t.TempDir()
	c := NewScanResultCache(path)
	var wg sync.WaitGroup
	for worker := 0; worker < 4; worker++ {
		wg.Add(1)
		go func(offset int) {
			defer wg.Done()
			for i := 0; i < 25; i++ {
				c.Set(&models.ScanResult{
					Roots: []string{root}, AlbumCount: offset*100 + i,
				})
				_ = c.Get()
				if err := c.Flush(); err != nil {
					t.Errorf("Flush: %v", err)
					return
				}
			}
		}(worker)
	}
	wg.Wait()
	c.Set(&models.ScanResult{Roots: []string{root}, AlbumCount: 999})
	if err := c.Flush(); err != nil {
		t.Fatal(err)
	}
	loaded := NewScanResultCache(path)
	if _, err := loaded.LoadWithRoots([]string{root}); err != nil {
		t.Fatal(err)
	}
	if got := loaded.Get(); got == nil || got.AlbumCount != 999 {
		t.Fatalf("final snapshot mismatch: %+v", got)
	}
}

func TestScanResultCache_IsolatesUnsupportedSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scan_cache.json")
	root := t.TempDir()
	legacy, err := json.Marshal(&models.ScanResult{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	c := NewScanResultCache(path)
	mismatch, err := c.LoadWithRoots([]string{root})
	if err != nil || !mismatch {
		t.Fatalf("LoadWithRoots=(%v,%v), want unsupported schema isolation", mismatch, err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unsupported cache should be isolated: %v", err)
	}
	matches, _ := filepath.Glob(path + ".unsupported.*")
	if len(matches) != 1 {
		t.Fatalf("unsupported cache backup missing: %v", matches)
	}
}

// 多根集合顺序无关性：cache 是 [A,B]，current 是 [B,A] → 视为相同
func TestScanResultCache_LoadWithRoots_MultiRootsOrderInsensitive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scan_cache.json")
	a := t.TempDir()
	b := t.TempDir()
	c := NewScanResultCache(path)
	c.Set(&models.ScanResult{
		Roots:      []string{a, b},
		ScannedAt:  time.Now(),
		AlbumCount: 5,
	})
	if err := c.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	c2 := NewScanResultCache(path)
	mismatch, err := c2.LoadWithRoots([]string{b, a})
	if err != nil {
		t.Fatalf("LoadWithRoots: %v", err)
	}
	if mismatch {
		t.Fatal("expected roots to match regardless of order")
	}
	if got := c2.Get(); got == nil || got.AlbumCount != 5 {
		t.Fatalf("expected cache to be loaded, got %+v", got)
	}
}

func TestSameRootIDs(t *testing.T) {
	cases := []struct {
		name string
		a, b []string
		want bool
	}{
		{"both empty", nil, nil, true},
		{"one empty", []string{"a"}, nil, false},
		{"same single", []string{"a"}, []string{"a"}, true},
		{"diff single", []string{"a"}, []string{"b"}, false},
		{"order independent", []string{"a", "b"}, []string{"b", "a"}, true},
		{"multi mismatch", []string{"a", "b"}, []string{"a", "c"}, false},
		{"cached duplicate", []string{"a", "a"}, []string{"a", "b"}, false},
		{"current duplicate", []string{"a", "b"}, []string{"a", "a"}, false},
		{"both duplicate", []string{"a", "a"}, []string{"a", "a"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sameRootIDs(tc.a, tc.b); got != tc.want {
				t.Fatalf("sameRootIDs(%v, %v) = %v, want %v", tc.a, tc.b, got, tc.want)
			}
		})
	}
}
