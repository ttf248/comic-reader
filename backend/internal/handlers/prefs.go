package handlers

import (
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
	"github.com/tianlongxiang/local-gallery/internal/store"
)

// PrefsGetHandler GET /api/prefs
func PrefsGetHandler(s *store.PrefsStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		p, err := s.Get()
		if err != nil {
			return prefsInternalError(c)
		}
		return c.JSON(p)
	}
}

// PrefsPatchHandler PATCH /api/prefs
//
// 仅覆盖传入的非零字段。
func PrefsPatchHandler(s *store.PrefsStore) fiber.Handler {
	type patch struct {
		Theme            *string `json:"theme"`
		AutoSwitchAlbum  *bool   `json:"autoSwitchAlbum"`
		ShowSwitchNotif  *bool   `json:"showSwitchNotif"`
		SidebarCollapsed *bool   `json:"sidebarCollapsed"`
		MaxRecent        *int    `json:"maxRecent"`
		AppMode          *string `json:"appMode"`
	}

	return func(c *fiber.Ctx) error {
		var p patch
		if err := c.BodyParser(&p); err != nil {
			return writeError(c, fiber.StatusBadRequest, "invalid_prefs_body", "invalid preferences body")
		}
		if p.AppMode != nil && !models.IsValidAppMode(*p.AppMode) {
			return writeError(c, fiber.StatusBadRequest, "invalid_app_mode", "appMode must be photo, comic or all")
		}

		cur, err := s.Patch(func(cur *models.Prefs) {
			if p.Theme != nil {
				cur.Theme = *p.Theme
			}
			if p.AutoSwitchAlbum != nil {
				cur.AutoSwitchAlbum = *p.AutoSwitchAlbum
			}
			if p.ShowSwitchNotif != nil {
				cur.ShowSwitchNotif = *p.ShowSwitchNotif
			}
			if p.SidebarCollapsed != nil {
				cur.SidebarCollapsed = *p.SidebarCollapsed
			}
			if p.MaxRecent != nil && *p.MaxRecent > 0 {
				cur.MaxRecent = *p.MaxRecent
			}
			if p.AppMode != nil {
				cur.AppMode = models.NormalizeAppMode(*p.AppMode)
			}

		})
		if err != nil {
			return prefsInternalError(c)
		}
		return c.JSON(cur)
	}
}

// FavoritesListHandler GET /api/favorites
func FavoritesListHandler(s *store.PrefsStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		p, err := s.Get()
		if err != nil {
			return prefsInternalError(c)
		}
		return c.JSON(fiber.Map{"favorites": p.Favorites})
	}
}

// FavoriteAddHandler POST /api/favorites
//
// Body: {"resourceId": "a_... | c_... | smart:<tag>"}
func FavoriteAddHandler(s *store.PrefsStore) fiber.Handler {
	type req struct {
		ResourceID string `json:"resourceId"`
	}
	return func(c *fiber.Ctx) error {
		var r req
		if err := c.BodyParser(&r); err != nil || !models.IsFavoriteResourceID(r.ResourceID) {
			return writeError(c, fiber.StatusBadRequest, "invalid_resource_id", "resource id is invalid")
		}
		out, err := s.AddFavorite(r.ResourceID)
		if err != nil {
			return prefsInternalError(c)
		}
		return c.JSON(fiber.Map{"favorites": out})
	}
}

// FavoriteRemoveHandler DELETE /api/favorites
//
// Body: {"resourceId": "..."}
func FavoriteRemoveHandler(s *store.PrefsStore) fiber.Handler {
	type req struct {
		ResourceID string `json:"resourceId"`
	}
	return func(c *fiber.Ctx) error {
		var r req
		if err := c.BodyParser(&r); err != nil || !models.IsFavoriteResourceID(r.ResourceID) {
			return writeError(c, fiber.StatusBadRequest, "invalid_resource_id", "resource id is invalid")
		}
		out, err := s.RemoveFavorite(r.ResourceID)
		if err != nil {
			return prefsInternalError(c)
		}
		return c.JSON(fiber.Map{"favorites": out})
	}
}

// HistoryListHandler GET /api/history
func HistoryListHandler(s *store.PrefsStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		p, err := s.Get()
		if err != nil {
			return prefsInternalError(c)
		}
		return c.JSON(fiber.Map{"history": p.History})
	}
}

// HistoryAddHandler POST /api/history
//
// Body: {"albumId": "a_...", "name": "...", "imageCount": 42}
func HistoryAddHandler(s *store.PrefsStore) fiber.Handler {
	type req struct {
		AlbumID    string `json:"albumId"`
		Name       string `json:"name"`
		ImageCount int    `json:"imageCount"`
	}
	return func(c *fiber.Ctx) error {
		var r req
		if err := c.BodyParser(&r); err != nil || !models.IsAlbumID(r.AlbumID) {
			return writeError(c, fiber.StatusBadRequest, "invalid_album_id", "album id is invalid")
		}
		entry := models.HistoryEntry{
			AlbumID:    r.AlbumID,
			Name:       r.Name,
			ImageCount: r.ImageCount,
			OpenedAt:   time.Now(),
		}
		out, err := s.AddHistory(entry)
		if err != nil {
			return prefsInternalError(c)
		}
		return c.JSON(fiber.Map{"history": out})
	}
}

// HistoryClearHandler DELETE /api/history
func HistoryClearHandler(s *store.PrefsStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if err := s.ClearHistory(); err != nil {
			return prefsInternalError(c)
		}
		return c.JSON(fiber.Map{"ok": true})
	}
}

// FavoritesPruneHandler POST /api/favorites/prune
//
// 移除当前资源目录中已不存在的收藏；智能标签保留，避免临时空标签丢失。
func FavoritesPruneHandler(s *store.PrefsStore, catalog *services.ResourceCatalog) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if catalog == nil {
			return writeError(c, fiber.StatusConflict, "library_not_ready", "library not ready")
		}
		snapshot := catalog.Acquire()
		if !snapshot.Ready() {
			return writeError(c, fiber.StatusConflict, "library_not_ready", "library not ready")
		}
		removed, err := s.PruneInvalidFavorites(func(id string) bool {
			if len(id) > len("smart:") && id[:len("smart:")] == "smart:" {
				return true
			}
			ref, ok := snapshot.Lookup(id)
			return ok && (ref.Kind == services.ResourceAlbum || ref.Kind == services.ResourceCollection)
		})
		if err != nil {
			return prefsInternalError(c)
		}
		return c.JSON(fiber.Map{"removed": removed})
	}
}

func prefsInternalError(c *fiber.Ctx) error {
	return writeError(c, fiber.StatusInternalServerError, "preferences_unavailable", "preferences unavailable")
}
