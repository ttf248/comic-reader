// Package store 提供活动记录的持久化与原子读写。
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

const activityFileVersion = 1

type activityFile struct {
	Version    int               `json:"version"`
	Activities []models.Activity `json:"activities"`
}

// ActivityStore 将高频阅读/播放活动与低频偏好文件分离，避免
// GET /prefs 携带不受限的活动列表。内存中按不透明 ID 组合键索引。
type ActivityStore struct {
	path string

	mu     sync.RWMutex
	items  map[string]models.Activity
	loaded bool
	// revision 仅在成功持久化活动变更后递增，供依赖活动派生结果的内存索引失效。
	// 它是进程内版本号，不会写入活动文件或暴露给 HTTP 客户端。
	revision uint64
}

// NewActivityStore 创建活动存储。
func NewActivityStore(path string) *ActivityStore {
	return &ActivityStore{path: path}
}

// Load 提前加载活动文件。
func (s *ActivityStore) Load() error {
	return s.ensureLoaded()
}

// Get 按精确标识查询单条活动。
func (s *ActivityStore) Get(identity models.ActivityIdentity) (models.Activity, bool, error) {
	key, ok := identity.Key()
	if !ok {
		return models.Activity{}, false, errors.New("invalid activity identity")
	}
	if err := s.ensureLoaded(); err != nil {
		return models.Activity{}, false, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	activity, exists := s.items[key]
	return activity, exists, nil
}

// Query 按请求顺序返回已存在的精确活动，缺失项不占位。
func (s *ActivityStore) Query(identities []models.ActivityIdentity) ([]models.Activity, error) {
	if len(identities) == 0 {
		return []models.Activity{}, nil
	}
	keys := make([]string, len(identities))
	for i, identity := range identities {
		key, ok := identity.Key()
		if !ok {
			return nil, errors.New("invalid activity identity")
		}
		keys[i] = key
	}
	if err := s.ensureLoaded(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]models.Activity, 0, len(keys))
	seen := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		if activity, exists := s.items[key]; exists {
			out = append(out, activity)
		}
	}
	return out, nil
}

// StartedImageAlbumIDs 返回至少保存过一条图片阅读活动的相册 ID 集合。
// 该派生结果只用于图像库的未读统计，不会暴露活动位置、时间或视频记录。
func (s *ActivityStore) StartedImageAlbumIDs() (map[string]struct{}, error) {
	ids, _, err := s.StartedImageAlbumIDsSnapshot()
	return ids, err
}

