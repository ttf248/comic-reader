package handlers

import (
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/httputil"
	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/store"
)

const maxActivityBatch = 10_000

type activityInput struct {
	AlbumID    string           `json:"albumId"`
	MediaKind  models.MediaKind `json:"mediaKind"`
	ItemID     string           `json:"itemId"`
	PageIndex  int              `json:"pageIndex"`
	PageCount  int              `json:"pageCount"`
	PositionMS int64            `json:"positionMs"`
	DurationMS int64            `json:"durationMs"`
}

func (input activityInput) model(updated time.Time) (models.Activity, error) {
	return models.NormalizeActivity(models.Activity{
		AlbumID:    input.AlbumID,
		MediaKind:  input.MediaKind,
		ItemID:     input.ItemID,
		PageIndex:  input.PageIndex,
		PageCount:  input.PageCount,
		PositionMS: input.PositionMS,
		DurationMS: input.DurationMS,
		Updated:    updated,
	})
}

// ActivityGetHandler GET /api/activity?albumId=...&mediaKind=image|video&itemId=...
func ActivityGetHandler(s *store.ActivityStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		identity, ok := activityIdentityFromQuery(c)
		if !ok {
			return httputil.BadRequest(c, "invalid_activity_identity", "activity identity is invalid")
		}
		activity, exists, err := s.Get(identity)
		if err != nil {
			return activityInternalError(c)
		}
		if !exists {
			return httputil.NotFound(c, "activity_not_found", "activity was not found")
		}
		return c.JSON(activity)
	}
}

// ActivityPutHandler PUT /api/activity
func ActivityPutHandler(s *store.ActivityStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		var input activityInput
		if err := c.BodyParser(&input); err != nil {
			return httputil.BadRequest(c, "invalid_activity_body", "activity request body is invalid")
		}
		activity, err := input.model(time.Now().UTC())
		if err != nil {
			return httputil.BadRequest(c, "invalid_activity", "activity values are invalid")
		}
		stored, err := s.SetAndGet(activity)
		if err != nil {
			return activityInternalError(c)
		}
		return c.JSON(stored)
	}
}

// ActivityQueryHandler POST /api/activity/query
// Body: {"items":[{"albumId":"a_...","mediaKind":"image"}, ...]}
func ActivityQueryHandler(s *store.ActivityStore) fiber.Handler {
	type request struct {
		Items []models.ActivityIdentity `json:"items"`
	}
	return func(c *fiber.Ctx) error {
		var body request
		if err := c.BodyParser(&body); err != nil || len(body.Items) == 0 {
			return httputil.BadRequest(c, "missing_activity_items", "activity items are required")
		}
		if len(body.Items) > maxActivityBatch {
			return httputil.BadRequest(c, "activity_batch_too_large", fmt.Sprintf("too many items (max %d)", maxActivityBatch))
		}
		for _, identity := range body.Items {
			if _, ok := identity.Key(); !ok {
				return httputil.BadRequest(c, "invalid_activity_identity", "activity identity is invalid")
			}
		}
		activities, err := s.Query(body.Items)
		if err != nil {
			return activityInternalError(c)
		}
		return c.JSON(fiber.Map{"activities": activities, "count": len(activities)})
	}
}

// ActivityBatchPutHandler PUT /api/activity/batch
func ActivityBatchPutHandler(s *store.ActivityStore) fiber.Handler {
	type request struct {
		Activities []activityInput `json:"activities"`
	}
	return func(c *fiber.Ctx) error {
		var body request
		if err := c.BodyParser(&body); err != nil || len(body.Activities) == 0 {
			return httputil.BadRequest(c, "missing_activities", "activities are required")
		}
		if len(body.Activities) > maxActivityBatch {
			return httputil.BadRequest(c, "activity_batch_too_large", fmt.Sprintf("too many activities (max %d)", maxActivityBatch))
		}
		now := time.Now().UTC()
		activities := make([]models.Activity, len(body.Activities))
		for i, input := range body.Activities {
			activity, err := input.model(now)
			if err != nil {
				return httputil.BadRequest(c, "invalid_activity", "activity values are invalid")
			}
			activities[i] = activity
		}
		if err := s.SetBatch(activities); err != nil {
			return activityInternalError(c)
		}
		return c.JSON(fiber.Map{"ok": true, "updated": len(activities)})
	}
}

// ActivityDeleteHandler DELETE /api/activity?... 幂等删除单条活动。
func ActivityDeleteHandler(s *store.ActivityStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		identity, ok := activityIdentityFromQuery(c)
		if !ok {
			return httputil.BadRequest(c, "invalid_activity_identity", "activity identity is invalid")
		}
		removed, err := s.Delete(identity)
		if err != nil {
			return activityInternalError(c)
		}
		return c.JSON(fiber.Map{"ok": true, "removed": removed})
	}
}

// ActivityClearHandler DELETE /api/activity/all 清空所有媒体活动。
func ActivityClearHandler(s *store.ActivityStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		removed, err := s.Clear()
		if err != nil {
			return activityInternalError(c)
		}
		return c.JSON(fiber.Map{"ok": true, "removed": removed})
	}
}

func activityIdentityFromQuery(c *fiber.Ctx) (models.ActivityIdentity, bool) {
	identity := models.ActivityIdentity{
		AlbumID:   c.Query("albumId"),
		MediaKind: models.MediaKind(c.Query("mediaKind")),
		ItemID:    c.Query("itemId"),
	}
	_, ok := identity.Key()
	return identity, ok
}

func activityInternalError(c *fiber.Ctx) error {
	return httputil.Internal(c, "activity_unavailable", "activity storage is unavailable")
}
