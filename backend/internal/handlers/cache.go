// Package handlers 提供 Fiber 路由处理函数。
package handlers

import (
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/config"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

// CacheStatsResponse GET /api/cache/stats 的响应体。
//
// 与 services.CacheUsage 字段一一对应,前端 Settings 缓存占用行需要
// 各子项来告诉用户大头在哪。任何字段缺失都会让前端的 SubUsageBadge
// 拿到 undefined,直接读 .available 时炸掉整页。
type CacheStatsResponse struct {
	Path       string `json:"path"`
	TotalBytes int64  `json:"totalBytes"`
	FileCount  int    `json:"fileCount"`
	ScannedAt  string `json:"scannedAt"`
	DurationMs int64  `json:"durationMs"`
	Available  bool   `json:"available"`
	// CacheTTLSeconds 缓存剩余秒数(前端可据此显示"30s 前更新"等提示)
	CacheTTLSeconds int `json:"cacheTtlSeconds"`
	// 按子目录细分:thumbs / converted / previews / video-faststart /
	// video-transcode。子目录不存在时 Available=false,前端灰显。
	Thumbs         services.SubUsage `json:"thumbs"`
	Converted      services.SubUsage `json:"converted"`
	Previews       services.SubUsage `json:"previews"`
	VideoFaststart services.SubUsage `json:"videoFaststart"`
	VideoTranscode services.SubUsage `json:"videoTranscode"`
	// MediaBytes / MediaFileCount 是上面五类媒体缓存的和。
	//
	// TotalBytes 统计的是整棵 derived/ 子树,里面还有 AI 分析产物与媒体
	// 尺寸缓存,所以五类细分加起来并不等于 TotalBytes。前端要展示
	// 「媒体派生缓存占多少」时用这两个字段,才是真能对账的数。
	MediaBytes     int64 `json:"mediaBytes"`
	MediaFileCount int   `json:"mediaFileCount"`
}

// CacheStatsHandler 返回 /api/cache/stats 处理函数。
//
// 计算 mgr 当前 cacheDir 的总占用 + 文件数;带 30s 内存 TTL,
// 频繁刷新不会重复扫描磁盘。Cleanup / 删除缓存后 handler 会 invalidate。
func CacheStatsHandler(mgr *config.Manager, stats *services.CacheStatsService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		cfg := mgr.Get()
		usage, expiresAt, err := stats.Usage(cfg.CacheDir)
		if err != nil {
			return writeError(c, fiber.StatusInternalServerError, "cache_stats_unavailable", "cache statistics are unavailable")
		}
		resp := CacheStatsResponse{
			Path:            "cache",
			TotalBytes:      usage.TotalBytes,
			FileCount:       usage.FileCount,
			ScannedAt:       usage.ScannedAt.UTC().Format("2006-01-02T15:04:05Z"),
			DurationMs:      usage.DurationMs,
			Available:       usage.Available,
			CacheTTLSeconds: 0,
			Thumbs:          usage.Thumbs,
			Converted:       usage.Converted,
			Previews:        usage.Previews,
			VideoFaststart:  usage.VideoFaststart,
			VideoTranscode:  usage.VideoTranscode,
		}
		resp.Thumbs.Path = "thumbs"
		resp.Converted.Path = "converted"
		resp.Previews.Path = "previews"
		resp.VideoFaststart.Path = "video-faststart"
		resp.VideoTranscode.Path = "video-transcode"
		resp.MediaBytes = resp.Thumbs.Bytes + resp.Converted.Bytes +
			resp.Previews.Bytes + resp.VideoFaststart.Bytes + resp.VideoTranscode.Bytes
		resp.MediaFileCount = resp.Thumbs.FileCount + resp.Converted.FileCount +
			resp.Previews.FileCount + resp.VideoFaststart.FileCount + resp.VideoTranscode.FileCount
		if expiresAt != nil {
			left := int(time.Until(*expiresAt).Seconds())
			if left > 0 {
				resp.CacheTTLSeconds = left
			}
		}
		return c.JSON(resp)
	}
}

// CacheClearScope 清空缓存的 scope 参数值。
//
// 设计选择:用字符串而不是 enum,这样新增 scope(比如未来加 "web_settings"
// 之类的)时,前端 / API / 文档改一处即可,不需要 server 端做魔法反射。
// 非法 scope 直接 400,让前端尽早发现错别字。
const (
	CacheClearScopeThumbs    = "thumbs"
	CacheClearScopeConverted = "converted"
	CacheClearScopePreviews  = "previews"
	CacheClearScopeFaststart = "faststart"
	CacheClearScopeTranscode = "transcode"
	CacheClearScopeAll       = "all"
)

// CacheClearResult POST /api/cache/clear 的响应。
//
// 字段设计:
//   - scope    请求的 scope,供前端在 toast 里复述"已清空 X"
//   - thumbs/converted/previews/faststart/transcode 五个独立子项,各自报告
//     deleted / freedBytes;未涉及的 scope 字段为 nil,前端用
//     "scope in 响应" 来判断是否要展示。
//   - totalDeleted/totalFreedBytes 各 scope 的累加(便于一键全清时一次性显示)。
//
// 前端约定:scope=thumbs 时只读 thumbs 字段,以此类推;scope=all 时
// 读 total* 字段。无效 scope 走 400 分支。
type CacheClearResult struct {
	Scope string `json:"scope"`
	// 五个子项,各自 pointer 允许 nil(JSON 序列化为 null 即可,
	// 前端用 ?? 兜底)。三个 service 都可能为 nil(ffmpeg 缺失场景),
	// 此时 bytes/fileCount 为 0。
	Thumbs          *CacheScopeResult `json:"thumbs,omitempty"`
	Converted       *CacheScopeResult `json:"converted,omitempty"`
	Previews        *CacheScopeResult `json:"previews,omitempty"`
	Faststart       *CacheScopeResult `json:"faststart,omitempty"`
	Transcode       *CacheScopeResult `json:"transcode,omitempty"`
	TotalDeleted    int               `json:"totalDeleted"`
	TotalFreedBytes int64             `json:"totalFreedBytes"`
}

