package handlers

import (
	"bufio"
	"encoding/json"
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/config"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

// AsyncScanStartHandler 启动异步扫描，返回 scanId。
//
// POST /api/scans
func AsyncScanStartHandler(runner *services.AsyncScanRunner, mgr *config.Manager) fiber.Handler {
	return func(c *fiber.Ctx) error {
		id, reused, err := runner.StartOrReuse(ScanOptionsFromConfig(mgr))
		if err != nil {
			return writeError(c, fiber.StatusBadRequest, "scan_start_failed", "unable to start scan")
		}
		return c.JSON(fiber.Map{"scanId": id, "reused": reused})
	}
}

// ScanOptionsFromConfig 是启动自动扫描与 HTTP 手动扫描的唯一策略入口。
// 默认不设置 MaxDepth，完整递归所有可访问目录。
func ScanOptionsFromConfig(mgr *config.Manager) services.ScanOptions {
	return services.ScanOptions{
		Roots:   mgr.Roots(),
		Exclude: excludeFromConfig(mgr),
	}
}

// excludeFromConfig 把 Manager 当前配置转成归一化的 ExcludeConfig。
// 抽成 helper 是为了 ScanHandler / AsyncScanStartHandler 共用,避免两处
// 各写一遍(否则改天加字段容易漏改)。
func excludeFromConfig(mgr *config.Manager) services.ExcludeConfig {
	cfg := mgr.Get()
	return services.NormalizeExcludeConfig(
		cfg.SkipHidden,
		cfg.SystemFiles,
		cfg.ExcludePatterns,
	)
}

type scanEventSource interface {
	Subscribe(string) (<-chan services.ProgressEvent, func(), bool)
}

// AsyncScanEventsHandler SSE 事件流。
//
// GET /api/scans/:id/events
func AsyncScanEventsHandler(runner scanEventSource) fiber.Handler {
	return func(c *fiber.Ctx) error {
		id := c.Params("id")
		if id == "" {
			return writeError(c, fiber.StatusBadRequest, "missing_scan_id", "missing scan id")
		}

		events, unsubscribe, ok := runner.Subscribe(id)
		if !ok {
			return writeError(c, fiber.StatusNotFound, "scan_not_found", "scan not found")
		}

		c.Set("Content-Type", "text/event-stream")
		c.Set("Cache-Control", "no-cache")
		c.Set("Connection", "keep-alive")
		c.Set("X-Accel-Buffering", "no")

		// Subscribe 原子返回当前快照；终态重连也沿用原事件，不重建统计。
		c.Response().SetBodyStreamWriter(func(w *bufio.Writer) {
			defer unsubscribe()
			streamScanEvents(w, events, 15*time.Second)
		})

		return nil
	}
}

func streamScanEvents(w *bufio.Writer, events <-chan services.ProgressEvent, heartbeat time.Duration) {
	ticker := time.NewTicker(heartbeat)
	defer ticker.Stop()
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				return
			}
			data, _ := json.Marshal(ev)
			if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Status, data); err != nil {
				return
			}
			if err := w.Flush(); err != nil {
				return
			}
			if ev.Status != services.ScanStatusPending && ev.Status != services.ScanStatusRunning {
				return
			}
		case <-ticker.C:
			// 注释心跳不会触发前端进度事件；无新进度时也能发现断开的连接。
			if _, err := fmt.Fprint(w, ": keep-alive\n\n"); err != nil {
				return
			}
			if err := w.Flush(); err != nil {
				return
			}
		}
	}
}

// AsyncScanCancelHandler 取消正在进行的扫描。
//
// DELETE /api/scans/:id
func AsyncScanCancelHandler(runner *services.AsyncScanRunner) fiber.Handler {
	return func(c *fiber.Ctx) error {
		id := c.Params("id")
		state := runner.Get(id)
		if state == nil {
			return writeError(c, fiber.StatusNotFound, "scan_not_found", "scan not found")
		}
		if state.Status != services.ScanStatusRunning && state.Status != services.ScanStatusPending {
			return c.JSON(fiber.Map{"ok": true, "alreadyDone": true})
		}
		state.Cancel()
		return c.JSON(fiber.Map{"ok": true})
	}
}

// ScanCacheClearHandler 强制清空扫描结果缓存（DELETE /api/library）。
//
// 同时清掉 ScanResultCache 内存和磁盘 scan_cache.json 文件。
// 清空后 manifest 不再可用；前端应提示用户「建议重新扫描」。
func ScanCacheClearHandler(
	scanCache *services.ScanResultCache,
	catalog *services.ResourceCatalog,
	runner *services.AsyncScanRunner,
) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if runner != nil {
			runner.Invalidate()
		}
		var err error
		if catalog != nil {
			err = catalog.ClearWithCache(scanCache)
		} else {
			err = scanCache.Clear()
		}
		if err != nil {
			return writeError(c, fiber.StatusInternalServerError, "scan_cancel_failed", "unable to cancel scan")
		}
		return c.JSON(fiber.Map{"ok": true})
	}
}
