package handlers

import (
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"

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
		kind, ok := parseLibraryKind(c)
		if !ok {
			return nil
		}
		parentID := strings.TrimSpace(c.Params("id"))
		if parentID == "" {
			return httputil.BadRequest(c, "missing_resource_id", "resource id is required")
		}
		snapshot := requestCatalogSnapshot(c, catalog)
		page, err := services.PageLibraryChildren(snapshot, parentID, kind, c.Query("cursor"), limit)
		if err != nil {
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		setLibraryRevisionETag(c, snapshot.Revision())
		return c.JSON(fiber.Map{"ok": true, "page": page})
	}
}

// AlbumMediaPageHandler 按统一自然顺序分页返回图片和视频。
// 推荐路由：GET /api/albums/:id/media。
//
// 返回项带原始像素尺寸：照片墙要按真实宽高比排布，服务端读一次图片头
// 并缓存，比让浏览器逐张探测更省事也更稳。视频没有像素尺寸，保持 0。
func AlbumMediaPageHandler(catalog *services.ResourceCatalog, dimensions *services.MediaDimensionService, picks *store.PickStore) fiber.Handler {
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
		enrichMediaDimensions(snapshot, page.Items, dimensions)
		// 精选是照片级状态，照片墙的每一格都要知道自己是不是精选。
		markPicks(picks, page.Items)
		setLibraryRevisionETag(c, snapshot.Revision())
		return c.JSON(fiber.Map{"ok": true, "page": page})
	}
}

// enrichMediaDimensions 补齐一页媒体的像素尺寸。
//
// 尺寸是可选信息：探测失败时保持 0，前端会退回默认宽高比，不影响浏览。
// 读不出图片头的文件另外标成「无法解码」：那是坏文件，不是尺寸未知。
//
// 新探测到的尺寸在页末一次性落盘：逐条刷盘的话，一页两百张照片就是
// 两百次 fsync，翻年墙时每页要等两秒。
func enrichMediaDimensions(snapshot services.CatalogSnapshot, items []services.LibraryMediaItem, dimensions *services.MediaDimensionService) {
	if dimensions == nil || len(items) == 0 {
		return
	}
	for i := range items {
		enrichMediaDimension(snapshot, &items[i], dimensions)
	}
	dimensions.Flush()
}

// enrichMediaDimension 补齐一份媒体的像素尺寸。
func enrichMediaDimension(snapshot services.CatalogSnapshot, item *services.LibraryMediaItem, dimensions *services.MediaDimensionService) {
	if dimensions == nil || item.Kind != "image" {
		return
	}
	ref, ok := snapshot.Lookup(item.ID)
	if !ok {
		return
	}
	size := dimensions.Dimensions(ref.AbsolutePath)
	item.Width = size.Width
	item.Height = size.Height
	item.Undecodable = size.Undecodable
}