// StartedImageAlbumIDsSnapshot 返回图片活动派生的相册 ID 集合及当前进程内
// 活动版本。调用方可用版本安全复用只依赖该集合的派生索引。
func (s *ActivityStore) StartedImageAlbumIDsSnapshot() (map[string]struct{}, uint64, error) {
	if err := s.ensureLoaded(); err != nil {
		return nil, 0, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := make(map[string]struct{})
	for _, activity := range s.items {
		if activity.MediaKind == models.MediaKindImage {
			ids[activity.AlbumID] = struct{}{}
		}
	}
	return ids, s.revision, nil
}

// StartedVideoAlbumIDsSnapshot 返回视频活动派生的相册 ID 集合及当前进程内
// 活动版本。纯视频相册没有图片活动，未读统计只能依据视频活动判定
// "已经翻开过"；与图片集合分开返回，避免两种媒体互相污染。
func (s *ActivityStore) StartedVideoAlbumIDsSnapshot() (map[string]struct{}, uint64, error) {
	if err := s.ensureLoaded(); err != nil {
		return nil, 0, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := make(map[string]struct{})
	for _, activity := range s.items {
		if activity.MediaKind == models.MediaKindVideo {
			ids[activity.AlbumID] = struct{}{}
		}
	}
	return ids, s.revision, nil
}

// StartedAlbumIDsSnapshot 在一次加锁内返回漫画、照片与视频活动各自派生的
// 相册 ID 集合以及当前活动版本。未读统计同时需要三种集合，用同一版本号
// 缓存派生索引。
//
// 漫画与照片分开统计：同一本相册可以在两种用途之间切换，
// 「照片看到第 12 张」不应该让「漫画读到第 12 页」变成已读。
func (s *ActivityStore) StartedAlbumIDsSnapshot() (image, photo, video map[string]struct{}, revision uint64, err error) {
	if err = s.ensureLoaded(); err != nil {
		return nil, nil, nil, 0, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	image = make(map[string]struct{})
	photo = make(map[string]struct{})
	video = make(map[string]struct{})
	for _, activity := range s.items {
		switch activity.MediaKind {
		case models.MediaKindImage:
			image[activity.AlbumID] = struct{}{}
		case models.MediaKindPhoto:
			photo[activity.AlbumID] = struct{}{}
		case models.MediaKindVideo:
			video[activity.AlbumID] = struct{}{}
		}
	}
	return image, photo, video, s.revision, nil
}

// ImageActivitySnapshot 返回全部漫画阅读活动、对应相册 ID 集合和当前活动版本。
// 首页仪表盘使用这一致性快照构建在读与未读摘要；它不会返回视频播放记录，
// 也不读取媒体库或文件系统路径。
func (s *ActivityStore) ImageActivitySnapshot() ([]models.Activity, map[string]struct{}, uint64, error) {
	return s.activitySnapshot(models.MediaKindImage)
}

// PhotoActivitySnapshot 返回全部照片浏览活动、对应相册 ID 集合和当前活动版本。
// 它与漫画阅读活动分开：两种用途的进度互不影响。
func (s *ActivityStore) PhotoActivitySnapshot() ([]models.Activity, map[string]struct{}, uint64, error) {
	return s.activitySnapshot(models.MediaKindPhoto)
}

// activitySnapshot 返回指定媒体类型的全部活动及其相册 ID 集合。
func (s *ActivityStore) activitySnapshot(kind models.MediaKind) ([]models.Activity, map[string]struct{}, uint64, error) {
	if err := s.ensureLoaded(); err != nil {
		return nil, nil, 0, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	activities := make([]models.Activity, 0, len(s.items))
	ids := make(map[string]struct{})
	for _, activity := range s.items {
		if activity.MediaKind == kind {
			activities = append(activities, activity)
			ids[activity.AlbumID] = struct{}{}
		}
	}
	return activities, ids, s.revision, nil
}

// Set 新增或覆盖单条活动。
func (s *ActivityStore) Set(activity models.Activity) error {
	return s.SetBatch([]models.Activity{activity})
}

// SetBatch 先校验整批数据，再仅执行一次原子落盘。
func (s *ActivityStore) SetBatch(activities []models.Activity) error {
	if len(activities) == 0 {
		return nil
	}
	normalized := make([]models.Activity, len(activities))
	for i, activity := range activities {
		item, err := models.NormalizeActivity(activity)
		if err != nil {
			return err
		}
		if item.Updated.IsZero() {
			item.Updated = time.Now().UTC()
		}
		normalized[i] = item
	}
	if err := s.ensureLoaded(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := cloneActivityMap(s.items)
	changed := false
	for _, activity := range normalized {
		key, _ := activity.Identity().Key()
		if current, exists := next[key]; exists && current.Updated.After(activity.Updated) {
			continue
		}
		next[key] = activity
		changed = true
	}
	if !changed {
		return nil
	}
	if err := s.commitLocked(next); err != nil {
		return err
	}
	s.revision++
	return nil
}

// Delete 删除单条活动，不存在时保持幂等。
func (s *ActivityStore) Delete(identity models.ActivityIdentity) (bool, error) {
	key, ok := identity.Key()
	if !ok {
		return false, errors.New("invalid activity identity")
	}
	if err := s.ensureLoaded(); err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.items[key]; !exists {
		return false, nil
	}
	next := cloneActivityMap(s.items)
	delete(next, key)
	if err := s.commitLocked(next); err != nil {
		return false, err
	}
	s.revision++
	return true, nil
}

// Clear 清空所有图片与视频活动。
func (s *ActivityStore) Clear() (int, error) {
	if err := s.ensureLoaded(); err != nil {
		return 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	count := len(s.items)
	if count == 0 {
		return 0, nil
	}
	if err := s.commitLocked(map[string]models.Activity{}); err != nil {
		return 0, err
	}
	s.revision++
	return count, nil
}

func (s *ActivityStore) ensureLoaded() error {
	s.mu.RLock()
	if s.loaded {
		s.mu.RUnlock()
		return nil
	}
	s.mu.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loaded {
		return nil
	}
	return s.loadLocked()
}

func (s *ActivityStore) loadLocked() error {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		s.items = map[string]models.Activity{}
		s.loaded = true
		return nil
	}
	var disk activityFile
	if err := json.Unmarshal(data, &disk); err != nil {
		now := time.Now()
		stamp := now.Format("20060102150405") + "-" + fmt.Sprintf("%d", now.UnixNano()%1_000_000)
		if renameErr := os.Rename(s.path, s.path+".corrupt."+stamp); renameErr != nil {
			return fmt.Errorf("backup corrupt activity store: %w", renameErr)
		}
		s.items = map[string]models.Activity{}
		s.loaded = true
		return nil
	}
	if disk.Version != activityFileVersion {
		if err := isolateUnsupportedFile(s.path); err != nil {
			return fmt.Errorf("isolate unsupported activity store version %d: %w", disk.Version, err)
		}
		s.items = map[string]models.Activity{}
		s.loaded = true
		return nil
	}
	s.items = make(map[string]models.Activity, len(disk.Activities))
	for _, activity := range disk.Activities {
		normalized, normalizeErr := models.NormalizeActivity(activity)
		if normalizeErr != nil {
			continue
		}
		key, _ := normalized.Identity().Key()
		if current, exists := s.items[key]; !exists || normalized.Updated.After(current.Updated) {
			s.items[key] = normalized
		}
	}
	s.loaded = true
	return nil
}

func isolateUnsupportedFile(path string) error {
	stamp := time.Now().Format("20060102150405") + "-" + fmt.Sprintf("%d", time.Now().UnixNano()%1_000_000)
	return os.Rename(path, path+".unsupported."+stamp)
}

func (s *ActivityStore) commitLocked(items map[string]models.Activity) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	activities := make([]models.Activity, 0, len(items))
	for _, activity := range items {
		activities = append(activities, activity)
	}
	sort.Slice(activities, func(i, j int) bool {
		if activities[i].Updated.Equal(activities[j].Updated) {
			left, _ := activities[i].Identity().Key()
			right, _ := activities[j].Identity().Key()
			return left < right
		}
		return activities[i].Updated.After(activities[j].Updated)
	})
	data, err := json.MarshalIndent(activityFile{Version: activityFileVersion, Activities: activities}, "", "  ")
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
		return fmt.Errorf("replace activity store: %w", err)
	}
	s.items = items
	s.loaded = true
	return nil
}

func cloneActivityMap(source map[string]models.Activity) map[string]models.Activity {
	out := make(map[string]models.Activity, len(source))
	for key, activity := range source {
		out[key] = activity
	}
	return out
}
