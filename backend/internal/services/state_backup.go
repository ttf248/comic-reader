package services

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/store"
)

var ErrInvalidBackup = errors.New("invalid state backup")
var ErrBackupTooLarge = errors.New("state backup exceeds import limit")
var ErrBackupHistoryLimit = errors.New("history exceeds selected preferences limit")

type BackupPreferences struct {
	MaxRecent        int            `json:"maxRecent"`
	AutoSwitchAlbum  bool           `json:"autoSwitchAlbum"`
	ShowSwitchNotif  bool           `json:"showSwitchNotif"`
	Theme            string         `json:"theme"`
	SidebarCollapsed bool           `json:"sidebarCollapsed"`
	AppMode          models.AppMode `json:"appMode"`
}
type BackupCover struct {
	AlbumID string `json:"albumId"`
	ItemID  string `json:"itemId"`
}

// StateBackup 只包含可移交的用户状态，不导出配置、令牌或扫描缓存。
type StateBackup struct {
	Version          int                   `json:"version"`
	ExportedAt       time.Time             `json:"exportedAt"`
	Favorites        []string              `json:"favorites"`
	History          []models.HistoryEntry `json:"history"`
	Preferences      *BackupPreferences    `json:"preferences"`
	Activities       []models.Activity     `json:"activities"`
	Covers           []BackupCover         `json:"covers"`
	UnresolvedCovers int                   `json:"unresolvedCovers,omitempty"`
}
type BackupPreview struct {
	Versions        map[string]string `json:"versions"`
	LibraryRevision uint64            `json:"libraryRevision"`
	Counts          map[string]int    `json:"counts"`
	Missing         map[string]int    `json:"missing"`
	SkippedCovers   int               `json:"skippedCovers"`
	Ready           bool              `json:"ready"`
}
type RestoreResult struct {
	Completed     []string `json:"completed"`
	Failed        string   `json:"failed,omitempty"`
	Pending       []string `json:"pending"`
	Code          string   `json:"code,omitempty"`
	SkippedCovers int      `json:"skippedCovers"`
}
type backupSnapshot struct {
	prefs      models.Prefs
	activities []models.Activity
	covers     map[string]CoverOverride
	catalog    CatalogSnapshot
}

// StateBackupService 的路径验证由装配层注入，service 不依赖 HTTP 或中间件。
type StateBackupService struct {
	Prefs        *store.PrefsStore
	Activities   *store.ActivityStore
	Covers       *CoverOverrideStore
	Catalog      *ResourceCatalog
	ScanCache    *ScanResultCache
	ValidatePath func(string) (string, error)
	BackupDir    string
}