// LibraryMediaFeedHandler 分页返回跨相册的照片流。
//
// 推荐路由：GET /api/library/media-feed。
//
// scope 决定从哪里取材：year 取某一年下各相册的照片，collection 取一个
// 集合内部的照片，recent / random 取几本相册的照片。每张照片都带它
// 所属的相册，用户能看得出出处、也回得去原相册。
func LibraryMediaFeedHandler(catalog *services.ResourceCatalog, dimensions *services.MediaDimensionService, picks *store.PickStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		limit, ok := parseLibraryPageLimit(c)
		if !ok {
			return nil
		}
		kind, ok := parseLibraryKind(c)
		if !ok {
			return nil
		}
		query := services.MediaFeedQuery{
			Kind:   kind,
			Scope:  services.MediaFeedScope(strings.TrimSpace(c.Query("scope"))),
			Year:   strings.TrimSpace(c.Query("year")),
			Parent: strings.TrimSpace(c.Query("parent")),
			// 种子只对随机取材有意义：「换一批」换一个种子，服务端因此
			// 给出一批确实不同的照片。
			Seed: strings.TrimSpace(c.Query("seed")),
		}
		snapshot := requestCatalogSnapshot(c, catalog)
		page, err := services.PageMediaFeed(snapshot, query, c.Query("cursor"), limit)
		if err != nil {
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		for i := range page.Items {
			enrichMediaDimension(snapshot, &page.Items[i].LibraryMediaItem, dimensions)
		}
		// 新探测到的尺寸攒批落盘：逐条刷盘的话，一页两百张照片就是
		// 两百次 fsync，翻年墙时每页要等两秒。
		if dimensions != nil {
			dimensions.Flush()
		}
		markFeedPicks(picks, page.Items)
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
		kind, ok := parseLibraryKind(c)
		if !ok {
			return nil
		}
		started, activityRevision, err := startedAlbums(activities)
		if err != nil {
			return httputil.Internal(c, "activity_unavailable", "activity storage is unavailable")
		}
		snapshot := catalog.Acquire()
		page, err := unreadIndex.Page(snapshot, started, activityRevision, kind, c.Query("cursor"), limit)
		if err != nil {
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		setLibraryRevisionETag(c, snapshot.Revision())
		return c.JSON(fiber.Map{"ok": true, "page": page})
	}
}

// randomAlbumCountLimit 是随机抽取一次最多返回几本相册。
// 上限防住「一次把整个库抽出来」这种没有意义的要求。
const randomAlbumCountLimit = 12

// LibraryRandomAlbumHandler 返回随机相册摘要。scope=unread 时只从未开始阅读的相册中抽取。
//
// count 决定返回几本（默认 1，最多 12）：首页「随手看看」一次给三本候选，
// 抽出的相册互不相同。
func LibraryRandomAlbumHandler(catalog *services.ResourceCatalog, activities *store.ActivityStore, unreadIndex *services.UnreadLibraryIndex) fiber.Handler {
	return func(c *fiber.Ctx) error {
		scope := strings.TrimSpace(c.Query("scope"))
		if scope != "" && scope != "unread" {
			return httputil.BadRequest(c, "invalid_random_scope", "scope must be empty or unread")
		}
		count := 1
		if raw := strings.TrimSpace(c.Query("count")); raw != "" {
			parsed, err := strconv.Atoi(raw)
			if err != nil || parsed < 1 || parsed > randomAlbumCountLimit {
				return httputil.BadRequest(c, "invalid_random_count", "count must be between 1 and 12")
			}
			count = parsed
		}
		kind, ok := parseLibraryKind(c)
		if !ok {
			return nil
		}
		snapshot := catalog.Acquire()
		if scope == "unread" {
			started, activityRevision, err := startedAlbums(activities)
			if err != nil {
				return httputil.Internal(c, "activity_unavailable", "activity storage is unavailable")
			}
			albums, pageErr := unreadIndex.Random(snapshot, started, activityRevision, kind, count)
			if pageErr != nil {
				return writeLibraryPageError(c, pageErr, snapshot.Revision())
			}
			setLibraryRevisionETag(c, snapshot.Revision())
			return c.JSON(fiber.Map{"ok": true, "albums": albums, "revision": snapshot.Revision()})
		}
		albums, err := services.RandomLibraryAlbums(snapshot, kind, count)
		if err != nil {
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		setLibraryRevisionETag(c, snapshot.Revision())
		return c.JSON(fiber.Map{"ok": true, "albums": albums, "revision": snapshot.Revision()})
	}
}

// LibraryActivitySummaryHandler 为常驻侧边栏返回未读计数，避免下载全量相册摘要。
func LibraryActivitySummaryHandler(catalog *services.ResourceCatalog, activities *store.ActivityStore, unreadIndex *services.UnreadLibraryIndex) fiber.Handler {
	return func(c *fiber.Ctx) error {
		kind, ok := parseLibraryKind(c)
		if !ok {
			return nil
		}
		started, activityRevision, err := startedAlbums(activities)
		if err != nil {
			return httputil.Internal(c, "activity_unavailable", "activity storage is unavailable")
		}
		snapshot := catalog.Acquire()
		summary, err := unreadIndex.Summary(snapshot, started, activityRevision, kind)
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
		kind, ok := parseLibraryKind(c)
		if !ok {
			return nil
		}
		imageActivities, _, _, err := activities.ImageActivitySnapshot()
		if err != nil {
			return httputil.Internal(c, "activity_unavailable", "activity storage is unavailable")
		}
		startedImage, startedVideo, activityRevision, err := activities.StartedAlbumIDsSnapshot()
		if err != nil {
			return httputil.Internal(c, "activity_unavailable", "activity storage is unavailable")
		}
		started := services.StartedAlbums{
			Image: startedImage,
			Video: startedVideo,
		}
		snapshot := catalog.Acquire()
		dashboard, err := unreadIndex.Dashboard(snapshot, imageActivities, started, activityRevision, kind)
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

// LibraryTagsQueryHandler 按名批量解析标签摘要。
//
// 它与 nodes/query 一样按需解析，不分页、不按工作台属性过滤：
// 收藏里的智能标签可能在任意一侧有作品，客户端需要同时知道两侧的册数，
// 才能区分「这个标签失效了」和「它只属于另一侧」。
func LibraryTagsQueryHandler(catalog *services.ResourceCatalog) fiber.Handler {
	type request struct {
		Names []string `json:"names"`
	}
	return func(c *fiber.Ctx) error {
		var body request
		if err := c.BodyParser(&body); err != nil || len(body.Names) == 0 {
			return httputil.BadRequest(c, "invalid_tag_names", "names must be a non-empty array")
		}
		if len(body.Names) > services.MaxLibraryNodeQuery {
			return httputil.BadRequest(c, "too_many_tag_names", "names exceeds the batch limit")
		}
		names := make([]string, 0, len(body.Names))
		for _, name := range body.Names {
			if name = strings.TrimSpace(name); name != "" {
				names = append(names, name)
			}
		}
		if len(names) == 0 {
			return httputil.BadRequest(c, "invalid_tag_names", "names must contain a tag name")
		}
		snapshot := catalog.Acquire()
		result, err := services.ResolveLibraryTags(snapshot, names)
		if err != nil {
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		setLibraryRevisionETag(c, snapshot.Revision())
		return c.JSON(fiber.Map{"ok": true, "result": result})
	}
}

// LibraryRecentHandler 返回该属性下最近加入的相册摘要。
//
// 照片工作台不记录浏览进度，没有「继续阅读」可言；
// 「最近添加」是照片侧与漫画侧对称的入口，也是收藏空态的推荐来源。
func LibraryRecentHandler(catalog *services.ResourceCatalog) fiber.Handler {
	return func(c *fiber.Ctx) error {
		limit, ok := parseLibraryPageLimit(c)
		if !ok {
			return nil
		}
		kind, ok := parseLibraryKind(c)
		if !ok {
			return nil
		}
		snapshot := catalog.Acquire()
		page, err := services.PageLibraryRecent(snapshot, kind, limit)
		if err != nil {
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		setLibraryRevisionETag(c, snapshot.Revision())
		return c.JSON(fiber.Map{"ok": true, "page": page})
	}
}

// LibraryOnThisDayHandler 返回往年同一天拍过照的相册。
//
// month 与 day 缺省时取服务端当天；它只认拍摄日期（来自文件名推断），
// 没有拍摄时间的相册不进这个列表。每条还带上真正拍于那一天的那一张
// 照片：界面展示的是那张照片本身，不是相册的通用封面。
func LibraryOnThisDayHandler(catalog *services.ResourceCatalog, dimensions *services.MediaDimensionService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		limit, ok := parseLibraryPageLimit(c)
		if !ok {
			return nil
		}
		kind, ok := parseLibraryKind(c)
		if !ok {
			return nil
		}
		now := time.Now()
		month, day := int(now.Month()), now.Day()
		if raw := strings.TrimSpace(c.Query("month")); raw != "" {
			parsed, err := strconv.Atoi(raw)
			if err != nil || parsed < 1 || parsed > 12 {
				return httputil.BadRequest(c, "invalid_on_this_day", "month must be between 1 and 12")
			}
			month = parsed
		}
		if raw := strings.TrimSpace(c.Query("day")); raw != "" {
			parsed, err := strconv.Atoi(raw)
			if err != nil || parsed < 1 || parsed > 31 {
				return httputil.BadRequest(c, "invalid_on_this_day", "day must be between 1 and 31")
			}
			day = parsed
		}
		snapshot := catalog.Acquire()
		page, err := services.PageOnThisDay(snapshot, kind, month, day, limit)
		if err != nil {
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		for i := range page.Items {
			photo := page.Items[i].Photo
			if photo == nil {
				continue
			}
			enrichMediaDimension(snapshot, &photo.LibraryMediaItem, dimensions)
		}
		if dimensions != nil {
			dimensions.Flush()
		}
		setLibraryRevisionETag(c, snapshot.Revision())
		return c.JSON(fiber.Map{"ok": true, "page": page})
	}
}

// LibraryTagsPageHandler 分页返回标签摘要，不携带标签下的完整相册数组。
func LibraryTagsPageHandler(catalog *services.ResourceCatalog) fiber.Handler {
	return func(c *fiber.Ctx) error {
		limit, ok := parseLibraryPageLimit(c)
		if !ok {
			return nil
		}
		kind, ok := parseLibraryKind(c)
		if !ok {
			return nil
		}
		snapshot := catalog.Acquire()
		page, err := services.PageLibraryTags(snapshot, kind, c.Query("cursor"), limit)
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
		kind, ok := parseLibraryKind(c)
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
		page, err := services.PageTagAlbums(snapshot, tag, kind, c.Query("cursor"), limit)
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

// parseLibraryKind 读取 kind 查询参数：photo / comic。
//
// 它对应前端的「工作台模式」：列表只呈现该属性的相册与集合。
// 参数必填 —— 媒体库按目录属性一分为二，不存在「不过滤」的第三种视图，
// 省略它等于让服务端替用户猜一个工作台。
func parseLibraryKind(c *fiber.Ctx) (services.LibraryKindScope, bool) {
	switch strings.TrimSpace(c.Query("kind")) {
	case "photo":
		return services.LibraryKindPhoto, true
	case "comic":
		return services.LibraryKindComic, true
	default:
		_ = httputil.BadRequest(c, "invalid_kind", "kind must be photo or comic")
		return services.LibraryKindPhoto, false
	}
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
	case errors.Is(err, services.ErrInvalidOnThisDay):
		return httputil.BadRequest(c, "invalid_on_this_day", "month and day must be a valid calendar date")
	case errors.Is(err, services.ErrInvalidMediaFeedQuery):
		return httputil.BadRequest(c, "invalid_media_feed", "media feed scope or parameters are invalid")
	default:
		return httputil.Internal(c, "library_page_failed", "unable to build library page")
	}
}

func setLibraryRevisionETag(c *fiber.Ctx, revision uint64) {
	c.Set(fiber.HeaderETag, `W/"library-`+strconv.FormatUint(revision, 10)+`"`)
}

// startedAlbums 汇总漫画与视频活动派生的相册 ID 集合，供未读统计使用。
func startedAlbums(activities *store.ActivityStore) (services.StartedAlbums, uint64, error) {
	image, video, revision, err := activities.StartedAlbumIDsSnapshot()
	if err != nil {
		return services.StartedAlbums{}, 0, err
	}
	return services.StartedAlbums{
		Image: image,
		Video: video,
	}, revision, nil
}
