package handlers

import (
	"bufio"
	"encoding/json"
	"fmt"
	"path/filepath"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

// TranscodeStatusHandler 返回指定视频的转码状态。
//
//	GET /api/videos/:fileId/transcode/status
//
// 响应:
//
//	{
//	  "status":   "not_needed" | "cached" | "queued" | "running" | "failed" | "unavailable",
//	  "progress": 0.0 ~ 1.0,
//	  "etaSec":   0,
//	  "error":    ""
//	}
//
// 设计:
//   - 查询任务、源文件能力与当前磁盘缓存，语义与 SSE 终态快照一致
//   - 路径必须在任一 mediaRoots 之下(安全中间件),扩展名必须在
//     models.VideoExts 白名单内
func TranscodeStatusHandler(svc *services.TranscodeService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		path := middleware.SafePath(c)
		if path == "" {
			return writeError(c, fiber.StatusBadRequest, "missing_path", "missing 'path' query parameter")
		}
		if !models.IsVideoFile(filepath.Base(path)) {
			return writeError(c, fiber.StatusUnsupportedMediaType, "unsupported_video_format", "not a supported video format")
		}
		if svc == nil {
			return c.JSON(fiber.Map{
				"status":   "unavailable",
				"progress": 0,
				"error":    "transcode service not initialized",
			})
		}
		ts := svc.GetStatus(path)
		return c.JSON(fiber.Map{
			"status":   ts.Status.String(),
			"progress": ts.Progress,
			"etaSec":   ts.EtaSec,
			"error":    ts.Error,
		})
	}
}

// TranscodeCancelHandler 取消正在跑的转码。
//
//	POST /api/videos/:fileId/transcode/cancel
//
// 响应:
//
//	{ "ok": true, "status": "<转码被取消后的状态>" }
//
// 没在跑也返回 200 ok=true(GetStatus 之后会看到 failed);权限校验同 status。
func TranscodeCancelHandler(svc *services.TranscodeService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		path := middleware.SafePath(c)
		if path == "" {
			return writeError(c, fiber.StatusBadRequest, "missing_path", "missing 'path' query parameter")
		}
		if !models.IsVideoFile(filepath.Base(path)) {
			return writeError(c, fiber.StatusUnsupportedMediaType, "unsupported_video_format", "not a supported video format")
		}
		if svc == nil {
			return c.JSON(fiber.Map{"ok": false, "error": "transcode service not initialized"})
		}
		svc.Cancel(path)
		ts := svc.GetStatus(path)
		return c.JSON(fiber.Map{
			"ok":     true,
			"status": ts.Status.String(),
		})
	}
}

// TranscodeEventsHandler SSE 推送转码进度事件。
//
//	GET /api/videos/:id/transcode/events
//
// 事件类型(`event:` 字段):
//   - "progress"  { status, progress, etaSec, error }   排队或运行快照
//   - "done"      无活动任务时的当前状态，携带完整快照后关闭
//
// 客户端用 EventSource 订阅;断线后由 service 端 cancel 函数清理
// subscriber。30s 心跳(空注释行)防止代理超时。
func TranscodeEventsHandler(svc *services.TranscodeService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		path := middleware.SafePath(c)
		if path == "" {
			return writeError(c, fiber.StatusBadRequest, "missing_path", "missing 'path' query parameter")
		}
		if !models.IsVideoFile(filepath.Base(path)) {
			return writeError(c, fiber.StatusUnsupportedMediaType, "unsupported_video_format", "not a supported video format")
		}
		if svc == nil {
			return writeError(c, fiber.StatusServiceUnavailable, "transcode_unavailable", "transcode service not initialized")
		}

		c.Set("Content-Type", "text/event-stream")
		c.Set("Cache-Control", "no-cache")
		c.Set("Connection", "keep-alive")
		c.Set("X-Accel-Buffering", "no") // nginx: 不缓冲

		events, cancel := svc.Subscribe(path)

		c.Context().SetBodyStreamWriter(func(w *bufio.Writer) {
			defer cancel()
			ticker := time.NewTicker(30 * time.Second)
			defer ticker.Stop()

			// 初始立即 flush 心跳(防代理超时)
			fmt.Fprintf(w, ": connected\n\n")
			if err := w.Flush(); err != nil {
				return
			}

			for {
				select {
				case info, ok := <-events:
					if !ok {
						return
					}
					data, _ := json.Marshal(info)
					eventName := "progress"
					if info.Status != services.TranscodeStatusQueued &&
						info.Status != services.TranscodeStatusRunning {
						eventName = "done"
					}
					fmt.Fprintf(w, "event: %s\ndata: %s\n\n", eventName, data)
					if err := w.Flush(); err != nil {
						return
					}
					// 终态后退出(订阅者 channel 已 close,下次 read ok=false)
					if eventName == "done" {
						return
					}
				case <-ticker.C:
					fmt.Fprintf(w, ": ping\n\n")
					if err := w.Flush(); err != nil {
						return
					}
				}
			}
		})
		return nil
	}
}
