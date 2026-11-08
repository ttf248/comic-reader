package store

import (
	"errors"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

var ErrFavoriteLimit = errors.New("favorite limit exceeded")

// BatchFavorites 在一次锁内处理整批收藏，超限时拒绝而非裁掉已有收藏。
func (s *PrefsStore) BatchFavorites(ids []string, add bool) ([]string, int, error) {
	for _, id := range ids {
		if !models.IsFavoriteResourceID(id) {
			return nil, 0, errors.New("invalid favorite identity")
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return nil, 0, err
	}
	next := clonePrefs(s.cached)
	changed := 0
	if add {
		seen := map[string]bool{}
		for _, id := range next.Favorites {
			seen[id] = true
		}
		for _, id := range ids {
			if !seen[id] {
				next.Favorites = append(next.Favorites, id)
				seen[id] = true
				changed++
			}
		}
		if len(next.Favorites) > maxFavorites {
			return nil, 0, ErrFavoriteLimit
		}
	} else {
		remove := map[string]bool{}
		for _, id := range ids {
			remove[id] = true
		}
		kept := make([]string, 0, len(next.Favorites))
		for _, id := range next.Favorites {
			if remove[id] {
				changed++
			} else {
				kept = append(kept, id)
			}
		}
		next.Favorites = kept
	}
	if changed > 0 {
		if err := s.commitLocked(next); err != nil {
			return nil, 0, err
		}
	}
	return append([]string{}, s.cached.Favorites...), changed, nil
}

func (s *ActivityStore) DeleteBatch(identities []models.ActivityIdentity) (int, error) {
	keys := map[string]bool{}
	for _, identity := range identities {
		key, ok := identity.Key()
		if !ok {
			return 0, errors.New("invalid activity identity")
		}
		keys[key] = true
	}
	if err := s.ensureLoaded(); err != nil {
		return 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := cloneActivityMap(s.items)
	deleted := 0
	for key := range keys {
		if _, ok := next[key]; ok {
			delete(next, key)
			deleted++
		}
	}
	if deleted == 0 {
		return 0, nil
	}
	if err := s.commitLocked(next); err != nil {
		return 0, err
	}
	s.revision++
	return deleted, nil
}
