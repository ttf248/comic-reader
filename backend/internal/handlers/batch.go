package handlers

import (
	"errors"

	"github.com/gofiber/fiber/v2"
	"github.com/tianlongxiang/local-gallery/internal/httputil"
	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/store"
)

const maxSelectionBatch = 1000

func FavoritesBatchHandler(prefs *store.PrefsStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		var input struct {
			ResourceIDs []string `json:"resourceIds"`
			Action      string   `json:"action"`
		}
		if err := c.BodyParser(&input); err != nil || len(input.ResourceIDs) == 0 || len(input.ResourceIDs) > maxSelectionBatch || (input.Action != "add" && input.Action != "remove") {
			return httputil.BadRequest(c, "invalid_favorites_batch", "invalid favorites batch")
		}
		for _, id := range input.ResourceIDs {
			if !models.IsFavoriteResourceID(id) {
				return httputil.BadRequest(c, "invalid_favorites_batch", "invalid favorite identity")
			}
		}
		favorites, changed, err := prefs.BatchFavorites(input.ResourceIDs, input.Action == "add")
		if errors.Is(err, store.ErrFavoriteLimit) {
			return httputil.BadRequest(c, "favorite_limit", "favorite limit exceeded")
		}
		if err != nil {
			return prefsInternalError(c)
		}
		return c.JSON(fiber.Map{"favorites": favorites, "updated": changed})
	}
}

// ActivityBatchDeleteHandler 只重置漫画阅读活动，不删除视频播放位置。
func ActivityBatchDeleteHandler(activities *store.ActivityStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		var input struct {
			AlbumIDs []string `json:"albumIds"`
		}
		if err := c.BodyParser(&input); err != nil || len(input.AlbumIDs) == 0 || len(input.AlbumIDs) > maxSelectionBatch {
			return httputil.BadRequest(c, "invalid_activity_batch", "invalid activity batch")
		}
		identities := make([]models.ActivityIdentity, 0, len(input.AlbumIDs))
		for _, id := range input.AlbumIDs {
			if !models.IsAlbumID(id) {
				return httputil.BadRequest(c, "invalid_activity_batch", "invalid album identity")
			}
			identities = append(identities, models.ActivityIdentity{AlbumID: id, MediaKind: models.MediaKindImage})
		}
		deleted, err := activities.DeleteBatch(identities)
		if err != nil {
			return activityInternalError(c)
		}
		return c.JSON(fiber.Map{"deleted": deleted})
	}
}
