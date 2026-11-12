package handlers

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
	"github.com/tianlongxiang/local-gallery/internal/store"
)

type aiJobStartRequest struct {
	Type string `json:"type"`
	Mode string `json:"mode"`
}

type aiJobSequenceStartRequest struct {
	Mode string `json:"mode"`
}

type aiJobQueueMoveRequest struct {
	Direction string `json:"direction"`
}

type aiJobSettingsRequest struct {
	DailyEnabled  bool     `json:"dailyEnabled"`
	DailyTime     string   `json:"dailyTime"`
	DailyModules  []string `json:"dailyModules"`
	PeopleEnabled bool     `json:"peopleEnabled"`
}

// AIJobsHandler 返回任务历史、活动任务与每日调度设置。
func AIJobsHandler(service *services.AIJobService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if service == nil {
			return writeError(c, fiber.StatusServiceUnavailable, "analysis_unavailable", "analysis service is unavailable")
		}
		return c.JSON(fiber.Map{"ok": true, "snapshot": service.List()})
	}
}

// aiEstimateTimeout 是核算的时长上限。超大库要逐张 stat，给一个确定的
// 失败姿态比让请求一直挂着好。
const aiEstimateTimeout = 60 * time.Second

// AIJobEstimateHandler 返回各分析模块在增量与全量模式下的预计张数与耗时。
//
// 只读：核算不创建任务，也不写状态文件。张数与任务实际会处理的张数用同一条
// 判据，因此这里数出来的增量张数就是任务开始后的 planned。
func AIJobEstimateHandler(service *services.AIJobService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if service == nil {
			return writeError(c, fiber.StatusServiceUnavailable, "analysis_unavailable", "analysis service is unavailable")
		}
		ctx, cancel := context.WithTimeout(c.UserContext(), aiEstimateTimeout)
		defer cancel()
		estimate, err := service.Estimate(ctx)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				return writeError(c, fiber.StatusServiceUnavailable, "analysis_estimate_timeout", "estimating the analysis workload took too long")
			}
			return writeError(c, fiber.StatusInternalServerError, "analysis_estimate_failed", "unable to estimate the analysis workload")
		}
		return c.JSON(fiber.Map{"ok": true, "estimate": estimate})
	}
}

// AIJobStartHandler 启动一次分析任务。
func AIJobStartHandler(service *services.AIJobService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if service == nil {
			return writeError(c, fiber.StatusServiceUnavailable, "analysis_unavailable", "analysis service is unavailable")
		}
		var body aiJobStartRequest
		if err := c.BodyParser(&body); err != nil {
			return writeError(c, fiber.StatusBadRequest, "invalid_analysis_request", "request body is not valid JSON")
		}
		job, reused, err := service.Start(strings.TrimSpace(body.Type), strings.TrimSpace(body.Mode))
		if err != nil {
			if errors.Is(err, services.ErrPeopleAnalysisDisabled) {
				return writeError(c, fiber.StatusForbidden, "people_analysis_disabled", "enable people analysis before starting face tasks")
			}
			if errors.Is(err, services.ErrAIJobActive) {
				return writeError(c, fiber.StatusConflict, "analysis_job_active", "another analysis task is active")
			}
			if errors.Is(err, services.ErrAIModelUnavailable) {
				return writeError(c, fiber.StatusServiceUnavailable, "ai_model_missing", "local semantic model is missing or checksum verification failed")
			}
			if errors.Is(err, services.ErrAIAnalyzerUnavailable) {
				return writeError(c, fiber.StatusServiceUnavailable, "ai_module_unavailable", "local analysis module or model is unavailable")
			}
			if errors.Is(err, services.ErrAIRuntimeUnavailable) || errors.Is(err, services.ErrAIWorkerUnavailable) {
				return writeError(c, fiber.StatusServiceUnavailable, "ai_runtime_unavailable", "local AI runtime is unavailable")
			}
			return writeError(c, fiber.StatusBadRequest, "analysis_start_failed", "unable to start analysis task")
		}
		return c.JSON(fiber.Map{"ok": true, "job": job, "reused": reused})
	}
}

// AIJobSequenceStartHandler 把所有已就绪模块按固定顺序加入现有任务队列。
func AIJobSequenceStartHandler(service *services.AIJobService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if service == nil {
			return writeError(c, fiber.StatusServiceUnavailable, "analysis_unavailable", "analysis service is unavailable")
		}
		var body aiJobSequenceStartRequest
		if err := c.BodyParser(&body); err != nil {
			return writeError(c, fiber.StatusBadRequest, "invalid_analysis_request", "request body is not valid JSON")
		}
		jobs, skipped, err := service.StartAll(strings.TrimSpace(body.Mode))
		if err != nil {
			if errors.Is(err, services.ErrAIJobActive) {
				return writeError(c, fiber.StatusConflict, "analysis_job_active", "another analysis task is active")
			}
			if errors.Is(err, services.ErrAIAnalyzerUnavailable) {
				return writeError(c, fiber.StatusServiceUnavailable, "ai_module_unavailable", "no local analysis modules are ready")
			}
			return writeError(c, fiber.StatusBadRequest, "analysis_start_failed", "unable to queue analysis tasks")
		}
		return c.JSON(fiber.Map{"ok": true, "jobs": jobs, "skippedModules": skipped})
	}
}

