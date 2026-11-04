package handlers

import (
	"strings"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

// AlbumContentKindHandler 读取或修改相册的浏览用途。
//
//	GET    /api/albums/:id/content-kind
//	PUT    /api/albums/:id/content-kind   body {"kind":"photo"|"comic"}
//	DELETE /api/albums/:id/content-kind
//
// 用途决定「点击相册后进入照片墙还是漫画阅读器」。它由「媒体根默认值 +
// 单个相册覆盖」决定：PUT 写入相册级覆盖，DELETE 撤销覆盖并回落到
// 媒体根默认值。修改后立即重新发布资源索引，前端下一次拉摘要即可看到新用途。
func AlbumContentKindHandler(
	catalog *services.ResourceCatalog,
	kinds *services.ContentKindStore,
) fiber.Handler {
	return func(c *fiber.Ctx) error {
		albumID := strings.TrimSpace(c.Params("id"))
		if albumID == "" {
			return writeError(c, fiber.StatusBadRequest, "missing_resource_id", "resource id is required")
		}
		snapshot := catalog.Acquire()
		ref, ok := snapshot.Lookup(albumID)
		if !ok {
			return writeError(c, fiber.StatusNotFound, "resource_not_found", "resource id is invalid or stale")
		}
		if ref.Kind != services.ResourceAlbum {
			return writeError(c, fiber.StatusBadRequest, "invalid_resource_kind", "only albums have a content kind")
		}

		switch c.Method() {
		case fiber.MethodGet:
			summary, ok := snapshot.AlbumSummary(albumID)
			if !ok {
				return writeError(c, fiber.StatusNotFound, "resource_not_found", "resource id is invalid or stale")
			}
			return c.JSON(contentKindResponse(summary))
		case fiber.MethodPut:
			var body struct {
				Kind string `json:"kind"`
			}
			if err := c.BodyParser(&body); err != nil {
				return writeError(c, fiber.StatusBadRequest, "invalid_content_kind_body", "invalid JSON body")
			}
			if !models.IsValidContentKind(body.Kind) {
				return writeError(c, fiber.StatusBadRequest, "invalid_content_kind", "kind must be photo or comic")
			}
			if err := kinds.Set(ref.AbsolutePath, models.NormalizeContentKind(body.Kind)); err != nil {
				return writeError(c, fiber.StatusInternalServerError, "content_kind_save_failed", "save content kind")
			}
			catalog.SetContentKindOverrides(kinds.Snapshot())
			return c.JSON(contentKindResponse(reloadAlbumSummary(catalog, albumID)))
		case fiber.MethodDelete:
			if err := kinds.Clear(ref.AbsolutePath); err != nil {
				return writeError(c, fiber.StatusInternalServerError, "content_kind_save_failed", "clear content kind")
			}
			catalog.SetContentKindOverrides(kinds.Snapshot())
			return c.JSON(contentKindResponse(reloadAlbumSummary(catalog, albumID)))
		default:
			return writeError(c, fiber.StatusMethodNotAllowed, "method_not_allowed", "method is not supported")
		}
	}
}

// contentKindResponse 是内容用途接口的统一响应体。
type contentKindResponseBody struct {
	OK                    bool   `json:"ok"`
	ContentKind           string `json:"contentKind"`
	ContentKindDefault    string `json:"contentKindDefault"`
	ContentKindOverridden bool   `json:"contentKindOverridden"`
}

func contentKindResponse(summary services.LibraryNodeSummary) contentKindResponseBody {
	kind := summary.ContentKind
	if kind == "" {
		kind = string(models.DefaultContentKind)
	}
	fallback := summary.ContentKindDefault
	if fallback == "" {
		fallback = kind
	}
	return contentKindResponseBody{
		OK:                    true,
		ContentKind:           kind,
		ContentKindDefault:    fallback,
		ContentKindOverridden: summary.ContentKindOverridden,
	}
}

// reloadAlbumSummary 在重新发布后读取相册的最新摘要。
func reloadAlbumSummary(catalog *services.ResourceCatalog, albumID string) services.LibraryNodeSummary {
	summary, _ := catalog.Acquire().AlbumSummary(albumID)
	return summary
}
