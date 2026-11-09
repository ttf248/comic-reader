package handlers

import (
	"bufio"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/services"
)

// CacheRebuildStartRequest 是启动重建的请求体。
type CacheRebuildStartRequest struct {
	// Scopes 要重建的范围：thumbs（渲染图）/ previews（预览图）。
	Scopes []string `json:"scopes"`
	// PreviewWidth 预览图档位宽度；缺省 1280。
	PreviewWidth int `json:"previewWidth,omitempty"`
}

// CacheRebuildStartHandler 启动一次缓存重建。
//
//	POST /api/cache/rebuild
//	{"scopes":["thumbs","previews"],"previewWidth":1280}
//
// 响应 `{ jobId, reused, scopes, previewWidth }`。已有任务在跑时复用它
// （reused=true），避免两个任务抢同一份解码预算。
//
// 重建是后台任务：清空缓存后不必靠浏览路径现算，页面上看得见进度、
// 也能中途取消。
func CacheRebuildStartHandler(svc *services.CacheRebuildService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if svc == nil {
			return writeError(c, fiber.StatusServiceUnavailable, "rebuild_unavailable", "cache rebuild service is not initialized")
		}
		var body CacheRebuildStartRequest
		if len(c.Body()) > 0 {
			if err := json.Unmarshal(c.Body(), &body); err != nil {
				return writeError(c, fiber.StatusBadRequest, "invalid_rebuild_request", "request body is not valid JSON")
			}
		}
		if len(body.Scopes) == 0 {
			return writeError(c, fiber.StatusBadRequest, "missing_rebuild_scope", "scopes must not be empty")
		}
		for _, scope := range body.Scopes {
			if scope != services.CacheScopeThumbs && scope != services.CacheScopePreviews {
				return writeError(c, fiber.StatusBadRequest, "invalid_rebuild_scope", "unknown rebuild scope")
			}
		}
		jobID, reused, err := svc.Start(body.Scopes, body.PreviewWidth)
		if err != nil {
			return writeError(c, fiber.StatusBadRequest, "rebuild_start_failed", err.Error())
		}
		return c.JSON(fiber.Map{
			"ok":           true,
			"jobId":        jobID,
			"reused":       reused,
			"scopes":       body.Scopes,
			"previewWidth": body.PreviewWidth,
		})
	}
}

// CacheRebuildStatusHandler 返回重建任务的当前快照。
//
//	GET /api/cache/rebuild/:id
func CacheRebuildStatusHandler(svc *services.CacheRebuildService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		id := c.Params("id")
		if id == "" {
			return writeError(c, fiber.StatusBadRequest, "missing_rebuild_id", "missing rebuild id")
		}
		progress, ok := svc.Status(id)
		if !ok {
			return writeError(c, fiber.StatusNotFound, "rebuild_not_found", "rebuild job not found")
		}
		return c.JSON(progress)
	}
}

// CacheRebuildCancelHandler 取消正在进行的重建。
//
//	DELETE /api/cache/rebuild/:id
func CacheRebuildCancelHandler(svc *services.CacheRebuildService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		id := c.Params("id")
		if id == "" {
			return writeError(c, fiber.StatusBadRequest, "missing_rebuild_id", "missing rebuild id")
		}
		if !svc.Cancel(id) {
			if _, ok := svc.Status(id); !ok {
				return writeError(c, fiber.StatusNotFound, "rebuild_not_found", "rebuild job not found")
			}
			// 已经结束的任务不必报错：用户点取消时它可能刚好做完。
			return c.JSON(fiber.Map{"ok": true, "alreadyDone": true})
		}
		return c.JSON(fiber.Map{"ok": true})
	}
}

// CacheRebuildEventsHandler 推送重建进度（SSE）。
//
//	GET /api/cache/rebuild/:id/events
//
// 事件名与任务状态同名（pending/running/complete/cancelled/error），
// data 为 CacheRebuildProgress 快照。终态事件后关闭连接。
func CacheRebuildEventsHandler(svc *services.CacheRebuildService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		id := c.Params("id")
		if id == "" {
			return writeError(c, fiber.StatusBadRequest, "missing_rebuild_id", "missing rebuild id")
		}
		events, unsubscribe, ok := svc.Subscribe(id)
		if !ok {
			return writeError(c, fiber.StatusNotFound, "rebuild_not_found", "rebuild job not found")
		}

		c.Set("Content-Type", "text/event-stream")
		c.Set("Cache-Control", "no-cache")
		c.Set("Connection", "keep-alive")
		c.Set("X-Accel-Buffering", "no")

		c.Response().SetBodyStreamWriter(func(w *bufio.Writer) {
			defer unsubscribe()
			streamCacheRebuildEvents(w, events, 15*time.Second)
		})
		return nil
	}
}

func streamCacheRebuildEvents(w *bufio.Writer, events <-chan services.CacheRebuildProgress, heartbeat time.Duration) {
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
			if ev.Status != services.RebuildStatusPending && ev.Status != services.RebuildStatusRunning {
				return
			}
		case <-ticker.C:
			if _, err := fmt.Fprint(w, ": keep-alive\n\n"); err != nil {
				return
			}
			if err := w.Flush(); err != nil {
				return
			}
		}
	}
}

// RebuildScopeLabels 把重建范围翻成中文，供界面直接显示。
func RebuildScopeLabels(scopes []string) []string {
	out := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		switch strings.TrimSpace(scope) {
		case services.CacheScopeThumbs:
			out = append(out, "缩略图")
		case services.CacheScopePreviews:
			out = append(out, "预览图")
		default:
			out = append(out, scope)
		}
	}
	return out
}
