package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

func TestPrefsPatchPreservesConcurrentFavoritesAndHistory(t *testing.T) {
	s := tempStore(t)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			if _, err := s.AddFavorite(testAlbumID(i)); err != nil {
				t.Error(err)
			}
			if _, err := s.AddHistory(models.HistoryEntry{AlbumID: testAlbumID(i), OpenedAt: time.Now()}); err != nil {
				t.Error(err)
			}
		}(i)
		go func() {
			defer wg.Done()
			if _, err := s.Patch(func(p *models.Prefs) { p.Theme = "dark" }); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	p, err := s.Get()
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Favorites) != 20 || len(p.History) != 10 || p.Theme != "dark" {
		t.Fatalf("lost concurrent writes: favorites=%d history=%d theme=%s", len(p.Favorites), len(p.History), p.Theme)
	}
	reloaded, err := NewPrefsStore(s.path).Get()
	if err != nil || len(reloaded.Favorites) != 20 {
		t.Fatalf("disk favorites=%d err=%v", len(reloaded.Favorites), err)
	}
}

func tempStore(t *testing.T) *PrefsStore {
	t.Helper()
	return NewPrefsStore(filepath.Join(t.TempDir(), "prefs.json"))
}

func TestPrefsStore_GetDefaultsWhenMissing(t *testing.T) {
	s := tempStore(t)
	p, err := s.Get()
	if err != nil {
		t.Fatal(err)
	}
	if p.MaxRecent != 10 || p.Theme != "system" {
		t.Errorf("defaults wrong: %+v", p)
	}
	if len(p.Favorites) != 0 || len(p.History) != 0 {
		t.Error("favorites/history should be empty")
	}
}

func TestPrefsStore_Persistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "prefs.json")
	s := NewPrefsStore(path)

	id := testAlbumID(1)
	if _, err := s.AddFavorite(id); err != nil {
		t.Fatal(err)
	}

	// 重新打开同一文件
	s2 := NewPrefsStore(path)
	p, err := s2.Get()
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Favorites) != 1 || p.Favorites[0] != id {
		t.Errorf("favorites not persisted: %+v", p.Favorites)
	}
}

func TestPrefsStore_AddFavoriteIdempotent(t *testing.T) {
	s := tempStore(t)
	s.AddFavorite(testAlbumID(1))
	s.AddFavorite(testAlbumID(1))
	p, _ := s.Get()
	if len(p.Favorites) != 1 {
		t.Errorf("expected 1 favorite, got %d", len(p.Favorites))
	}
}

func TestPrefsStore_RemoveFavorite(t *testing.T) {
	s := tempStore(t)
	s.AddFavorite(testAlbumID(1))
	s.AddFavorite(testAlbumID(2))
	out, _ := s.RemoveFavorite(testAlbumID(1))
	if len(out) != 1 || out[0] != testAlbumID(2) {
		t.Errorf("remove failed: %v", out)
	}
}

func TestPrefsStore_PruneInvalidFavorites(t *testing.T) {
	s := tempStore(t)
	existing := testAlbumID(1)
	missing := testAlbumID(2)
	s.AddFavorite(existing)
	s.AddFavorite(missing)

	removed, err := s.PruneInvalidFavorites(func(id string) bool { return id == existing })
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 1 {
		t.Errorf("expected 1 removed, got %d", len(removed))
	}
	p, _ := s.Get()
	if len(p.Favorites) != 1 || p.Favorites[0] != existing {
		t.Errorf("expected only existing favorite, got %v", p.Favorites)
	}
}

func TestPrefsStore_AddHistoryLRU(t *testing.T) {
	s := tempStore(t)
	// 限制为 3 条
	cur, _ := s.Get()
	cur.MaxRecent = 3
	s.Update(cur)

	now := time.Now()
	s.AddHistory(models.HistoryEntry{AlbumID: testAlbumID(1), Name: "A", OpenedAt: now})
	s.AddHistory(models.HistoryEntry{AlbumID: testAlbumID(2), Name: "B", OpenedAt: now.Add(time.Second)})
	s.AddHistory(models.HistoryEntry{AlbumID: testAlbumID(3), Name: "C", OpenedAt: now.Add(2 * time.Second)})
	s.AddHistory(models.HistoryEntry{AlbumID: testAlbumID(4), Name: "D", OpenedAt: now.Add(3 * time.Second)})

	p, _ := s.Get()
	if len(p.History) != 3 {
		t.Fatalf("expected 3 history entries (max), got %d", len(p.History))
	}
	// 最新优先
	if p.History[0].AlbumID != testAlbumID(4) {
		t.Errorf("expected newest first, got %s", p.History[0].AlbumID)
	}
	if p.History[2].AlbumID != testAlbumID(2) {
		t.Errorf("expected oldest retained item last, got %s", p.History[2].AlbumID)
	}
}

func TestPrefsStore_AddHistoryDedup(t *testing.T) {
	s := tempStore(t)
	s.AddHistory(models.HistoryEntry{AlbumID: testAlbumID(1), OpenedAt: time.Now()})
	s.AddHistory(models.HistoryEntry{AlbumID: testAlbumID(2), OpenedAt: time.Now()})
	s.AddHistory(models.HistoryEntry{AlbumID: testAlbumID(1), OpenedAt: time.Now().Add(time.Minute)})

	p, _ := s.Get()
	if len(p.History) != 2 {
		t.Errorf("expected dedup to 2 entries, got %d", len(p.History))
	}
	// /a 应该是最新的
	if p.History[0].AlbumID != testAlbumID(1) {
		t.Errorf("expected latest duplicate first, got %s", p.History[0].AlbumID)
	}
}

