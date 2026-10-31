package handlers

import (
	"os"
	"path/filepath"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/config"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

// FsOpenHandler 在系统文件管理器中打开 path。
//
// 当 mgr 当前 AllowOsOpen=false 时返回 403；AllowOsOpen 可通过 /api/config
// 在运行中切换。
//
// 安全策略：
//   - 默认：path 由 path safety 中间件校验（必须在任一 mediaRoots 之下），
//     防止越权打开用户本地任意目录
//   - 当 query `allowConfig=1` 时：path_safety 中间件放行（设 skipSafety
//     标志），handler 自行从 c.Query("path") 读路径，并校验路径是 cfg
//     中某个已知字段（cacheDir / staticDir / mediaRoots / cwd）才放行；
//     用于让用户在 Settings 页能直接打开「缓存目录」/「前端构建目录」等
//     自配置路径
func FsOpenHandler(mgr *config.Manager) fiber.Handler {
	return func(c *fiber.Ctx) error {
		cfg := mgr.Get()
		if !cfg.AllowOsOpen {
			return writeError(c, fiber.StatusForbidden, "os_open_disabled", "allowOsOpen is disabled")
		}

		var path string
		if middleware.IsSafetyBypassed(c) {
			// allowConfig 模式：跳过 path safety，handler 自己校验白名单
			path = c.Query("path")
			if path == "" {
				return writeError(c, fiber.StatusBadRequest, "missing_path", "missing 'path' query parameter")
			}
			if !isAllowedConfigPath(path, cfg) {
				return writeError(c, fiber.StatusForbidden, "config_path_not_allowed", "path is not one of the configured paths")
			}
		} else {
			// 常规模式：path 必须已经过 path safety 中间件校验
			path = middleware.SafePath(c)
			if path == "" {
				return writeError(c, fiber.StatusBadRequest, "missing_path", "missing 'path' query parameter")
			}
		}

		if err := middleware.OpenInOS(path); err != nil {
			return writeError(c, fiber.StatusInternalServerError, "os_open_failed", "failed to open the resource")
		}
		return c.JSON(fiber.Map{"ok": true})
	}
}

// FsOpenResourceHandler 使用脱敏资源 ID 打开媒体目录。
// 系统打开器由启动入口注入，和目录解析、权限校验分离。
func FsOpenResourceHandler(mgr *config.Manager, catalog *services.ResourceCatalog, validator middleware.PathValidator, openPath func(string) error) fiber.Handler {
	type request struct {
		ID string `json:"id"`
	}
	return func(c *fiber.Ctx) error {
		cfg := mgr.Get()
		if !cfg.AllowOsOpen {
			return writeError(c, fiber.StatusForbidden, "os_open_disabled", "allowOsOpen is disabled")
		}
		var body request
		if err := c.BodyParser(&body); err != nil || body.ID == "" {
			return writeError(c, fiber.StatusBadRequest, "invalid_resource_id", "resource id is required")
		}
		if catalog == nil || validator == nil || openPath == nil {
			return writeError(c, fiber.StatusInternalServerError, "os_open_failed", "system file manager is unavailable")
		}
		ref, ok := catalog.Lookup(body.ID)
		if !ok {
			return writeError(c, fiber.StatusNotFound, "resource_not_found", "resource id is invalid or stale")
		}
		// 扫描快照不能证明路径现在仍安全，配置目录的查询参数也不能绕过此校验。
		path, err := validator.Validate(ref.AbsolutePath)
		if err != nil || path == "" {
			return writeError(c, fiber.StatusNotFound, "resource_not_found", "resource id is invalid or stale")
		}
		info, err := os.Stat(path)
		if err != nil {
			return writeError(c, fiber.StatusNotFound, "resource_not_found", "resource id is invalid or stale")
		}
		validType := false
		switch ref.Kind {
		case services.ResourceFile:
			validType = info.Mode().IsRegular()
		case services.ResourceRoot, services.ResourceCollection, services.ResourceAlbum:
			validType = info.IsDir()
		}
		if !validType {
			return writeError(c, fiber.StatusNotFound, "resource_not_found", "resource id is invalid or stale")
		}
		if err := openPath(path); err != nil {
			return writeError(c, fiber.StatusInternalServerError, "os_open_failed", "failed to open the resource")
		}
		return c.JSON(fiber.Map{"ok": true})
	}
}

// isAllowedConfigPath 校验 path 是 cfg 中 cacheDir/staticDir/mediaRoots 之一。
// 用绝对路径 + Clean 规范化后比较，避免「./」「../」绕过。
func isAllowedConfigPath(path string, cfg *config.Config) bool {
	abs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	abs = filepath.Clean(abs)
	check := func(p string) bool {
		if p == "" {
			return false
		}
		ap, err := filepath.Abs(p)
		if err != nil {
			return false
		}
		return filepath.Clean(ap) == abs
	}
	if check(cfg.CacheDir) {
		return true
	}
	if check(cfg.StaticDir) {
		return true
	}
	for _, r := range cfg.Roots() {
		if check(r) {
			return true
		}
	}
	// 兜底：当前 cwd 也是允许的（用户常在 cwd 下启后端，cacheDir 默认就是它）
	if cwd, err := os.Getwd(); err == nil {
		if filepath.Clean(cwd) == abs {
			return true
		}
	}
	return false
}
