package handlers

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

// ImageHandler 返回资源 ID 指向的原图（支持 Range 请求 + ETag 协商）。
//
//	GET /api/media/:id
//
// 浏览器原生不识别的格式（HEIC/HEIF）原样返回，由浏览器自身决定
// 能否解码。共用媒体流发送器按扩展名设置 Content-Type，并支持 Range。
//
// ETag 协商:
//   - 第一次响应带 ETag = mtime+size + Cache-Control
//   - 浏览器下次带 If-None-Match;若匹配 → 304 + 空 body,省下整个文件传输
//   - 与视频共用同一公式;图片也常被重复打开(画廊里翻回去 / 缩略图 hover),
//     4MB 的 JPEG 走 304 比 200 体感差异明显(尤其在远程桌面 / 局域网场景)
func ImageHandler() fiber.Handler {
	return func(c *fiber.Ctx) error {
		path := middleware.SafePath(c)
		if path == "" {
			return writeError(c, fiber.StatusBadRequest, "missing_path", "missing 'path' query parameter")
		}
		return serveMediaFile(c, path, "", "media_not_found")
	}
}

// MediaHandler 根据文件类型分派到图片或视频发送管线。
func MediaHandler(transcode *services.TranscodeService, faststart *services.VideoFaststartService) fiber.Handler {
	imageHandler := ImageHandler()
	videoHandler := VideoHandler(transcode, faststart)
	return func(c *fiber.Ctx) error {
		path := middleware.SafePath(c)
		if models.IsVideoFile(filepath.Base(path)) {
			return videoHandler(c)
		}
		if models.IsImageFile(filepath.Base(path)) {
			return imageHandler(c)
		}
		return writeError(c, fiber.StatusUnsupportedMediaType, "unsupported_media", "resource is not a supported media file")
	}
}

// ImageInfoHandler 返回图片元数据（尺寸、格式、大小、修改时间、checksum）。
//
//	GET /api/images/:id/info
func ImageInfoHandler(catalog *services.ResourceCatalog) fiber.Handler {
	return func(c *fiber.Ctx) error {
		resourceID := middleware.ResourceID(c)
		path := middleware.SafePath(c)
		if resourceID == "" || path == "" {
			return writeError(c, fiber.StatusBadRequest, "missing_resource_id", "resource id is required")
		}
		snapshot := requestCatalogSnapshot(c, catalog)
		ref, ok := snapshot.Lookup(resourceID)
		if !ok {
			return writeError(c, fiber.StatusNotFound, "resource_not_found", "resource id is invalid or stale")
		}
		if ref.Kind != services.ResourceFile {
			return writeError(c, fiber.StatusBadRequest, "invalid_resource_kind", "resource type does not support this operation")
		}
		if !models.IsImageFile(filepath.Base(path)) {
			return writeError(c, fiber.StatusUnsupportedMediaType, "unsupported_image_format", "not a supported image format")
		}
		info, err := services.GetImageInfo(path)
		if err != nil {
			if os.IsNotExist(err) || errors.Is(err, services.ErrSourceMissing) {
				return writeError(c, fiber.StatusNotFound, "media_not_found", "media resource was not found")
			}
			return writeError(c, fiber.StatusInternalServerError, "image_info_failed", "failed to read image metadata")
		}
		info.Path = resourceID
		info.Dir = filepath.ToSlash(filepath.Dir(snapshot.RelativeLabel(resourceID)))
		return c.JSON(info)
	}
}
