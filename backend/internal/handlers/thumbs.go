package handlers

import (
	"errors"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/httputil"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

// ThumbHandler 返回 JPEG 渲染图。
//
//	GET /api/thumbs/:id?w=640&v=<内容版本号>
//
// w 是渲染档位的目标宽度，会向上对齐到固定档位阶梯（320/640/1280/1920/
// 2560/4096）。渲染不裁剪，输出宽高比恒等于源图比例，所以同一张图在
// 各档之间比例一致，前端可以用 srcset 让浏览器按显示宽度自选。
//
// v 是源文件的内容版本号（mtime + size + 渲染算法版本）。带上的请求若与
// 当前版本一致，说明这个 URL 的字节已经定死，服务端回 immutable，
// 浏览器可以长期缓存；不带或对不上则保持每次重新验证。
//
// ETag 由版本号与档位派生：条件请求只要一次 stat 加一次字符串比较，
// 不必先把整张图读进内存算哈希。
//
// 视频封面尚未生成时返回不可缓存的 video_cover_missing 错误。
func ThumbHandler(svc *services.ThumbnailService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		path := middleware.SafePath(c)
		if path == "" {
			return httputil.BadRequest(c, "missing_path", "missing 'path' query parameter")
		}
		width, err := renditionWidth(c, services.DefaultRenditionWidth)
		if err != nil {
			return httputil.BadRequest(c, "invalid_render_width", err.Error())
		}

		version, versionErr := services.MediaVersion(path)
		if versionErr != nil {
			if errors.Is(versionErr, services.ErrSourceMissing) {
				return httputil.NotFound(c, "source_not_found", "source not found")
			}
			return httputil.Internal(c, "thumbnail_error", "thumbnail generation failed")
		}
		etag := services.RenditionETag(version, width)
		if mediaIfNoneMatch(mediaIfNoneMatchValue(c), etag) {
			c.Set("ETag", etag)
			c.Set("Cache-Control", renditionCacheControl(c, version))
			return c.SendStatus(fiber.StatusNotModified)
		}

		data, err := svc.GetOrCreate(path, width)
		if err != nil {
			switch {
			case errors.Is(err, services.ErrSourceMissing):
				return httputil.NotFound(c, "source_not_found", "source not found")
			case errors.Is(err, services.ErrVideoCoverMissing):
				// 不带 ETag / Cache-Control —— 4xx 状态不能被浏览器长缓存，
				// 否则视频 cover 抽帧后用户再访问仍会拿到旧的 404。
				return httputil.NotFound(c, "video_cover_missing", "video cover not yet extracted")
			case errors.Is(err, services.ErrUnsupportedFormat):
				return httputil.Error(c, fiber.StatusUnsupportedMediaType, "unsupported_format", "unsupported format")
			default:
				return httputil.Internal(c, "thumbnail_error", "thumbnail generation failed")
			}
		}

		c.Set("ETag", etag)
		c.Set("Cache-Control", renditionCacheControl(c, version))
		c.Set("Content-Type", "image/jpeg")
		return c.Send(data)
	}
}

// ThumbCleanupHandler 返回清理过期缓存的处理函数（POST）。
func ThumbCleanupHandler(svc *services.ThumbnailService) fiber.Handler {
	return ThumbCleanupHandlerWithCacheStats(svc, nil)
}

// ThumbCleanupHandlerWithCacheStats 清理过期缩略图缓存后,通知 cacheStats
// 失效,让前端的"缓存占用"展示立即反映清理结果。
// cacheStats 可选；缺省时只执行缩略图清理。
func ThumbCleanupHandlerWithCacheStats(svc *services.ThumbnailService, cacheStats *services.CacheStatsService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		n, err := svc.Cleanup()
		if err != nil {
			return writeError(c, fiber.StatusInternalServerError, "thumbnail_cleanup_failed", "thumbnail cleanup failed")
		}
		if cacheStats != nil {
			cacheStats.Invalidate()
		}
		return c.JSON(fiber.Map{"deleted": n})
	}
}

// ThumbCoverHandler 接收前端浏览器抽帧后的视频封面字节，写入缓存。
//
//	POST /api/thumbs/cover?path=<absolute_video_path>
//	Content-Type: image/jpeg | image/png
//	Body: 原始图片字节（canvas.toBlob('image/jpeg', 0.85) 典型）
//
// 成功：200 + { ok: true, bytes: <int> }
// 失败：
//   - 400：path 缺失 / body 为空
//   - 404：视频文件不存在
//   - 413：payload 超过 5 MB（防 OOM）
//   - 415：上传的字节不是合法图片 / 路径不是视频
//   - 500：写盘失败
//
// 设计要点：
//   - 不依赖 ffmpeg：服务端只 decode + resize + 缓存，不解析视频容器
//   - 字节大小限制：单张封面 5 MB 足够 4K canvas JPEG（4K JPEG 8bit ~3 MB）
//   - 与 /api/thumbs 的 key 体系一致：mtime/size 变化自动失效
//
// 注意：直接用 c.Body() 读整 body。Fiber 默认 BodyLimit=4MiB，所以
// 全局 BodyLimit 为备份导入留有余量，本接口独立限制 5 MiB。
// BodyLimit 是 Fiber 全局设置；封面大小还由下方独立检查（Fiber 自身会
// 拦截超大请求并返回 413）。
func ThumbCoverHandler(svc *services.ThumbnailService) fiber.Handler {
	const maxCoverBytes = 5 * 1024 * 1024 // 5 MB
	return func(c *fiber.Ctx) error {
		path := middleware.SafePath(c)
		if path == "" {
			return writeError(c, fiber.StatusBadRequest, "missing_path", "missing 'path' query parameter")
		}
		body := c.Body()
		if len(body) == 0 {
			return writeError(c, fiber.StatusBadRequest, "empty_cover_body", "cover body is empty")
		}
		if len(body) > maxCoverBytes {
			return writeError(c, fiber.StatusRequestEntityTooLarge, "cover_payload_too_large", "cover payload too large")
		}
		if err := svc.SaveVideoCover(path, body); err != nil {
			switch {
			case errors.Is(err, services.ErrSourceMissing):
				return writeError(c, fiber.StatusNotFound, "source_not_found", "source video not found")
			case errors.Is(err, services.ErrUnsupportedFormat):
				return writeError(c, fiber.StatusUnsupportedMediaType, "unsupported_cover_format", "cover data is not a valid image")
			default:
				// 非视频路径会落到这里（fmt.Errorf），返回 400 更准确
				return writeError(c, fiber.StatusBadRequest, "invalid_video_cover", "video cover cannot be saved")
			}
		}
		return c.JSON(fiber.Map{"ok": true, "bytes": len(body)})
	}
}
