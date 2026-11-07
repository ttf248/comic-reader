// Package handlers 提供 Fiber 路由处理函数。
package handlers

import (
	"runtime"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/config"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

// HealthResponse 健康检查响应。MediaRoots 仅包含不可逆的根资源 ID。
type HealthResponse struct {
	Status     string   `json:"status"`
	MediaRoots []string `json:"mediaRoots"`
	Version    string   `json:"version"`
	GoVersion  string   `json:"goVersion"`
	Goroutines int      `json:"goroutines"`
	AccessMode string   `json:"accessMode"`
	// 能力位：让前端在启动时知道哪些服务端能力可用，
	// 避免硬编码 false 导致"在系统文件管理器中打开"按钮永远 disabled。
	AllowOsOpen bool `json:"allowOsOpen"`
}

// HealthHandler 返回 /api/health 处理函数。
func HealthHandler(mgr *config.Manager, catalog *services.ResourceCatalog) fiber.Handler {
	return func(c *fiber.Ctx) error {
		cfg := mgr.Get()
		if cfg.AccessMode == config.AccessModeLAN && !middleware.AccessAuthenticated(c) {
			return c.JSON(fiber.Map{
				"status":     "ok",
				"accessMode": config.AccessModeLAN,
			})
		}

		// 媒体根只对外给资源 ID，绝不回显绝对路径。
		roots := mgr.Roots()
		snapshot := catalog.Acquire()
		publicRoots := make([]string, 0, len(roots))
		for _, root := range roots {
			if id := snapshot.ExternalID(root, services.ResourceRoot); id != "" {
				publicRoots = append(publicRoots, id)
			}
		}
		roots = publicRoots
		return c.JSON(HealthResponse{
			Status:      "ok",
			MediaRoots:  roots,
			Version:     config.Version,
			GoVersion:   runtime.Version(),
			Goroutines:  runtime.NumGoroutine(),
			AccessMode:  cfg.AccessMode,
			AllowOsOpen: cfg.AllowOsOpen,
		})
	}
}
