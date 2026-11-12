package handlers

import (
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/services"
)

// StorageHandlerOptions 存储接口需要的本机位置。
type StorageHandlerOptions struct {
	CacheRoot       string
	WorkerDirectory string
}

// StorageUsageHandler 返回本机分析任务的模型权重与产物占用。
//
// 响应里的路径一律相对缓存根目录，各设备都能看；绝对路径只由
// StoragePathsHandler 给出。
func StorageUsageHandler(service *services.AIStorageService, options StorageHandlerOptions) fiber.Handler {
	return func(c *fiber.Ctx) error {
		c.Set(fiber.HeaderCacheControl, "no-store")
		if service == nil {
			return writeError(c, fiber.StatusServiceUnavailable, "storage_unavailable", "storage information is unavailable")
		}
		usage, expiresAt, err := service.Usage(options.CacheRoot, options.WorkerDirectory)
		if err != nil {
			return writeError(c, fiber.StatusInternalServerError, "storage_unavailable", "storage information is unavailable")
		}
		if expiresAt != nil {
			if left := int(time.Until(*expiresAt).Seconds()); left > 0 {
				usage.CacheTTLSeconds = left
			}
		}
		return c.JSON(fiber.Map{"ok": true, "usage": usage})
	}
}

// StoragePathsHandler 返回本机绝对路径。只允许回环访问。
func StoragePathsHandler(service *services.AIStorageService, options services.AIStoragePathOptions) fiber.Handler {
	return func(c *fiber.Ctx) error {
		c.Set(fiber.HeaderCacheControl, "no-store")
		if service == nil {
			return writeError(c, fiber.StatusServiceUnavailable, "storage_unavailable", "storage information is unavailable")
		}
		return c.JSON(fiber.Map{"ok": true, "paths": service.AbsolutePaths(options)})
	}
}

// AIJobOutputHandler 返回单次分析任务的产物占用。
func AIJobOutputHandler(aiJobs *services.AIJobService, outputs *services.JobOutputService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		c.Set(fiber.HeaderCacheControl, "no-store")
		if aiJobs == nil || outputs == nil {
			return writeError(c, fiber.StatusServiceUnavailable, "analysis_unavailable", "analysis service is unavailable")
		}
		jobID := c.Params("jobId")
		directory, moduleType, ok := aiJobs.JobOutputDir(jobID)
		if !ok {
			return writeError(c, fiber.StatusNotFound, "analysis_job_not_found", "analysis task was not found")
		}
		return c.JSON(fiber.Map{"ok": true, "output": outputs.Usage(jobID, moduleType, directory)})
	}
}
