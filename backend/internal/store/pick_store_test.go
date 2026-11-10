package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// fileID 造一个合法的媒体文件 ID（f_ + 22 位 base64url）。
func fileID(suffix string) string {
	return opaqueID("f_", suffix)
}

// albumID 造一个合法的相册资源 ID（a_ + 22 位 base64url）。
func albumID(suffix string) string {
	return opaqueID("a_", suffix)
}

func opaqueID(prefix, suffix string) string {
	id := prefix
	for len(id) < 24 {
		id += suffix
	}
	return id[:24]
}

func TestPickStorePersistsAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "picks.json")
	store := NewPickStore(path)

	if _, err := store.Batch([]string{fileID("a"), fileID("b")}, true); err != nil {
		t.Fatalf("batch add: %v", err)
	}
	if _, err := store.Batch([]string{fileID("c")}, true); err != nil {
		t.Fatalf("batch add: %v", err)
	}

	// 重启：新的 store 实例从磁盘读回同一份精选。
	reloaded := NewPickStore(path)
	got := reloaded.Get()
	if len(got) != 3 {
		t.Fatalf("expected 3 picks after reload, got %d", len(got))
	}
	// 最近加入的排在最前面。
	if got[0] != fileID("c") {
		t.Fatalf("expected newest pick first, got %q", got[0])
	}
}

func TestPickStoreAddIsIdempotent(t *testing.T) {
	store := NewPickStore(filepath.Join(t.TempDir(), "picks.json"))
	id := fileID("a")
	if changed, err := store.Batch([]string{id}, true); err != nil || changed != 1 {
		t.Fatalf("first add: changed=%d err=%v", changed, err)
	}
	if changed, err := store.Batch([]string{id}, true); err != nil || changed != 0 {
		t.Fatalf("second add: changed=%d err=%v", changed, err)
	}
	if len(store.Get()) != 1 {
		t.Fatalf("expected 1 pick, got %d", len(store.Get()))
	}
}

func TestPickStoreRemoveIgnoresUnknown(t *testing.T) {
	store := NewPickStore(filepath.Join(t.TempDir(), "picks.json"))
	kept := fileID("a")
	if _, err := store.Batch([]string{kept}, true); err != nil {
		t.Fatalf("add: %v", err)
	}
	changed, err := store.Batch([]string{fileID("z")}, false)
	if err != nil {
		t.Fatalf("remove: %v", err)
	}
	if changed != 0 {
		t.Fatalf("expected no change, got %d", changed)
	}
	if len(store.Get()) != 1 {
		t.Fatalf("expected pick kept, got %d", len(store.Get()))
	}
}

func TestPickStoreRejectsInvalidIdentity(t *testing.T) {
	store := NewPickStore(filepath.Join(t.TempDir(), "picks.json"))
	if _, err := store.Batch([]string{"not-a-file-id"}, true); err == nil {
		t.Fatal("expected error for invalid pick identity")
	}
	if err := store.Replace([]string{"a_album_id"}); err == nil {
		t.Fatal("expected error replacing with invalid identity")
	}
}

func TestPickStoreEnforcesLimit(t *testing.T) {
	store := NewPickStore(filepath.Join(t.TempDir(), "picks.json"))
	ids := make([]string, 0, MaxPicks+1)
	for i := 0; i <= MaxPicks; i++ {
		ids = append(ids, fileID(string(rune('a'+i%26))+string(rune('a'+(i/26)%26))+string(rune('a'+(i/676)%26))))
	}
	// 同一批里出现重复项，去重后不会撑破上限；这里要的是「超过上限时报错」。
	if _, err := store.Batch(ids, true); err != ErrPickLimit {
		t.Fatalf("expected pick limit error, got %v", err)
	}
}

func TestPickStoreCorruptFileStartsEmpty(t *testing.T) {
	path := filepath.Join(t.TempDir(), "picks.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write corrupt file: %v", err)
	}
	store := NewPickStore(path)
	if len(store.Get()) != 0 {
		t.Fatalf("expected empty picks after corrupt file, got %d", len(store.Get()))
	}
	// 坏文件被改名留档，不会被反复读坏。
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) == ".corrupt" || len(entry.Name()) > len("picks.json") {
			found = true
		}
	}
	if !found {
		t.Fatal("expected corrupt backup file")
	}
}

func TestPickStoreRevisionAdvancesOnChange(t *testing.T) {
	store := NewPickStore(filepath.Join(t.TempDir(), "picks.json"))
	before := store.Revision()
	if _, err := store.Batch([]string{fileID("a")}, true); err != nil {
		t.Fatalf("add: %v", err)
	}
	if store.Revision() <= before {
		t.Fatalf("expected revision to advance, before=%d after=%d", before, store.Revision())
	}
}

func TestPickStoreContainsAnswersInBatch(t *testing.T) {
	store := NewPickStore(filepath.Join(t.TempDir(), "picks.json"))
	picked := fileID("a")
	if _, err := store.Batch([]string{picked}, true); err != nil {
		t.Fatalf("add: %v", err)
	}
	flags := store.Contains([]string{picked, fileID("b")})
	if len(flags) != 2 || !flags[0] || flags[1] {
		t.Fatalf("unexpected flags %v", flags)
	}
}

func TestPickStoreReplaceReplacesAll(t *testing.T) {
	path := filepath.Join(t.TempDir(), "picks.json")
	store := NewPickStore(path)
	if _, err := store.Batch([]string{fileID("a")}, true); err != nil {
		t.Fatalf("add: %v", err)
	}
	if err := store.Replace([]string{fileID("b")}); err != nil {
		t.Fatalf("replace: %v", err)
	}
	got := store.Get()
	if len(got) != 1 || got[0] != fileID("b") {
		t.Fatalf("unexpected picks after replace: %v", got)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var file pickFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if file.Version != pickFileVersion {
		t.Fatalf("unexpected version %d", file.Version)
	}
}

func TestPickStoreIsIndependentFromFavorites(t *testing.T) {
	dir := t.TempDir()
	prefs := NewPrefsStore(filepath.Join(dir, "web_settings.json"))
	picks := NewPickStore(filepath.Join(dir, "picks.json"))
	if _, err := prefs.AddFavorite(albumID("b")); err != nil {
		t.Fatalf("add favorite: %v", err)
	}
	if _, err := picks.Batch([]string{fileID("a")}, true); err != nil {
		t.Fatalf("add pick: %v", err)
	}
	// 收藏与精选各写各的文件：动精选不动收藏。
	if _, err := picks.Batch([]string{fileID("a")}, false); err != nil {
		t.Fatalf("remove pick: %v", err)
	}
	favorites, err := prefs.Get()
	if err != nil {
		t.Fatal(err)
	}
	if len(favorites.Favorites) != 1 {
		t.Fatalf("expected favorite untouched, got %v", favorites.Favorites)
	}
	if !models.IsFileID(fileID("a")) {
		t.Fatal("test helper produced invalid file id")
	}
}