// AIJobStatusHandler 返回单项任务快照。
func AIJobStatusHandler(service *services.AIJobService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		job, ok := service.Get(c.Params("id"))
		if !ok {
			return writeError(c, fiber.StatusNotFound, "analysis_job_not_found", "analysis task was not found")
		}
		return c.JSON(job)
	}
}

// AIJobQueueMoveHandler adjusts a waiting task's position by one slot.
func AIJobQueueMoveHandler(service *services.AIJobService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		var body aiJobQueueMoveRequest
		if err := c.BodyParser(&body); err != nil {
			return writeError(c, fiber.StatusBadRequest, "invalid_analysis_queue_request", "request body is not valid JSON")
		}
		err := service.MovePending(c.Params("id"), strings.TrimSpace(body.Direction))
		if errors.Is(err, services.ErrAIJobNotFound) {
			return writeError(c, fiber.StatusNotFound, "analysis_job_not_found", "analysis task was not found")
		}
		if errors.Is(err, services.ErrAIJobNotManageable) {
			return writeError(c, fiber.StatusConflict, "analysis_queue_action_unavailable", "task cannot be moved in its current position or state")
		}
		if err != nil {
			if errors.Is(err, services.ErrAIJobInvalidDirection) {
				return writeError(c, fiber.StatusBadRequest, "invalid_analysis_queue_request", "direction must be up or down")
			}
			return writeError(c, fiber.StatusInternalServerError, "analysis_queue_update_failed", "task queue could not be updated")
		}
		return c.JSON(fiber.Map{"ok": true, "snapshot": service.List()})
	}
}

// AIJobQueueHandler clears waiting tasks and retains the active task.
func AIJobQueueHandler(service *services.AIJobService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		cancelled, err := service.ClearPending()
		if err != nil {
			return writeError(c, fiber.StatusInternalServerError, "analysis_queue_update_failed", "task queue could not be cleared")
		}
		return c.JSON(fiber.Map{"ok": true, "cancelledCount": cancelled, "snapshot": service.List()})
	}
}

// AIJobHistoryHandler deletes terminal task records without deleting analysis results.
func AIJobHistoryHandler(service *services.AIJobService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		deleted, err := service.ClearHistory()
		if err != nil {
			return writeError(c, fiber.StatusInternalServerError, "analysis_history_delete_failed", "task history could not be cleared")
		}
		return c.JSON(fiber.Map{"ok": true, "deletedCount": deleted, "snapshot": service.List()})
	}
}

// AIJobHistoryItemHandler deletes one terminal task record.
func AIJobHistoryItemHandler(service *services.AIJobService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		err := service.DeleteHistory(c.Params("id"))
		if errors.Is(err, services.ErrAIJobNotFound) {
			return writeError(c, fiber.StatusNotFound, "analysis_job_not_found", "analysis task was not found")
		}
		if errors.Is(err, services.ErrAIJobNotManageable) {
			return writeError(c, fiber.StatusConflict, "analysis_history_delete_unavailable", "active or waiting tasks cannot be deleted")
		}
		if err != nil {
			return writeError(c, fiber.StatusInternalServerError, "analysis_history_delete_failed", "task history could not be deleted")
		}
		return c.JSON(fiber.Map{"ok": true})
	}
}

// AIJobEventsHandler 通过 SSE 推送任务快照，断开连接只释放订阅。
func AIJobEventsHandler(service *services.AIJobService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		events, unsubscribe, ok := service.Subscribe(c.Params("id"))
		if !ok {
			return writeError(c, fiber.StatusNotFound, "analysis_job_not_found", "analysis task was not found")
		}
		c.Set("Content-Type", "text/event-stream")
		c.Set("Cache-Control", "no-cache")
		c.Set("Connection", "keep-alive")
		c.Set("X-Accel-Buffering", "no")
		c.Response().SetBodyStreamWriter(func(w *bufio.Writer) {
			defer unsubscribe()
			streamAIJobEvents(w, events, 15*time.Second)
		})
		return nil
	}
}

