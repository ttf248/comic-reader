package handlers

import (
	"strconv"

	"github.com/gofiber/fiber/v2"
	"github.com/tianlongxiang/local-gallery/internal/httputil"
	"github.com/tianlongxiang/local-gallery/internal/services"
	"github.com/tianlongxiang/local-gallery/internal/store"
)

// LibraryQueryHandler 在服务端完成排序、筛选，再返回一页摘要。
func LibraryQueryHandler(catalog *services.ResourceCatalog, prefs *store.PrefsStore, activities *store.ActivityStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		kind, ok := parseLibraryKind(c)
		if !ok {
			return nil
		}
		limit, ok := parseLibraryPageLimit(c)
		if !ok {
			return nil
		}
		minimum := 0
		if raw := c.Query("minImageCount"); raw != "" {
			var err error
			minimum, err = strconv.Atoi(raw)
			if err != nil {
				return httputil.BadRequest(c, "invalid_library_query", "invalid minimum image count")
			}
		}
		q := services.LibraryQuery{
			Kind:               kind,
			Parent:             c.Query("parent"),
			Tag:                c.Query("tag"),
			View:               c.Query("view"),
			Query:              c.Query("q"),
			Year:               c.Query("year"),
			MinImageCount:      minimum,
			Sort:               c.Query("sort"),
			ExcludeYearTargets: c.Query("excludeYearTargets") == "1" || c.Query("excludeYearTargets") == "true",
		}
		if err := q.Normalize(); err != nil {
			return httputil.BadRequest(c, "invalid_library_query", "invalid list query")
		}
		p, err := prefs.Get()
		if err != nil {
			return httputil.Internal(c, "state_read_failed", "unable to read list state")
		}
		snapshot := catalog.Acquire()
		page, err := services.PageLibraryQuery(snapshot, q, p.History, c.Query("cursor"), limit)
		if err != nil {
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		if q.Tag != "" && q.Kind == services.LibraryKindComic {
			activity, _, _, err := activities.ImageActivitySnapshot()
			if err != nil {
				return httputil.Internal(c, "state_read_failed", "unable to read list state")
			}
			page.CompletedCount = services.QueryCompletedCount(snapshot, q, activity)
		}
		return c.JSON(fiber.Map{"ok": true, "page": page})
	}
}
