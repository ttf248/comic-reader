package services

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/store"
)

func newBackupFixture(t *testing.T) (*StateBackupService, string, string) {
	t.Helper()
	root := t.TempDir()
	album := filepath.Join(root, "作品 C++ 100%")
	if err := os.Mkdir(album, 0o700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(album, "page.jpg")
	if err := os.WriteFile(file, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	model := models.Album{Type: "album", Name: "作品 C++ 100%", Path: album, SourceRoot: root, ImageFiles: []string{file}, ImageCount: 1, CoverImage: file, CoverKind: "image"}
	catalog := NewResourceCatalog()
	catalog.SetContentKindPolicy(NewContentKindPolicy([]RootKind{{Path: root, Kind: models.ContentKindComic}}))
	catalog.Publish(&models.ScanResult{Roots: []string{root}, Albums: []models.Album{model}, AlbumCount: 1}, []string{root})
	layout, err := EnsureCacheLayout(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &StateBackupService{Prefs: store.NewPrefsStore(layout.PreferencesPath), Activities: store.NewActivityStore(layout.ActivityPath), Covers: NewCoverOverrideStore(layout.CoverOverridesPath), Picks: store.NewPickStore(layout.PicksPath), Catalog: catalog, BackupDir: StateBackupDirectory(layout), ValidatePath: func(path string) (string, error) { _, err := os.Stat(path); return path, err }}
	id := catalog.ExternalID(album, ResourceAlbum)
	if _, err := s.Prefs.AddFavorite(id); err != nil {
		t.Fatal(err)
	}
	if err := s.Activities.Set(models.Activity{AlbumID: id, MediaKind: models.MediaKindImage, PageCount: 1}); err != nil {
		t.Fatal(err)
	}
	if err := s.Covers.Set(album, file); err != nil {
		t.Fatal(err)
	}
	return s, id, root
}

func TestStateBackupExportAndSelectedRestore(t *testing.T) {
	s, id, root := newBackupFixture(t)
	backup, err := s.Export()
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(backup)
	if bytes.Contains(data, []byte(filepath.Base(root))) || len(backup.Covers) != 1 {
		t.Fatalf("backup leaked path or lost cover: %s", data)
	}
	if _, err = s.Prefs.Patch(func(p *models.Prefs) { p.Favorites = []string{}; p.Theme = "dark" }); err != nil {
		t.Fatal(err)
	}
	preview, err := s.Preview(backup)
	if err != nil {
		t.Fatal(err)
	}
	result, err := s.Restore(backup, []string{"favorites"}, preview.Versions, preview.LibraryRevision)
	if err != nil || result.Failed != "" {
		t.Fatalf("restore: %+v %v", result, err)
	}
	p, _ := s.Prefs.Get()
	if len(p.Favorites) != 1 || p.Favorites[0] != id || p.Theme != "dark" {
		t.Fatalf("unselected preferences changed: %+v", p)
	}
	files, _ := os.ReadDir(s.BackupDir)
	if len(files) != 2 {
		t.Fatal("pre-restore backup missing")
	}
	preview, _ = s.Preview(backup)
	result, err = s.Restore(backup, []string{"preferences", "activities", "covers"}, preview.Versions, preview.LibraryRevision)
	if err != nil || result.Failed != "" || len(result.Completed) != 3 {
		t.Fatalf("full restore: %+v %v", result, err)
	}
}

func TestStateBackupRestoresPicksIndependently(t *testing.T) {
	s, _, root := newBackupFixture(t)
	fileID := s.Catalog.ExternalID(filepath.Join(root, "作品 C++ 100%", "page.jpg"), ResourceFile)
	if _, err := s.Picks.Batch([]string{fileID}, true); err != nil {
		t.Fatal(err)
	}
	backup, err := s.Export()
	if err != nil {
		t.Fatal(err)
	}
	if len(backup.Picks) != 1 || backup.Picks[0] != fileID {
		t.Fatalf("backup lost picks: %+v", backup.Picks)
	}
	// 精选被清空后，按类别恢复能把它们带回来。
	if _, err := s.Picks.Batch([]string{fileID}, false); err != nil {
		t.Fatal(err)
	}
	preview, err := s.Preview(backup)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Counts["picks"] != 1 {
		t.Fatalf("unexpected preview counts: %+v", preview.Counts)
	}
	result, err := s.Restore(backup, []string{"picks"}, preview.Versions, preview.LibraryRevision)
	if err != nil || result.Failed != "" || len(result.Completed) != 1 {
		t.Fatalf("restore picks: %+v %v", result, err)
	}
	if got := s.Picks.Get(); len(got) != 1 || got[0] != fileID {
		t.Fatalf("picks not restored: %v", got)
	}
	// 恢复精选不动收藏：两份数据互不覆盖。
	p, _ := s.Prefs.Get()
	if len(p.Favorites) != 1 {
		t.Fatalf("favorites changed by picks restore: %v", p.Favorites)
	}
}

func TestStateBackupRejectsInvalidPicks(t *testing.T) {
	s, _, _ := newBackupFixture(t)
	backup, _ := s.Export()
	backup.Picks = []string{"a_AAAAAAAAAAAAAAAAAAAAAA"}
	if _, err := s.Preview(backup); !errors.Is(err, ErrInvalidBackup) {
		t.Fatalf("album id accepted as pick: %v", err)
	}
}

func TestStateBackupRejectsConcurrentChangesAndInvalidInput(t *testing.T) {
	s, _, _ := newBackupFixture(t)
	backup, _ := s.Export()
	preview, _ := s.Preview(backup)
	_, _ = s.Prefs.Patch(func(p *models.Prefs) { p.Theme = "dark" })
	if _, err := s.Restore(backup, []string{"favorites"}, preview.Versions, preview.LibraryRevision); !errors.Is(err, store.ErrStateChanged) {
		t.Fatalf("concurrent mutation accepted: %v", err)
	}
	if entries, _ := os.ReadDir(s.BackupDir); len(entries) != 0 {
		t.Fatal("stale preview should not start restore")
	}
	backup.Version = 2
	if _, err := s.Preview(backup); !errors.Is(err, ErrInvalidBackup) {
		t.Fatalf("future version: %v", err)
	}
	backup.Version = 1
	backup.Favorites = []string{`C:\private\path`}
	if _, err := s.Preview(backup); !errors.Is(err, ErrInvalidBackup) {
		t.Fatalf("absolute favorite accepted: %v", err)
	}
}

func TestStateBackupMissingResourcesAndUnsafeCovers(t *testing.T) {
	s, _, _ := newBackupFixture(t)
	backup, _ := s.Export()
	missing := "a_AAAAAAAAAAAAAAAAAAAAAA"
	backup.Favorites = append(backup.Favorites, missing, "smart:字面%2F")
	s.ValidatePath = func(string) (string, error) { return "", errors.New("replaced by link") }
	preview, err := s.Preview(backup)
	if err != nil || preview.Missing["favorites"] != 2 || preview.SkippedCovers != 1 {
		t.Fatalf("preview: %+v %v", preview, err)
	}
	result, err := s.Restore(backup, []string{"favorites", "covers"}, preview.Versions, preview.LibraryRevision)
	if err != nil || result.Failed != "" || result.SkippedCovers != 1 || len(s.Covers.Snapshot()) != 0 {
		t.Fatalf("unsafe covers restored: %+v %v", result, err)
	}
	p, _ := s.Prefs.Get()
	if len(p.Favorites) != 3 {
		t.Fatal("missing favorites were discarded")
	}
}

func TestStateBackupPartialFailureAndBackupFailure(t *testing.T) {
	s, _, _ := newBackupFixture(t)
	backup, _ := s.Export()
	backup.Preferences.Theme = "dark"
	preview, _ := s.Preview(backup)
	// 活动已加载到内存；把磁盘目标换成目录，制造 commit 原子替换失败。
	activityPath := filepath.Join(filepath.Dir(s.BackupDir), "activity.json")
	if err := os.Remove(activityPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(activityPath, 0o700); err != nil {
		t.Fatal(err)
	}
	result, err := s.Restore(backup, []string{"preferences", "activities", "covers"}, preview.Versions, preview.LibraryRevision)
	if err != nil || result.Failed != "activities" || len(result.Completed) != 1 || len(result.Pending) != 1 {
		t.Fatalf("partial result: %+v %v", result, err)
	}
	p, _ := s.Prefs.Get()
	if p.Theme != "dark" || len(s.Covers.Snapshot()) != 1 {
		t.Fatal("partial restore did not preserve completed and pending classes")
	}
	blocker := filepath.Join(t.TempDir(), "not-a-directory")
	_ = os.WriteFile(blocker, []byte("blocked"), 0o600)
	s.BackupDir = blocker
	backup.Preferences.Theme = "light"
	preview, _ = s.Preview(backup)
	if _, err := s.Restore(backup, []string{"preferences"}, preview.Versions, preview.LibraryRevision); err == nil {
		t.Fatal("restore proceeded without backup")
	}
	p, _ = s.Prefs.Get()
	if p.Theme != "dark" {
		t.Fatal("backup failure changed preferences")
	}
}

func TestCoverStoreFailureDoesNotPublishAndHistoryLimitIsExplicit(t *testing.T) {
	s, id, _ := newBackupFixture(t)
	before := s.Covers.Snapshot()
	s.Covers.path = t.TempDir()
	album := ""
	for key := range before {
		album = key
		break
	}
	if err := s.Covers.Clear(album); err == nil {
		t.Fatal("directory target accepted")
	}
	if len(s.Covers.Snapshot()) != len(before) {
		t.Fatal("failed cover write changed memory")
	}
	_, _ = s.Prefs.Patch(func(p *models.Prefs) {
		p.History = []models.HistoryEntry{{AlbumID: id, OpenedAt: time.Now(), Name: "one"}}
	})
	backup, _ := s.Export()
	backup.History = append(backup.History, models.HistoryEntry{AlbumID: "a_AAAAAAAAAAAAAAAAAAAAAA", OpenedAt: time.Now(), Name: "two"})
	backup.Preferences.MaxRecent = 1
	preview, _ := s.Preview(backup)
	if _, err := s.Restore(backup, []string{"history", "preferences"}, preview.Versions, preview.LibraryRevision); !errors.Is(err, ErrBackupHistoryLimit) {
		t.Fatalf("history silently trimmed: %v", err)
	}
}

func TestCoverRestoreRejectsChangedCatalogBeforeWriting(t *testing.T) {
	s, _, _ := newBackupFixture(t)
	revision := s.Catalog.Acquire().Revision()
	expected := s.Covers.Snapshot()
	s.Catalog.RefreshCovers(nil, s.Covers)
	if err := s.Catalog.CompareAndRestoreCovers(revision, nil, s.Covers, expected, map[string]CoverOverride{}); !errors.Is(err, ErrCoverStateChanged) {
		t.Fatalf("changed catalog accepted: %v", err)
	}
	if len(s.Covers.Snapshot()) != len(expected) {
		t.Fatal("changed catalog caused a cover write")
	}
}
