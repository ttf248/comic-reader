package handlers

import (
	"errors"
	"os"

	"github.com/gofiber/fiber/v2"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

// DirectoriesHandler 由 AccessGate 和 LoopbackOnly 保护，属于配置管理路径例外。
// 仅枚举目录，不读取媒体内容，不修改文件或配置，也不启动桌面进程。
func DirectoriesHandler() fiber.Handler {
	return func(c *fiber.Ctx) error {
		c.Set(fiber.HeaderCacheControl, "no-store")
		var body struct {
			Directory string `json:"directory"`
			After     string `json:"after"`
		}
		if err := c.BodyParser(&body); err != nil {
			return writeError(c, fiber.StatusBadRequest, "invalid_directory_request", "invalid directory request")
		}
		page, err := services.BrowseDirectories(body.Directory, body.After)
		if err != nil {
			switch {
			case errors.Is(err, services.ErrInvalidDirectory):
				return writeError(c, fiber.StatusBadRequest, "invalid_directory_request", "invalid directory request")
			case os.IsNotExist(err):
				return writeError(c, fiber.StatusNotFound, "directory_not_found", "directory is unavailable")
			case os.IsPermission(err):
				return writeError(c, fiber.StatusForbidden, "directory_access_denied", "directory cannot be read")
			default:
				return writeError(c, fiber.StatusInternalServerError, "directory_read_failed", "directory cannot be read")
			}
		}
		return c.JSON(page)
	}
}
