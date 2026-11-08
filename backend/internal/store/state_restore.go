package store

import (
	"errors"
	"reflect"
	"sort"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

var ErrStateChanged = errors.New("state changed since preview")

// CompareAndPatch 在同一锁内比较预览状态、合并选中类别并原子持久化。
func (s *PrefsStore) CompareAndPatch(expected models.Prefs, change func(*models.Prefs)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return err
	}
	if !reflect.DeepEqual(s.cached, expected) {
		return ErrStateChanged
	}
	next := clonePrefs(s.cached)
	change(&next)
	return s.commitLocked(normalize(next))
}

func (s *ActivityStore) Snapshot() ([]models.Activity, error) {
	if err := s.ensureLoaded(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return activityList(s.items), nil
}

func activityList(items map[string]models.Activity) []models.Activity {
	result := make([]models.Activity, 0, len(items))
	for _, a := range items {
		result = append(result, a)
	}
	sort.Slice(result, func(i, j int) bool {
		a, _ := result[i].Identity().Key()
		b, _ := result[j].Identity().Key()
		return a < b
	})
	return result
}

func (s *ActivityStore) CompareAndReplace(expected, next []models.Activity) error {
	items := map[string]models.Activity{}
	for _, a := range next {
		normalized, err := models.NormalizeActivity(a)
		if err != nil {
			return err
		}
		key, _ := a.Identity().Key()
		items[key] = normalized
	}
	if err := s.ensureLoaded(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !reflect.DeepEqual(activityList(s.items), expected) {
		return ErrStateChanged
	}
	if err := s.commitLocked(items); err != nil {
		return err
	}
	s.revision++
	return nil
}