func streamAIJobEvents(w *bufio.Writer, events <-chan services.AIJob, heartbeat time.Duration) {
	ticker := time.NewTicker(heartbeat)
	defer ticker.Stop()
	for {
		select {
		case job, open := <-events:
			if !open {
				return
			}
			data, _ := json.Marshal(job)
			if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", job.Status, data); err != nil {
				return
			}
			if err := w.Flush(); err != nil {
				return
			}
			if job.Status == services.AIJobStatusCompleted || job.Status == services.AIJobStatusFailed || job.Status == services.AIJobStatusCancelled {
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

// AIJobActionHandler 处理暂停、继续、取消和重试操作。
func AIJobActionHandler(service *services.AIJobService, action string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		id := c.Params("id")
		switch action {
		case "pause":
			if service.Pause(id) {
				return c.JSON(fiber.Map{"ok": true})
			}
		case "resume":
			if service.Resume(id) {
				return c.JSON(fiber.Map{"ok": true})
			}
		case "cancel":
			if service.Cancel(id) {
				return c.JSON(fiber.Map{"ok": true})
			}
		case "retry":
			job, err := service.Retry(id)
			if err == nil {
				return c.JSON(fiber.Map{"ok": true, "job": job})
			}
			if errors.Is(err, services.ErrAIJobActive) {
				return writeError(c, fiber.StatusConflict, "analysis_job_active", "another analysis task is active")
			}
		}
		if _, exists := service.Get(id); !exists {
			return writeError(c, fiber.StatusNotFound, "analysis_job_not_found", "analysis task was not found")
		}
		return writeError(c, fiber.StatusConflict, "analysis_action_unavailable", "task does not support this action")
	}
}

// AIJobSettingsHandler 读取或更新本地每日增量分析计划。
func AIJobSettingsHandler(service *services.AIJobService, people *services.PeopleService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if c.Method() == fiber.MethodGet {
			return c.JSON(fiber.Map{"ok": true, "settings": service.List().Settings})
		}
		var body aiJobSettingsRequest
		if err := c.BodyParser(&body); err != nil {
			return writeError(c, fiber.StatusBadRequest, "invalid_analysis_settings", "request body is not valid JSON")
		}
		peopleWasEnabled := service.PeopleEnabled()
		settings, err := service.ConfigureDaily(body.DailyEnabled, body.DailyTime, body.DailyModules, body.PeopleEnabled)
		if err != nil {
			if errors.Is(err, services.ErrAIJobActive) {
				return writeError(c, fiber.StatusConflict, "analysis_job_active", "stop the face analysis task before disabling people analysis")
			}
			return writeError(c, fiber.StatusBadRequest, "invalid_analysis_settings", "dailyTime and dailyModules are invalid")
		}
		if settings.PeopleEnabled && !peopleWasEnabled && people != nil {
			if err := people.Sync(service.Records(services.AIJobTypeFace)); err != nil {
				return writeError(c, fiber.StatusInternalServerError, "people_index_unavailable", "people index could not be prepared")
			}
		}
		return c.JSON(fiber.Map{"ok": true, "settings": settings})
	}
}

// ImageMetadataHandler 返回当前文件版本对应的 EXIF 摘要，不暴露源路径。
func ImageMetadataHandler(service *services.AIJobService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		id := middleware.ResourceID(c)
		path := middleware.SafePath(c)
		if !models.IsImageFile(path) {
			return writeError(c, fiber.StatusUnsupportedMediaType, "invalid_metadata_resource", "metadata is available for images only")
		}
		response := fiber.Map{"ok": true, "resourceId": id, "status": "pending"}
		record, ok := service.Record(services.AIJobTypeMetadata, id)
		if !ok {
			return c.JSON(response)
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() != record.Size || info.ModTime().UnixNano() != record.MTimeNs {
			return c.JSON(response)
		}
		var metadata services.ImageMetadata
		if json.Unmarshal(record.Data, &metadata) != nil {
			return writeError(c, fiber.StatusInternalServerError, "metadata_read_failed", "metadata result is unavailable")
		}
		response["status"] = record.Status
		response["moduleVersion"] = record.ModuleVersion
		response["updatedAt"] = record.UpdatedAt
		response["metadata"] = metadata
		if record.ErrorCode != "" {
			response["error"] = fiber.Map{"code": record.ErrorCode, "message": record.ErrorMessage}
		}
		return c.JSON(response)
	}
}

// GPSLocationsHandler 返回 GPS 地点相册列表或相册内媒体分页。
func GPSLocationsHandler(catalog *services.ResourceCatalog, jobs *services.AIJobService, validate func(string) (string, error), picks *store.PickStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		limit, ok := parseLibraryPageLimit(c)
		if !ok {
			return nil
		}
		snapshot := requestCatalogSnapshot(c, catalog)
		if c.Params("id") == "" {
			page, err := services.PageGPSLocations(snapshot, jobs.Records(services.AIJobTypeMetadata), validate, c.Query("cursor"), limit)
			if err != nil {
				return writeLibraryPageError(c, err, snapshot.Revision())
			}
			return c.JSON(fiber.Map{"ok": true, "page": page})
		}
		page, err := services.PageGPSLocationMedia(snapshot, jobs.Records(services.AIJobTypeMetadata), validate, c.Params("id"), c.Query("cursor"), limit)
		if err != nil {
			if errors.Is(err, services.ErrGPSLocationNotFound) {
				return writeError(c, fiber.StatusNotFound, "location_not_found", "GPS location was not found")
			}
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		markFeedPicks(picks, page.Items)
		return c.JSON(fiber.Map{"ok": true, "page": page})
	}
}