// CacheScopeResult 单个 scope 的清空结果。
type CacheScopeResult struct {
	Deleted    int   `json:"deleted"`
	FreedBytes int64 `json:"freedBytes"`
}

// CacheClearHandler 统一清空缓存的处理函数(POST /api/cache/clear)。
//
//	POST /api/cache/clear?scope=thumbs|converted|previews|faststart|transcode|all
//
// 行为:
//   - scope=thumbs     调 ThumbnailService.ClearThumbnails()
//   - scope=converted  调 ThumbnailService.ClearConverted()(HEIC 等整图转换)
//   - scope=previews   调 ThumbnailService.ClearPreviews()(阅读器预览图)
//   - scope=faststart  调 VideoFaststartService.ClearCache()(本接口新增能力)
//   - scope=transcode  调 TranscodeService.ClearCache()(转码缓存全清)
//   - scope=all        上面五件事都做
//     并重置视频元数据的内存摘要，不计入磁盘文件数与释放字节。
//   - 无效 scope → 400
//
// 注意:fiber.Path 不带 query string,scope 从 c.Query("scope") 读。
// 未传 scope 视为 invalid,避免"清空所有 / 哪个都不清"的歧义。
func CacheClearHandler(
	thumbs *services.ThumbnailService,
	faststart *services.VideoFaststartService,
	transcode *services.TranscodeService,
	clearVideoInfo func(),
	cacheStats *services.CacheStatsService,
) fiber.Handler {
	return func(c *fiber.Ctx) error {
		scope := strings.ToLower(strings.TrimSpace(c.Query("scope")))
		if scope == "" {
			return writeError(c, fiber.StatusBadRequest, "missing_cache_scope", "missing 'scope' query parameter (thumbs|converted|previews|faststart|transcode|all)")
		}
		if scope != CacheClearScopeThumbs &&
			scope != CacheClearScopeConverted &&
			scope != CacheClearScopePreviews &&
			scope != CacheClearScopeFaststart &&
			scope != CacheClearScopeTranscode &&
			scope != CacheClearScopeAll {
			return writeError(c, fiber.StatusBadRequest, "invalid_cache_scope", "invalid scope: must be one of thumbs|converted|previews|faststart|transcode|all")
		}

		result := CacheClearResult{Scope: scope}

		// 顺序无关,各自独立失败:thumbs 失败不会阻止 faststart。
		// 这里不做并发(三个 service 都有内部锁,串行更简单可调试)。
		if scope == CacheClearScopeThumbs || scope == CacheClearScopeAll {
			if thumbs != nil {
				deleted, freed, err := thumbs.ClearThumbnails()
				if err != nil {
					return writeError(c, fiber.StatusInternalServerError, "cache_clear_failed", "clear thumbnails")
				}
				result.Thumbs = &CacheScopeResult{Deleted: deleted, FreedBytes: freed}
				result.TotalDeleted += deleted
				result.TotalFreedBytes += freed
			}
		}
		if scope == CacheClearScopeConverted || scope == CacheClearScopeAll {
			if thumbs != nil {
				deleted, freed, err := thumbs.ClearConverted()
				if err != nil {
					return writeError(c, fiber.StatusInternalServerError, "cache_clear_failed", "clear converted cache")
				}
				result.Converted = &CacheScopeResult{Deleted: deleted, FreedBytes: freed}
				result.TotalDeleted += deleted
				result.TotalFreedBytes += freed
			}
		}
		if scope == CacheClearScopePreviews || scope == CacheClearScopeAll {
			if thumbs != nil {
				deleted, freed, err := thumbs.ClearPreviews()
				if err != nil {
					return writeError(c, fiber.StatusInternalServerError, "cache_clear_failed", "clear previews cache")
				}
				result.Previews = &CacheScopeResult{Deleted: deleted, FreedBytes: freed}
				result.TotalDeleted += deleted
				result.TotalFreedBytes += freed
			}
		}
		if scope == CacheClearScopeFaststart || scope == CacheClearScopeAll {
			if faststart != nil {
				deleted, freed, err := faststart.ClearCache()
				if err != nil {
					return writeError(c, fiber.StatusInternalServerError, "cache_clear_failed", "clear faststart cache")
				}
				result.Faststart = &CacheScopeResult{Deleted: deleted, FreedBytes: freed}
				result.TotalDeleted += deleted
				result.TotalFreedBytes += freed
			}
		}
		if scope == CacheClearScopeTranscode || scope == CacheClearScopeAll {
			if transcode != nil {
				// ClearCache 是"全清"语义,与 TranscodeService.Evict 不同
				// (后者要 maxBytes / maxAgeDays 任一为正才生效)。
				deleted, freed, err := transcode.ClearCache()
				if err != nil {
					return writeError(c, fiber.StatusInternalServerError, "cache_clear_failed", "clear transcode cache")
				}
				result.Transcode = &CacheScopeResult{Deleted: deleted, FreedBytes: freed}
				result.TotalDeleted += deleted
				result.TotalFreedBytes += freed
			}
		}

		if scope == CacheClearScopeAll && clearVideoInfo != nil {
			clearVideoInfo()
		}
		if cacheStats != nil {
			cacheStats.Invalidate()
		}
		return c.JSON(result)
	}
}