func TestPrefsStore_ClearHistory(t *testing.T) {
	s := tempStore(t)
	s.AddHistory(models.HistoryEntry{AlbumID: testAlbumID(1), OpenedAt: time.Now()})
	if err := s.ClearHistory(); err != nil {
		t.Fatal(err)
	}
	p, _ := s.Get()
	if len(p.History) != 0 {
		t.Errorf("expected empty history, got %d", len(p.History))
	}
}

func TestPrefsStore_CorruptFileRecovers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "prefs.json")
	os.WriteFile(path, []byte("{not json"), 0o644)

	s := NewPrefsStore(path)
	p, err := s.Get()
	if err != nil {
		t.Fatal(err)
	}
	if p.MaxRecent != 10 {
		t.Errorf("corrupt file should fall back to defaults, got %+v", p)
	}

	// 损坏文件应被备份
	entries, _ := os.ReadDir(filepath.Dir(path))
	foundBackup := false
	for _, e := range entries {
		if filepath.Ext(e.Name()) != "" && contains(e.Name(), ".corrupt.") {
			foundBackup = true
			break
		}
	}
	if !foundBackup {
		t.Error("expected corrupt backup file")
	}
}

// TestPrefsStore_CorruptBackupUnique 验证连续两次损坏不会互相覆盖备份。
//
// 旧实现备份用秒级时间戳 ("20060102150405"),同一秒内连续两次
// 损坏会把第一次的 .corrupt.<ts> 覆盖,丢失现场。新实现加 UnixNano 后缀,
// 纳秒级不可能撞名。
func TestPrefsStore_CorruptBackupUnique(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "prefs.json")

	// 第一次损坏
	os.WriteFile(path, []byte("corrupt-1"), 0o644)
	s1 := NewPrefsStore(path)
	if _, err := s1.Get(); err != nil {
		t.Fatal(err)
	}

	// 第二次损坏:用另一个 NewPrefsStore 实例(新 path 不能相同,否则会读到
	// 上一次备份后的空文件)。这里换 path 测两次"独立损坏 → 不同 backup"。
	path2 := filepath.Join(dir, "prefs2.json")
	os.WriteFile(path2, []byte("corrupt-2"), 0o644)
	s2 := NewPrefsStore(path2)
	if _, err := s2.Get(); err != nil {
		t.Fatal(err)
	}

	// 验证 .corrupt. 文件数 ≥ 2(可能还有清理过的 .tmp)
	entries, _ := os.ReadDir(dir)
	count := 0
	for _, e := range entries {
		if contains(e.Name(), ".corrupt.") {
			count++
		}
	}
	if count < 2 {
		t.Errorf("expected ≥ 2 corrupt backups, got %d (entries: %v)", count, entries)
	}
}

func TestPrefsStore_AtomicWrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "prefs.json")
	s := NewPrefsStore(path)
	s.AddFavorite(testAlbumID(1))

	// 验证文件可被 JSON 解析
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var p models.Prefs
	if err := json.Unmarshal(data, &p); err != nil {
		t.Fatal(err)
	}
	if len(p.Favorites) != 1 {
		t.Errorf("persisted favorites: %v", p.Favorites)
	}
}

func TestPrefsStore_UpdatePartial(t *testing.T) {
	s := tempStore(t)
	cur, _ := s.Get()
	cur.Theme = "dark"
	s.Update(cur)

	// 通过 Update 全量替换
	cur2, _ := s.Get()
	cur2.AutoSwitchAlbum = false
	s.Update(cur2)

	p, _ := s.Get()
	if p.Theme != "dark" {
		t.Errorf("theme should be dark, got %s", p.Theme)
	}
	if p.AutoSwitchAlbum != false {
		t.Error("autoSwitch should be false")
	}
}

func TestPrefsStore_AddFavoriteCappedAtMaxFavorites(t *testing.T) {
	s := tempStore(t)
	// 加入 600 条，超过 500 软上限
	for i := 0; i < 600; i++ {
		s.AddFavorite(testAlbumID(i))
	}
	p, _ := s.Get()
	if len(p.Favorites) != 500 {
		t.Fatalf("expected 500 favorites after cap, got %d", len(p.Favorites))
	}
	// 最旧的前 100 条应该被丢弃，最新的 500 条应保留
	if p.Favorites[0] != testAlbumID(100) || p.Favorites[len(p.Favorites)-1] != testAlbumID(599) {
		t.Errorf("oldest/newest not as expected: first=%s last=%s",
			p.Favorites[0], p.Favorites[len(p.Favorites)-1])
	}
}

func TestPrefsStore_GetReturnsDeepCopyAndDropsInvalidResourceIDs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "prefs.json")
	stored := `{
  "favorites": ["C:\\\\Users\\\\reader\\\\secret", "a_0000000000000000000001"],
  "history": [{"albumId": "C:\\\\secret", "name": "invalid"}],
  "maxRecent": 10,
  "theme": "system"
}`
	if err := os.WriteFile(path, []byte(stored), 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewPrefsStore(path)
	prefs, err := s.Get()
	if err != nil {
		t.Fatal(err)
	}
	if len(prefs.Favorites) != 1 || len(prefs.History) != 0 {
		t.Fatalf("invalid resource ids were not filtered: %+v", prefs)
	}
	prefs.Favorites[0] = testAlbumID(99)
	again, _ := s.Get()
	if again.Favorites[0] != testAlbumID(1) {
		t.Fatal("Get returned mutable store backing data")
	}
}

func testAlbumID(n int) string {
	return fmt.Sprintf("a_%022d", n)
}

func contains(s, substr string) bool {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
