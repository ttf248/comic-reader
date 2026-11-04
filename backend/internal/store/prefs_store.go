// Package store 提供偏好持久化与原子读写。
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// PrefsStore 文件型偏好存储。
//
// 文件不存在 → 返回默认值；解析失败 → 返回错误并保留旧文件备份。
// 每次写入采用 tmp + rename 原子替换，避免崩溃时半截文件。
type PrefsStore struct {
	path string

	mu     sync.RWMutex
	cached models.Prefs
	loaded bool
}

// NewPrefsStore 创建存储（不立即读盘）。
func NewPrefsStore(path string) *PrefsStore {
	return &PrefsStore{path: path}
}

// load 读取并解析文件到内存缓存。
// 文件不存在 → 返回默认值。
// 解析失败 → 备份坏文件并返回默认值（不返回错误，确保服务可用）。
func (s *PrefsStore) load() error {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			s.cached = models.DefaultPrefs()
			s.loaded = true
			return nil
		}
		return err
	}
	p := models.DefaultPrefs()
	if err := json.Unmarshal(data, &p); err != nil {
		// 备份用时间戳 + 纳秒后缀,避免连续两次损坏互相覆盖。
		// 旧实现只用秒级时间戳,同一秒内连续两次坏文件会覆盖第一次的备份。
		stamp := time.Now().Format("20060102150405") + "-" + fmt.Sprintf("%d", time.Now().UnixNano()%1_000_000)
		_ = os.Rename(s.path, s.path+".corrupt."+stamp)
		s.cached = models.DefaultPrefs()
		s.loaded = true
		return nil
	}
	s.cached = normalize(p)
	s.loaded = true
	return nil
}

func normalize(p models.Prefs) models.Prefs {
	d := models.DefaultPrefs()
	if p.Favorites == nil {
		p.Favorites = d.Favorites
	}
	if p.History == nil {
		p.History = d.History
	}
	if p.MaxRecent <= 0 {
		p.MaxRecent = d.MaxRecent
	}
	if p.Theme == "" {
		p.Theme = d.Theme
	}
	// 旧版偏好文件没有 appMode 字段，反序列化后是零值：归一化成默认工作台。
	if !models.IsValidAppMode(string(p.AppMode)) {
		p.AppMode = d.AppMode
	}

	// 偏好文件会直接通过 API 返回，绝对路径或畸形标识不得暴露；
	// 仅保留当前不透明资源 ID 契约。
	favorites := make([]string, 0, len(p.Favorites))
	seenFavorites := make(map[string]struct{}, len(p.Favorites))
	for _, id := range p.Favorites {
		if !models.IsFavoriteResourceID(id) {
			continue
		}
		if _, exists := seenFavorites[id]; exists {
			continue
		}
		seenFavorites[id] = struct{}{}
		favorites = append(favorites, id)
	}
	const maxFavorites = 500
	if len(favorites) > maxFavorites {
		favorites = favorites[len(favorites)-maxFavorites:]
	}
	p.Favorites = favorites

	history := make([]models.HistoryEntry, 0, min(len(p.History), p.MaxRecent))
	seenHistory := make(map[string]struct{}, len(p.History))
	for _, entry := range p.History {
		if !models.IsAlbumID(entry.AlbumID) {
			continue
		}
		if _, exists := seenHistory[entry.AlbumID]; exists {
			continue
		}
		seenHistory[entry.AlbumID] = struct{}{}
		history = append(history, entry)
		if len(history) == p.MaxRecent {
			break
		}
	}
	p.History = history

	return p
}

// Get 返回当前偏好（首次访问时自动加载）。
func (s *PrefsStore) Get() (models.Prefs, error) {
	s.mu.RLock()
	if s.loaded {
		p := clonePrefs(s.cached)
		s.mu.RUnlock()
		return p, nil
	}
	s.mu.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.loaded {
		if err := s.load(); err != nil {
			return models.DefaultPrefs(), err
		}
	}
	return clonePrefs(s.cached), nil
}

// Patch 在一次事务内修改偏好，避免覆盖并发收藏、历史或其它设置更新。
func (s *PrefsStore) Patch(change func(*models.Prefs)) (models.Prefs, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return models.Prefs{}, err
	}
	next := clonePrefs(s.cached)
	change(&next)
	if err := s.commitLocked(next); err != nil {
		return models.Prefs{}, err
	}
	return clonePrefs(s.cached), nil
}

