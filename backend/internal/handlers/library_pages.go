package handlers

import (
	"errors"
	"net/url"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/httputil"
	"github.com/tianlongxiang/local-gallery/internal/services"
	"github.com/tianlongxiang/local-gallery/internal/store"
)

// LibraryManifestHandler 返回库启动所需的轻量 manifest，不再传输完整目录树。
func LibraryManifestHandler(catalog *services.ResourceCatalog) fiber.Handler {
	return func(c *fiber.Ctx) error {
		snapshot := catalog.Acquire()
		manifest, err := services.BuildLibraryManifest(snapshot)
		if err != nil {
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		setLibraryRevisionETag(c, snapshot.Revision())
		return c.JSON(fiber.Map{"ok": true, "manifest": manifest})
	}
}

// LibraryChildrenPageHandler 分页返回 root 或 collection 的直属子节点。
// 推荐路由：GET /api/library/:id/children。
func LibraryChildrenPageHandler(catalog *services.ResourceCatalog) fiber.Handler {
	return func(c *fiber.Ctx) error {
		limit, ok := parseLibraryPageLimit(c)
		if !ok {
			return nil
		}
		parentID := strings.TrimSpace(c.Params("id"))
		if parentID == "" {
			return httputil.BadRequest(c, "missing_resource_id", "resource id is required")
		}
		snapshot := requestCatalogSnapshot(c, catalog)
		page, err := services.PageLibraryChildren(snapshot, parentID, c.Query("cursor"), limit)
		if err != nil {
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		setLibraryRevisionETag(c, snapshot.Revision())
		return c.JSON(fiber.Map{"ok": true, "page": page})
	}
}

// AlbumMediaPageHandler 按统一自然顺序分页返回图片和视频。
// 推荐路由：GET /api/albums/:id/media。
func AlbumMediaPageHandler(catalog *services.ResourceCatalog) fiber.Handler {
	return func(c *fiber.Ctx) error {
		limit, ok := parseLibraryPageLimit(c)
		if !ok {
			return nil
		}
		albumID := strings.TrimSpace(c.Params("id"))
		if albumID == "" {
			return httputil.BadRequest(c, "missing_resource_id", "resource id is required")
		}
		snapshot := requestCatalogSnapshot(c, catalog)
		page, err := services.PageAlbumMedia(snapshot, albumID, c.Query("cursor"), limit)
		if err != nil {
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		setLibraryRevisionETag(c, snapshot.Revision())
		return c.JSON(fiber.Map{"ok": true, "page": page})
	}
}

// LibraryUnreadAlbumsPageHandler 分页返回未读相册，避免前端下载全库后再批量筛选活动。
func LibraryUnreadAlbumsPageHandler(catalog *services.ResourceCatalog, activities *store.ActivityStore, unreadIndex *services.UnreadLibraryIndex) fiber.Handler {
	return func(c *fiber.Ctx) error {
		limit, ok := parseLibraryPageLimit(c)
		if !ok {
			return nil
		}
		started, activityRevision, err := activities.StartedImageAlbumIDsSnapshot()
		if err != nil {
			return httputil.Internal(c, "activity_unavailable", "activity storage is unavailable")
		}
		snapshot := catalog.Acquire()
		page, err := unreadIndex.Page(snapshot, started, activityRevision, c.Query("cursor"), limit)
		if err != nil {
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		setLibraryRevisionETag(c, snapshot.Revision())
		return c.JSON(fiber.Map{"ok": true, "page": page})
	}
}

// LibraryRandomAlbumHandler 返回一个随机相册摘要。scope=unread 时只从未开始阅读的相册中抽取。
func LibraryRandomAlbumHandler(catalog *services.ResourceCatalog, activities *store.ActivityStore, unreadIndex *services.UnreadLibraryIndex) fiber.Handler {
	return func(c *fiber.Ctx) error {
		scope := strings.TrimSpace(c.Query("scope"))
		if scope != "" && scope != "unread" {
			return httputil.BadRequest(c, "invalid_random_scope", "scope must be empty or unread")
		}
		snapshot := catalog.Acquire()
		if scope == "unread" {
			started, activityRevision, err := activities.StartedImageAlbumIDsSnapshot()
			if err != nil {
				return httputil.Internal(c, "activity_unavailable", "activity storage is unavailable")
			}
			album, pageErr := unreadIndex.Random(snapshot, started, activityRevision)
			if pageErr != nil {
				return writeLibraryPageError(c, pageErr, snapshot.Revision())
			}
			setLibraryRevisionETag(c, snapshot.Revision())
			return c.JSON(fiber.Map{"ok": true, "album": album, "revision": snapshot.Revision()})
		}
		album, err := services.RandomLibraryAlbum(snapshot)
		if err != nil {
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		setLibraryRevisionETag(c, snapshot.Revision())
		return c.JSON(fiber.Map{"ok": true, "album": album, "revision": snapshot.Revision()})
	}
}

// LibraryActivitySummaryHandler 为常驻侧边栏返回未读计数，避免下载全量相册摘要。
func LibraryActivitySummaryHandler(catalog *services.ResourceCatalog, activities *store.ActivityStore, unreadIndex *services.UnreadLibraryIndex) fiber.Handler {
	return func(c *fiber.Ctx) error {
		started, activityRevision, err := activities.StartedImageAlbumIDsSnapshot()
		if err != nil {
			return httputil.Internal(c, "activity_unavailable", "activity storage is unavailable")
		}
		snapshot := catalog.Acquire()
		summary, err := unreadIndex.Summary(snapshot, started, activityRevision)
		if err != nil {
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		return c.JSON(fiber.Map{"ok": true, "summary": summary})
	}
}

// LibraryHomeDashboardHandler 为首页提供未读计数、有限预览和全部在读摘要。
// 它避免首页为了几个入口下载跨根的完整相册列表和活动映射。
func LibraryHomeDashboardHandler(catalog *services.ResourceCatalog, activities *store.ActivityStore, unreadIndex *services.UnreadLibraryIndex) fiber.Handler {
	return func(c *fiber.Ctx) error {
		imageActivities, started, activityRevision, err := activities.ImageActivitySnapshot()
		if err != nil {
			return httputil.Internal(c, "activity_unavailable", "activity storage is unavailable")
		}
		snapshot := catalog.Acquire()
		dashboard, err := unreadIndex.Dashboard(snapshot, imageActivities, started, activityRevision)
		if err != nil {
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		setLibraryRevisionETag(c, snapshot.Revision())
		return c.JSON(fiber.Map{"ok": true, "dashboard": dashboard})
	}
}

// LibraryNodesQueryHandler 将收藏、最近浏览等本地 ID 列表批量解析为轻量摘要。
func LibraryNodesQueryHandler(catalog *services.ResourceCatalog) fiber.Handler {
	type request struct {
		IDs []string `json:"ids"`
	}
	return func(c *fiber.Ctx) error {
		var body request
		if err := c.BodyParser(&body); err != nil || len(body.IDs) == 0 {
			return httputil.BadRequest(c, "invalid_resource_ids", "ids must be a non-empty array")
		}
		if len(body.IDs) > services.MaxLibraryNodeQuery {
			return httputil.BadRequest(c, "too_many_resource_ids", "ids exceeds the batch limit")
		}
		ids := make([]string, 0, len(body.IDs))
		for _, id := range body.IDs {
			if id = strings.TrimSpace(id); id != "" {
				ids = append(ids, id)
			}
		}
		if len(ids) == 0 {
			return httputil.BadRequest(c, "invalid_resource_ids", "ids must contain a resource id")
		}
		snapshot := catalog.Acquire()
		result, err := services.ResolveLibraryNodes(snapshot, ids)
		if err != nil {
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		setLibraryRevisionETag(c, snapshot.Revision())
		return c.JSON(fiber.Map{"ok": true, "result": result})
	}
}

// LibraryTagsPageHandler 分页返回标签摘要，不携带标签下的完整相册数组。
func LibraryTagsPageHandler(catalog *services.ResourceCatalog) fiber.Handler {
	return func(c *fiber.Ctx) error {
		limit, ok := parseLibraryPageLimit(c)
		if !ok {
			return nil
		}
		snapshot := catalog.Acquire()
		page, err := services.PageLibraryTags(snapshot, c.Query("cursor"), limit)
		if err != nil {
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		setLibraryRevisionETag(c, snapshot.Revision())
		return c.JSON(fiber.Map{"ok": true, "page": page})
	}
}

// TagAlbumsPageHandler 分页返回指定标签下的相册摘要。
func TagAlbumsPageHandler(catalog *services.ResourceCatalog) fiber.Handler {
	return func(c *fiber.Ctx) error {
		limit, ok := parseLibraryPageLimit(c)
		if !ok {
			return nil
		}
		tag, err := url.PathUnescape(c.Params("tag"))
		if err != nil {
			return httputil.BadRequest(c, "invalid_tag", "tag path encoding is invalid")
		}
		tag = strings.TrimSpace(tag)
		if tag == "" {
			return httputil.BadRequest(c, "missing_tag", "tag is required")
		}
		snapshot := catalog.Acquire()
		page, err := services.PageTagAlbums(snapshot, tag, c.Query("cursor"), limit)
		if err != nil {
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		setLibraryRevisionETag(c, snapshot.Revision())
		return c.JSON(fiber.Map{"ok": true, "page": page})
	}
}

func parseLibraryPageLimit(c *fiber.Ctx) (int, bool) {
	raw := strings.TrimSpace(c.Query("limit"))
	if raw == "" {
		return services.DefaultLibraryPageLimit, true
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit <= 0 {
		_ = httputil.BadRequest(c, "invalid_page_limit", "limit must be a positive integer")
		return 0, false
	}
	return services.NormalizeLibraryPageLimit(limit), true
}

func writeLibraryPageError(c *fiber.Ctx, err error, revision uint64) error {
	switch {
	case errors.Is(err, services.ErrInvalidPageCursor):
		return httputil.BadRequest(c, "invalid_cursor", "page cursor is invalid for this resource")
	case errors.Is(err, services.ErrStalePageCursor):
		return httputil.Error(c, fiber.StatusConflict, "stale_cursor", "library changed; restart pagination", fiber.Map{
			"currentRevision": revision,
		})
	case errors.Is(err, services.ErrLibraryNotReady):
		return httputil.Error(c, fiber.StatusConflict, "library_not_ready", "scan the library before requesting pages")
	case errors.Is(err, services.ErrLibraryResourceNotFound):
		return httputil.NotFound(c, "resource_not_found", "resource id is invalid or stale")
	case errors.Is(err, services.ErrLibraryResourceWrongKind):
		return httputil.BadRequest(c, "invalid_resource_kind", "resource type does not support this operation")
	case errors.Is(err, services.ErrLibraryTagNotFound):
		return httputil.NotFound(c, "tag_not_found", "tag was not found")
	case errors.Is(err, services.ErrLibraryNoMatchingAlbum):
		return httputil.NotFound(c, "no_matching_album", "no album matches this request")
	default:
		return httputil.Internal(c, "library_page_failed", "unable to build library page")
	}
}

func setLibraryRevisionETag(c *fiber.Ctx, revision uint64) {
	c.Set(fiber.HeaderETag, `W/"library-`+strconv.FormatUint(revision, 10)+`"`)
}
