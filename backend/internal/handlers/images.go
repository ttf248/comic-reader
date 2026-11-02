package handlers

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

// ImageHandler 返回资源 ID 指向的原图（支持 Range 请求 + ETag 协商）。
//
//	GET /api/media/:id
//
// 浏览器原生不识别的格式（HEIC/HEIF/TIFF）改由服务端转成 JPEG 再返回：
// 原样发送只会让阅读器显示破图。转换结果有磁盘缓存，第二次访问直接命中。
// 其余格式按扩展名设置 Content-Type 原样发送，并支持 Range。
//
// ETag 协商:
//   - 第一次响应带 ETag = mtime+size + Cache-Control
//   - 浏览器下次带 If-None-Match;若匹配 → 304 + 空 body,省下整个文件传输
//   - 与视频共用同一公式;图片也常被重复打开(画廊里翻回去 / 缩略图 hover),
//     4MB 的 JPEG 走 304 比 200 体感差异明显(尤其在远程桌面 / 局域网场景)
func ImageHandler(thumbs *services.ThumbnailService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		path := middleware.SafePath(c)
		if path == "" {
			return writeError(c, fiber.StatusBadRequest, "missing_path", "missing 'path' query parameter")
		}
		if models.NeedsBrowserConversion(filepath.Base(path)) {
			return serveConvertedImage(c, thumbs, path)
		}
		return serveMediaFile(c, path, "", "media_not_found")
	}
}

// serveConvertedImage 把浏览器解不了的图片转成 JPEG 后发送。
//
// 转换不可用（没有 ffmpeg）或失败时返回 415 + 稳定 code，调用方据此
// 显示"该格式无法显示"的提示，而不是把原文件当图片发出去。
func serveConvertedImage(c *fiber.Ctx, thumbs *services.ThumbnailService, path string) error {
	if thumbs == nil {
		return writeError(c, fiber.StatusUnsupportedMediaType, "unsupported_image_format", "image format cannot be displayed")
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return writeError(c, fiber.StatusNotFound, "media_not_found", "media resource was not found")
		}
		return writeError(c, fiber.StatusInternalServerError, "media_read_failed", "failed to read media resource")
	}
	etag := mediaETag(info)
	if mediaNotModified(c, etag, info.ModTime()) {
		return c.SendStatus(fiber.StatusNotModified)
	}
	data, err := thumbs.GetConvertedImage(path)
	if err != nil {
		if errors.Is(err, services.ErrSourceMissing) {
			return writeError(c, fiber.StatusNotFound, "media_not_found", "media resource was not found")
		}
		return writeError(c, fiber.StatusUnsupportedMediaType, "unsupported_image_format", "image format cannot be displayed")
	}
	c.Set("Content-Type", "image/jpeg")
	c.Set("Cache-Control", "private, no-cache")
	c.Set("ETag", etag)
	c.Set("Last-Modified", info.ModTime().UTC().Format(http.TimeFormat))
	return c.Send(data)
}

// MediaHandler 根据文件类型分派到图片或视频发送管线。
func MediaHandler(transcode *services.TranscodeService, faststart *services.VideoFaststartService, thumbs *services.ThumbnailService) fiber.Handler {
	imageHandler := ImageHandler(thumbs)
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

// defaultPreviewWidth 预览图默认宽度（像素）。
//
// 1440px 宽的桌面视口配 1600px 预览刚好够用；再窄的视口用同一份缓存，
// 不必为每个视口宽度各生成一份。
const defaultPreviewWidth = 1600

// PreviewHandler 返回按宽度缩放的预览图。
//
//	GET /api/previews/:id?w=1600
//
// 阅读器连续模式按视口宽度展示图片。直接发原图的话，手机照片动辄
// 12MP / 5MB，一屏就是几 MB，整本翻下来是 GB 级流量，浏览器还要为每张
// 原图解码出几十 MB 位图。这里按 w 等比缩放并缓存到磁盘，
// 1600px 宽的 q85 JPEG 约 200–400KB。
//
// w 会被夹到 320..4096；非数字或非正数返回 400。
// 源图比 w 还窄时直接返回原图字节（不重新编码，零画质损失）。
func PreviewHandler(thumbs *services.ThumbnailService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		path := middleware.SafePath(c)
		if path == "" {
			return writeError(c, fiber.StatusBadRequest, "missing_path", "missing 'path' query parameter")
		}
		if !models.IsImageFile(filepath.Base(path)) {
			return writeError(c, fiber.StatusUnsupportedMediaType, "unsupported_image_format", "image format cannot be displayed")
		}
		width, err := previewWidth(c)
		if err != nil {
			return writeError(c, fiber.StatusBadRequest, "invalid_preview_width", err.Error())
		}
		if thumbs == nil {
			return writeError(c, fiber.StatusServiceUnavailable, "preview_unavailable", "preview service is not initialized")
		}
		preview, err := thumbs.GetOrCreatePreview(path, width)
		if err != nil {
			if errors.Is(err, services.ErrSourceMissing) {
				return writeError(c, fiber.StatusNotFound, "media_not_found", "media resource was not found")
			}
			if errors.Is(err, services.ErrUnsupportedFormat) {
				return writeError(c, fiber.StatusUnsupportedMediaType, "unsupported_image_format", "image format cannot be displayed")
			}
			return writeError(c, fiber.StatusInternalServerError, "preview_failed", "failed to generate preview image")
		}
		info, statErr := os.Stat(path)
		if statErr == nil && mediaNotModified(c, preview.ETag, info.ModTime()) {
			return c.SendStatus(fiber.StatusNotModified)
		}
		c.Set("Content-Type", preview.ContentType)
		c.Set("Content-Length", strconv.Itoa(len(preview.Data)))
		c.Set("ETag", preview.ETag)
		c.Set("Cache-Control", "private, no-cache")
		return c.Send(preview.Data)
	}
}

// previewWidth 解析请求的预览图宽度（像素）。
//
// 缺省 1600；非数字或非正数返回错误，由调用方转成 400。
func previewWidth(c *fiber.Ctx) (int, error) {
	raw := strings.TrimSpace(c.Query("w"))
	if raw == "" {
		return defaultPreviewWidth, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("invalid 'w' query parameter: %q", raw)
	}
	return n, nil
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