// Update 全量替换内部快照；HTTP 部分更新必须使用 Patch。
func (s *PrefsStore) Update(p models.Prefs) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return err
	}
	return s.commitLocked(normalize(clonePrefs(p)))
}

// AddFavorite 添加收藏（幂等）。返回更新后的列表。
func (s *PrefsStore) AddFavorite(resourceID string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return nil, err
	}
	if !models.IsFavoriteResourceID(resourceID) {
		return nil, errors.New("invalid favorite resource id")
	}
	for _, f := range s.cached.Favorites {
		if f == resourceID {
			return append([]string{}, s.cached.Favorites...), nil
		}
	}
	next := clonePrefs(s.cached)
	next.Favorites = append(next.Favorites, resourceID)
	// 软上限由 normalize 在 commitLocked 里统一裁剪,这里不重复。
	if err := s.commitLocked(next); err != nil {
		return nil, err
	}
	return append([]string{}, s.cached.Favorites...), nil
}

// RemoveFavorite 移除收藏。
func (s *PrefsStore) RemoveFavorite(resourceID string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return nil, err
	}
	next := clonePrefs(s.cached)
	out := next.Favorites[:0]
	for _, f := range s.cached.Favorites {
		if f != resourceID {
			out = append(out, f)
		}
	}
	next.Favorites = out
	if err := s.commitLocked(next); err != nil {
		return nil, err
	}
	return append([]string{}, s.cached.Favorites...), nil
}

// PruneInvalidFavorites 按调用方提供的当前资源目录移除已失效收藏。
// smart:<tag> 等非文件系统引用也由 predicate 判断，不再对 ID 执行 os.Stat。
func (s *PrefsStore) PruneInvalidFavorites(predicate func(string) bool) (removed []string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return nil, err
	}
	next := clonePrefs(s.cached)
	out := next.Favorites[:0]
	for _, f := range s.cached.Favorites {
		if predicate != nil && predicate(f) {
			out = append(out, f)
		} else {
			removed = append(removed, f)
		}
	}
	next.Favorites = out
	if len(removed) == 0 {
		return []string{}, nil
	}
	if err := s.commitLocked(next); err != nil {
		return removed, err
	}
	return removed, nil
}

// AddHistory 添加一条历史记录（LRU 去重 + 上限裁剪）。
func (s *PrefsStore) AddHistory(entry models.HistoryEntry) ([]models.HistoryEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return nil, err
	}

	// 去重（最新优先）
	if !models.IsAlbumID(entry.AlbumID) {
		return nil, errors.New("invalid history album id")
	}
	out := []models.HistoryEntry{entry}
	for _, h := range s.cached.History {
		if h.AlbumID == entry.AlbumID {
			continue
		}
		out = append(out, h)
	}
	// 按时间倒序
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].OpenedAt.After(out[j].OpenedAt)
	})
	// 裁剪
	if len(out) > s.cached.MaxRecent {
		out = out[:s.cached.MaxRecent]
	}
	next := clonePrefs(s.cached)
	next.History = out
	if err := s.commitLocked(next); err != nil {
		return nil, err
	}
	return append([]models.HistoryEntry{}, s.cached.History...), nil
}

// ClearHistory 清空历史。
func (s *PrefsStore) ClearHistory() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return err
	}
	next := clonePrefs(s.cached)
	next.History = []models.HistoryEntry{}
	return s.commitLocked(next)
}

// ---- 内部 ----

// ensureLoaded 必须在已持锁时调用。
func (s *PrefsStore) ensureLoaded() error {
	if s.loaded {
		return nil
	}
	return s.load()
}

// commitLocked 必须在已持锁时调用。磁盘替换成功后才发布新的内存快照。
//
// 关键：tmp.Sync() + Close + Rename 三步走,保证崩溃时磁盘要么是旧
// 文件、要么是新文件,绝不会是半截。旧实现只 WriteFile + Rename,
// 进程在两步之间被杀会出现"目标文件丢失 + 残留 .tmp"的双输。
func (s *PrefsStore) commitLocked(next models.Prefs) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	next = normalize(next)
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	// Sync 把数据刷到磁盘(过文件系统 cache),然后 Close 释放 fd。
	// Rename 是原子的,跨平台保证 s.path 完整切换。
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename %s -> %s: %w", tmp, s.path, err)
	}
	s.cached = next
	return nil
}

func clonePrefs(p models.Prefs) models.Prefs {
	out := p
	out.Favorites = append([]string{}, p.Favorites...)
	out.History = append([]models.HistoryEntry{}, p.History...)
	return out
}