func (s *StateBackupService) snapshot() (backupSnapshot, error) {
	p, err := s.Prefs.Get()
	if err != nil {
		return backupSnapshot{}, err
	}
	a, err := s.Activities.Snapshot()
	if err != nil {
		return backupSnapshot{}, err
	}
	return backupSnapshot{prefs: p, activities: a, covers: s.Covers.Snapshot(), catalog: s.Catalog.Acquire()}, nil
}
func backupDigest(value interface{}) string {
	data, _ := json.Marshal(value)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
func (state backupSnapshot) versions() map[string]string {
	return map[string]string{"preferences": backupDigest(state.prefs), "activities": backupDigest(state.activities), "covers": backupDigest(state.covers)}
}
func (state backupSnapshot) export() StateBackup {
	p := state.prefs
	backup := StateBackup{Version: 1, ExportedAt: time.Now().UTC(), Favorites: append([]string{}, p.Favorites...), History: append([]models.HistoryEntry{}, p.History...), Activities: state.activities, Covers: []BackupCover{}, Preferences: &BackupPreferences{p.MaxRecent, p.AutoSwitchAlbum, p.ShowSwitchNotif, p.Theme, p.SidebarCollapsed, p.AppMode}}
	for album, cover := range state.covers {
		aid := state.catalog.ExternalID(album, ResourceAlbum)
		fid := state.catalog.ExternalID(cover.File, ResourceFile)
		if aid == "" || fid == "" {
			backup.UnresolvedCovers++
			continue
		}
		backup.Covers = append(backup.Covers, BackupCover{aid, fid})
	}
	sort.Slice(backup.Covers, func(i, j int) bool { return backup.Covers[i].AlbumID < backup.Covers[j].AlbumID })
	return backup
}
func (s *StateBackupService) Export() (StateBackup, error) {
	state, err := s.snapshot()
	if err != nil {
		return StateBackup{}, err
	}
	return state.export(), nil
}

func ValidateStateBackup(backup StateBackup) error {
	if backup.Version != 1 || backup.Preferences == nil || backup.Favorites == nil || backup.History == nil || backup.Activities == nil || backup.Covers == nil || backup.ExportedAt.IsZero() {
		return ErrInvalidBackup
	}
	p := backup.Preferences
	if p.MaxRecent < 1 || p.MaxRecent > 10000 || (p.Theme != "light" && p.Theme != "dark" && p.Theme != "system") || !models.IsValidAppMode(string(p.AppMode)) || len(backup.Favorites) > 500 {
		return ErrInvalidBackup
	}
	seen := map[string]bool{}
	for _, id := range backup.Favorites {
		if !models.IsFavoriteResourceID(id) || seen[id] {
			return ErrInvalidBackup
		}
		seen[id] = true
	}
	seen = map[string]bool{}
	for _, entry := range backup.History {
		if !models.IsAlbumID(entry.AlbumID) || entry.OpenedAt.IsZero() || entry.ImageCount < 0 || seen[entry.AlbumID] {
			return ErrInvalidBackup
		}
		seen[entry.AlbumID] = true
	}
	seen = map[string]bool{}
	for _, activity := range backup.Activities {
		if _, err := models.NormalizeActivity(activity); err != nil || activity.Updated.IsZero() {
			return ErrInvalidBackup
		}
		key, _ := activity.Identity().Key()
		if seen[key] {
			return ErrInvalidBackup
		}
		seen[key] = true
	}
	seen = map[string]bool{}
	for _, cover := range backup.Covers {
		if !models.IsAlbumID(cover.AlbumID) || !models.IsFileID(cover.ItemID) || seen[cover.AlbumID] {
			return ErrInvalidBackup
		}
		seen[cover.AlbumID] = true
	}
	return nil
}

func (s *StateBackupService) coverPaths(snapshot CatalogSnapshot, covers []BackupCover) (map[string]CoverOverride, int) {
	result := map[string]CoverOverride{}
	skipped := 0
	for _, cover := range covers {
		album, ok := snapshot.Lookup(cover.AlbumID)
		file, fileOK := snapshot.Lookup(cover.ItemID)
		if !ok || !fileOK || album.Kind != ResourceAlbum || file.Kind != ResourceFile || s.ValidatePath == nil {
			skipped++
			continue
		}
		model, ok := snapshot.state.albums[cover.AlbumID]
		if !ok || !albumContainsMedia(model, file.AbsolutePath) {
			skipped++
			continue
		}
		if _, err := s.ValidatePath(album.AbsolutePath); err != nil {
			skipped++
			continue
		}
		if _, err := s.ValidatePath(file.AbsolutePath); err != nil {
			skipped++
			continue
		}
		info, err := os.Stat(file.AbsolutePath)
		if err != nil || !info.Mode().IsRegular() {
			skipped++
			continue
		}
		result[album.AbsolutePath] = CoverOverride{File: file.AbsolutePath}
	}
	return result, skipped
}

func (s *StateBackupService) Preview(backup StateBackup) (BackupPreview, error) {
	if err := ValidateStateBackup(backup); err != nil {
		return BackupPreview{}, err
	}
	state, err := s.snapshot()
	if err != nil {
		return BackupPreview{}, err
	}
	_, skipped := s.coverPaths(state.catalog, backup.Covers)
	preview := BackupPreview{Versions: state.versions(), LibraryRevision: state.catalog.Revision(), Ready: state.catalog.Ready(), Counts: map[string]int{"favorites": len(backup.Favorites), "history": len(backup.History), "preferences": 1, "activities": len(backup.Activities), "covers": len(backup.Covers)}, Missing: map[string]int{}, SkippedCovers: skipped}
	missing := func(id string) bool { _, ok := state.catalog.Lookup(id); return !ok }
	for _, id := range backup.Favorites {
		if strings.HasPrefix(id, "smart:") {
			if state.catalog.state.library == nil {
				preview.Missing["favorites"]++
				continue
			}
			if _, ok := state.catalog.state.library.tagsByName[strings.TrimPrefix(id, "smart:")]; !ok {
				preview.Missing["favorites"]++
			}
		} else if missing(id) {
			preview.Missing["favorites"]++
		}
	}
	for _, entry := range backup.History {
		if missing(entry.AlbumID) {
			preview.Missing["history"]++
		}
	}
	for _, a := range backup.Activities {
		if missing(a.AlbumID) || (a.ItemID != "" && missing(a.ItemID)) {
			preview.Missing["activities"]++
		}
	}
	return preview, nil
}

func (s *StateBackupService) Restore(backup StateBackup, categories []string, versions map[string]string, revision uint64) (RestoreResult, error) {
	if err := ValidateStateBackup(backup); err != nil {
		return RestoreResult{}, err
	}
	selected := map[string]bool{}
	for _, category := range categories {
		if selected[category] || (category != "favorites" && category != "history" && category != "preferences" && category != "activities" && category != "covers") {
			return RestoreResult{}, ErrInvalidBackup
		}
		selected[category] = true
	}
	if len(selected) == 0 {
		return RestoreResult{}, ErrInvalidBackup
	}
	state, err := s.snapshot()
	if err != nil {
		return RestoreResult{}, err
	}
	if (selected["covers"] && !state.catalog.Ready()) || state.catalog.Revision() != revision {
		return RestoreResult{}, ErrLibraryNotReady
	}
	limit := state.prefs.MaxRecent
	if selected["preferences"] {
		limit = backup.Preferences.MaxRecent
	}
	historySize := len(state.prefs.History)
	if selected["history"] {
		historySize = len(backup.History)
	}
	if historySize > limit {
		return RestoreResult{}, ErrBackupHistoryLimit
	}
	current := state.versions()
	for category := range selected {
		key := category
		if category == "favorites" || category == "history" {
			key = "preferences"
		}
		if versions[key] == "" || versions[key] != current[key] {
			return RestoreResult{}, store.ErrStateChanged
		}
	}
	// 恢复前备份使用同一导出格式，可在设置页再次选择恢复。
	if err := os.MkdirAll(s.BackupDir, 0o700); err != nil {
		return RestoreResult{}, err
	}
	data, err := json.Marshal(state.export())
	if err != nil {
		return RestoreResult{}, err
	}
	file, err := os.CreateTemp(s.BackupDir, "before-restore-*.json")
	if err != nil {
		return RestoreResult{}, err
	}
	if err = file.Chmod(0o600); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return RestoreResult{}, err
	}
	if closeErr != nil {
		return RestoreResult{}, closeErr
	}
	// 另存完整内部封面映射，保留当前库无法解析的旧记录；不对外下载。
	internal, err := json.Marshal(state.covers)
	if err != nil {
		return RestoreResult{}, err
	}
	if err = os.WriteFile(file.Name()+".internal-covers", internal, 0o600); err != nil {
		return RestoreResult{}, err
	}
	result := RestoreResult{Completed: []string{}, Pending: []string{}}
	order := []string{"favorites", "history", "preferences", "activities", "covers"}
	fail := func(category string, err error) (RestoreResult, error) {
		result.Failed = category
		result.Code = "state_restore_failed"
		if errors.Is(err, store.ErrStateChanged) || errors.Is(err, ErrCoverStateChanged) {
			result.Code = "state_changed"
		}
		for _, key := range order {
			if selected[key] && key != category {
				result.Pending = append(result.Pending, key)
			}
		}
		return result, nil
	}
	// 同文件的三个类别一起提交，保留未选择类别。
	if selected["favorites"] || selected["history"] || selected["preferences"] {
		err = s.Prefs.CompareAndPatch(state.prefs, func(next *models.Prefs) {
			if selected["preferences"] {
				p := backup.Preferences
				next.MaxRecent = p.MaxRecent
				next.AutoSwitchAlbum = p.AutoSwitchAlbum
				next.ShowSwitchNotif = p.ShowSwitchNotif
				next.Theme = p.Theme
				next.SidebarCollapsed = p.SidebarCollapsed
				next.AppMode = p.AppMode
			}
			if selected["favorites"] {
				next.Favorites = append([]string{}, backup.Favorites...)
			}
			if selected["history"] {
				next.History = append([]models.HistoryEntry{}, backup.History...)
			}
		})
		if err != nil {
			for _, key := range order[:3] {
				if selected[key] {
					return fail(key, err)
				}
			}
		}
		for _, key := range order[:3] {
			if selected[key] {
				result.Completed = append(result.Completed, key)
				delete(selected, key)
			}
		}
	}
	if selected["activities"] {
		if err = s.Activities.CompareAndReplace(state.activities, backup.Activities); err != nil {
			return fail("activities", err)
		}
		result.Completed = append(result.Completed, "activities")
		delete(selected, "activities")
	}
	if selected["covers"] {
		if s.Catalog.Acquire().Revision() != revision {
			return fail("covers", store.ErrStateChanged)
		}
		covers, skipped := s.coverPaths(state.catalog, backup.Covers)
		result.SkippedCovers = skipped
		if err = s.Catalog.CompareAndRestoreCovers(revision, s.ScanCache, s.Covers, state.covers, covers); err != nil {
			return fail("covers", err)
		}
		result.Completed = append(result.Completed, "covers")
		delete(selected, "covers")

	}
	return result, nil
}

func StateBackupDirectory(layout CacheLayout) string {
	return filepath.Join(layout.StateDir, "backups")
}
