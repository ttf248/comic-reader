// Command server 本地画廊后端入口。
//
// 启动流程：
//  1. 解析 flag：仅 --config（指定 YAML 路径）
//  2. 通过 config.Manager 加载 config.yaml（缺失则用内置默认；显式字段覆盖默认）
//  3. 校验运行参数；媒体目录离线时仍开放设置页，扫描失败保留原快照
//  4. 注册中间件 + 路由（中间件和扫描 handler 都从 Manager 读最新根目录）
//  5. 监听 host:port
//
// 不再支持环境变量或 --comic-root / --host / --port 等覆盖；
// 所有运行时配置集中在 config.yaml（参考 backend/config.example.yaml），
// 也可通过 /api/config 在网页设置页修改并自动持久化。
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/compress"

	"github.com/tianlongxiang/local-gallery/internal/config"
	"github.com/tianlongxiang/local-gallery/internal/handlers"
	"github.com/tianlongxiang/local-gallery/internal/httputil"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
	"github.com/tianlongxiang/local-gallery/internal/store"
)

func main() {
	// ---- 1. 解析 flag（仅保留配置文件路径）----
	flagConfig := flag.String("config", config.DefaultConfigName, "配置文件路径（YAML，相对 CWD）")
	flag.Parse()

	// ---- 2. 加载 YAML 配置（通过 Manager，handler 可热更新）----
	mgr, err := config.NewManager(*flagConfig)
	if err != nil {
		fmt.Fprintf(os.Stderr, "加载配置失败 %s\n", filepath.Base(*flagConfig))
		os.Exit(2)
	}
	cfg := mgr.Get()

	// ---- 3. 运行时参数全部来自 YAML ----
	staticDir := cfg.StaticDir

	// ---- 4. 校验 ----
	if err := cfg.Validate(); err != nil {
		fmt.Fprintf(os.Stderr, "配置校验失败，请检查 config.yaml 中的目录与参数\n")
		fmt.Fprintf(os.Stderr, "提示：在 config.yaml 中设置 mediaRoots 指向媒体根目录\n")
		os.Exit(2)
	}

	log.Printf("local-gallery 后端启动中...")
	roots := cfg.Roots()
	if len(roots) == 1 {
		log.Printf("  MediaRoot: %s", filepath.Base(roots[0]))
	} else {
		log.Printf("  MediaRoots (%d):", len(roots))
		for _, r := range roots {
			log.Printf("    - %s", filepath.Base(r))
		}
	}
	log.Printf("  CacheDir:  <configured>")
	log.Printf("  Rendition: %v", services.RenditionWidths)
	log.Printf("  Listen:    %s", cfg.Addr())
	log.Printf("  Access:    %s", cfg.AccessMode)

	// ---- 5. 创建并启动 Fiber App ----
	app := fiber.New(fiber.Config{
		AppName:               "local-gallery",
		DisableStartupMessage: true,
		// ShutdownWithTimeout 无法主动关闭 keep-alive 连接；设置读取和空闲
		// 超时，确保退出窗口有明确上界。SSE 不设置 WriteTimeout。
		ReadTimeout: 30 * time.Second,
		IdleTimeout: 60 * time.Second,
		// 备份导入允许 32 MiB 文件及 JSON 包装；封面和认证接口另有自身限制。
		BodyLimit: 64 * 1024 * 1024,
		ErrorHandler: func(c *fiber.Ctx, err error) error {
			if fe, ok := err.(*fiber.Error); ok {
				return httputil.Error(c, fe.Code, "http_error", fe.Message)
			}
			return httputil.Internal(c, "internal_error", "internal server error")
		},
	})

	app.Use(middleware.Logger())
	app.Use(middleware.Recover())

	// 路径安全中间件：根集合从 Manager 动态读取，运行中可热更新
	resourceCatalog := services.NewResourceCatalog()
	safetyMw, safetyState := middleware.PathSafetyMiddleware(cfg.Roots(), resourceCatalog)
	mgr.OnChange("path_safety", func(snapshot *config.Config) {
		safetyState.SetRoots(snapshot.Roots())
	})

	// ---- 路由 ----
	// 服务端 ffmpeg 抽帧器(可选):ffmpeg 不在/坏掉时 Available()=false,
	// ThumbnailService 会自动回退到原"客户端抽帧 + 上传"流程。
	videoCover := services.NewVideoCoverExtractor(services.VideoCoverOptions{
		FFmpegPath: cfg.FFmpegPath,
		Quality:    85,
		Timeout:    10 * time.Second,
	})
	if videoCover.Available() {
		log.Printf("  FFmpeg:    <可用> (服务端视频封面已启用)")
	} else {
		log.Printf("  FFmpeg:    <不可用 / 未配置> → 视频封面回退到客户端浏览器抽帧")
	}

	// 图片转换器(可选):把 HEIC/HEIF 这类纯 Go 解不了的图片转成缩略图。
	// ffmpeg 不可用时这类文件按"不支持的格式"处理(前端显示占位图)。
	imageConverter := services.NewImageConverter(services.ImageConverterOptions{
		FFmpegPath: cfg.FFmpegPath,
		Quality:    85,
		Timeout:    10 * time.Second,
	})
	if imageConverter.Available() {
		log.Printf("  HEIC:      <可用> (服务端 HEIC/HEIF 缩略图已启用)")
	} else {
		log.Printf("  HEIC:      <不可用 / 未配置> → HEIC/HEIF 显示占位图")
	}

	// ffprobe 元数据服务(可选)
	videoInfo := services.NewVideoInfoService(services.VideoInfoOptions{
		FFmpegPath: cfg.FFmpegPath,
		Timeout:    5 * time.Second,
	})
	if videoInfo.Available() {
		log.Printf("  VideoMetadata: <可用> (视频元数据已启用)")
	}

	cacheLayout, err := services.EnsureCacheLayout(cfg.CacheDir)
	if err != nil {
		log.Fatalf("初始化缓存目录失败: %v", err)
	}

	// 媒体尺寸缓存：照片墙按真实宽高比排布需要像素尺寸，
	// 读一次图片头即可，代价很低；结果缓存后重复打开相册零成本。
	mediaDimensions, err := services.NewMediaDimensionService(
		filepath.Join(cacheLayout.DerivedDir, "media_dimensions.jsonl"),
	)
	if err != nil {
		log.Fatalf("初始化媒体尺寸缓存失败: %v", err)
	}
	defer func() { _ = mediaDimensions.Close() }()

	// 内容属性（照片 / 漫画）：由媒体根目录的属性决定，目录下的相册与集合
	// 一并继承。属性只影响「这本相册用什么方式打开」与列表归属，
	// 不影响扫描结果，因此可热更新。
	contentKindPolicy := func(snapshot *config.Config) services.ContentKindPolicy {
		roots := snapshot.NormalizedRoots()
		entries := make([]services.RootKind, 0, len(roots))
		for _, root := range roots {
			entries = append(entries, services.RootKind{
				Path: root.Path,
				Kind: models.NormalizeContentKind(root.Kind),
			})
		}
		return services.NewContentKindPolicy(entries)
	}
	resourceCatalog.SetContentKindPolicy(contentKindPolicy(cfg))
	mgr.OnChange("content_kind", func(snapshot *config.Config) {
		resourceCatalog.SetContentKindPolicy(contentKindPolicy(snapshot))
	})

	// 视频 faststart 化服务(可选):把 moov 移到 mdat 前面,解决
	// "非 faststart MP4 在浏览器里无法边下边播"问题。ffmpeg 不可用
	// 时 VideoHandler 静默回退到原文件,不阻断播放。
	//
	// 注意:这里传 derived 根(让 service 内部自己拼 video-faststart
	// 子目录),不要在 main.go 里再加一层 —— 否则会出现
	// cacheDir/video-faststart/video-faststart/<hash>.mp4 的双层嵌套。
	faststart := services.NewVideoFaststartService(services.FaststartOptions{
		CacheDir: cacheLayout.DerivedDir,
		FFmpeg:   cfg.FFmpegPath,
	})
	if faststart.Available() {
		log.Printf("  VideoFaststart: <可用> (非 faststart MP4 自动重封装 + 缓存)")
	} else {
		log.Printf("  VideoFaststart: <不可用> → 非 faststart MP4 仍按原文件发送(浏览器可能播不了)")
	}

	// 视频转码服务(可选):把 AV1/HEVC/ProRes 等浏览器播不了的编码
	// 转成 H.264 + AAC 缓存。ffmpeg 不可用时静默回退到 faststart / 原文件。
	transcode := services.NewTranscodeService(services.TranscodeOptions{
		CacheDir: cacheLayout.DerivedDir,
		FFmpeg:   cfg.FFmpegPath,
		Info:     videoInfo,
		// timeout / concurrency 用默认(30m / NumCPU/2)
	})
	if transcode.Available() {
		log.Printf("  VideoTranscode: <可用> profile=%s concurrency=%d (冷门编码 → H.264+AAC 自动转码 + 缓存)",
			transcode.Profile().Name, transcode.Concurrency())
	} else {
		log.Printf("  VideoTranscode: <不可用> → 冷门编码仍按原文件发送")
	}

	thumbs, err := services.NewThumbnailService(services.ThumbnailOptions{
		CacheDir:       cacheLayout.ThumbnailDir,
		RootDir:        cacheLayout.Root,
		ConvertedDir:   cacheLayout.ConvertedDir,
		PreviewDir:     cacheLayout.PreviewDir,
		MaxAgeDays:     cfg.CacheMaxAgeDays,
		LRUSize:        cfg.ThumbCacheSize,
		VideoCover:     videoCover,
		ImageConverter: imageConverter,
	})
	if err != nil {
		log.Fatalf("初始化缩略图服务失败: %v", err)
	}
	// 渲染时发现文件解码不出来（截断的 JPEG 之类），记进尺寸缓存：
	// 照片墙据此把这些图标成「无法解码」。
	thumbs.SetDecodeFailureRecorder(mediaDimensions.MarkUndecodable)
	cacheStats := services.NewCacheStatsService(30 * time.Second)
	cacheRebuild := services.NewCacheRebuildService(resourceCatalog, thumbs)
	runner := services.NewAsyncScanRunner()
	unreadIndex := services.NewUnreadLibraryIndex()
	prefs := store.NewPrefsStore(cacheLayout.PreferencesPath)
	activities := store.NewActivityStore(cacheLayout.ActivityPath)
	// 照片级精选：与相册级收藏分开存，两份数据互不覆盖。
	picks := store.NewPickStore(cacheLayout.PicksPath)
	if err := activities.Load(); err != nil {
		log.Fatalf("加载媒体活动状态失败: %v", err)
	}

	// 扫描结果缓存（启动时从磁盘加载，供前端免扫描查看）。
	//
	// 启动时校验：缓存文件里记录的 mediaRoots 必须与当前 cfg.Roots() 一致；
	// 不一致时直接清空（删除磁盘文件）并触发一次自动扫描，避免重启后
	// 前端拉到上一个 mediaRoot 下的扫描结果（参见 services.LoadWithRoots）。
	scanCache := services.NewScanResultCache(cacheLayout.ScanCachePath)
	currentRoots := cfg.Roots()
	mismatch, err := scanCache.LoadWithRoots(currentRoots)
	if err != nil {
		log.Printf("警告：加载扫描缓存失败 %v", err)
	}
	// 加载用户自定义封面覆盖（每个 album 可独立设置封面），启动时
	// 一次性应用到 ScanResult 上（之后 SetWithOverrideApplied 在用户
	// 修改时增量更新）。
	coverOverrides := services.NewCoverOverrideStore(cacheLayout.CoverOverridesPath)
	if err := coverOverrides.Load(); err != nil {
		log.Printf("警告：加载封面覆盖失败 %v", err)
	}
	if r := scanCache.Get(); r != nil {
		published, applied := services.ApplyCoverOverridesToResult(r, coverOverrides.Snapshot())
		if applied > 0 {
			scanCache.Set(published)
			log.Printf("  应用了 %d 条用户封面覆盖", applied)
		}
		resourceCatalog.Publish(published, currentRoots)
	}
	runner.SetCache(scanCache)
	runner.SetCatalog(resourceCatalog)
	runner.SetCoverOverrides(coverOverrides)
	if r := scanCache.Get(); r != nil {
		log.Printf("  已加载上次扫描结果：%d 相册，扫描于 %s", r.AlbumCount, r.ScannedAt.Format("2006-01-02 15:04:05"))
	} else if mismatch {
		log.Printf("  扫描缓存与当前媒体根不一致或内容无效，已清空旧缓存")
	}
	workerOptions, err := services.ResolveLocalAIWorkerOptions(cacheLayout.AIModelsDir)
	if err != nil {
		log.Fatalf("初始化本地语义搜索 Worker 失败")
	}
	aiWorker, err := services.NewLocalAIWorker(workerOptions)
	if err != nil {
		log.Fatalf("初始化本地语义搜索 Worker 失败")
	}
	workerStatusCtx, workerStatusCancel := context.WithTimeout(context.Background(), 20*time.Second)
	_, _ = aiWorker.Status(workerStatusCtx)
	workerStatusCancel()
	vectorIndex, err := services.OpenVectorIndex(cacheLayout.AIVectorsDir, services.ChineseCLIPModelVersion)
	if err != nil {
		log.Fatalf("初始化语义向量索引失败: %v", err)
	}
	embeddingAnalyzer, err := services.NewEmbeddingAnalyzer(aiWorker, vectorIndex)
	if err != nil {
		log.Fatalf("初始化向量分析模块失败")
	}
	ocrAnalyzer, err := services.NewOCRAnalyzer(aiWorker)
	if err != nil {
		log.Fatalf("初始化文字识别模块失败")
	}
	faceAnalyzer, err := services.NewFaceAnalyzer(aiWorker)
	if err != nil {
		log.Fatalf("初始化人脸识别模块失败")
	}
	ocrSearchIndex, err := services.OpenOCRSearchIndex(filepath.Join(cacheLayout.AIDerivedDir, "ocr-search-index.json"))
	if err != nil {
		log.Fatalf("初始化 OCR 搜索索引失败: %v", err)
	}
	peopleService, err := services.OpenPeopleService(
		filepath.Join(cacheLayout.StateDir, "people.json"),
		filepath.Join(cacheLayout.AIDerivedDir, "people-index.json"),
	)
	if err != nil {
		log.Fatalf("初始化人物索引失败: %v", err)
	}
	var aiJobs *services.AIJobService
	// 本机存储统计：模型权重与各模块产物的占用。批次提交后产物字节变了，
	// 让缓存失效，下一次读取重新统计。
	storageUsage := services.NewAIStorageService(30 * time.Second)
	jobOutputs := services.NewJobOutputService(cacheLayout.Root, 60*time.Second)
	aiJobs, err = services.NewAIJobService(services.AIJobServiceOptions{
		StatePath:    cacheLayout.AIJobsPath,
		MetadataDir:  cacheLayout.MetadataDir,
		Catalog:      resourceCatalog,
		ValidatePath: safetyState.Validate,
		Analyzers:    []services.AIAnalyzer{services.MetadataAnalyzer{}, embeddingAnalyzer, ocrAnalyzer, faceAnalyzer},
		OnRecordsCommitted: func(records []services.AIAnalysisRecord) {
			if indexErr := ocrSearchIndex.ApplyRecords(records); indexErr != nil {
				log.Printf("更新 OCR 搜索索引失败: %v", indexErr)
			}
			if aiJobs != nil && aiJobs.PeopleEnabled() {
				if indexErr := peopleService.ApplyRecords(records); indexErr != nil {
					log.Printf("更新人物索引失败: %v", indexErr)
				}
			}
			storageUsage.Invalidate()
			jobOutputs.Invalidate()
		},
		OnRecordsCleared: func() {
			storageUsage.Invalidate()
			jobOutputs.Invalidate()
		},
	})
	if err != nil {
		log.Fatalf("初始化媒体分析任务服务失败: %v", err)
	}
	if err := ocrSearchIndex.Sync(aiJobs.Records(services.AIJobTypeOCR)); err != nil {
		log.Printf("重建 OCR 搜索索引失败: %v", err)
	}
	if aiJobs.PeopleEnabled() {
		if err := peopleService.Sync(aiJobs.Records(services.AIJobTypeFace)); err != nil {
			log.Printf("重建人物索引失败: %v", err)
		}
	}
	aiJobs.StartPending()

	// 启动时若缓存为空（首次启动 / 缓存根目录不匹配被清空 / 磁盘无缓存），
	// 自动跑一次扫描，避免前端打开时看到 404 或空数据。
	// 用 goroutine 异步执行，不阻塞服务启动；扫描进度通过 /api/scans/:id/events
	// 暴露给前端。
	if scanCache.Get() == nil && len(currentRoots) > 0 {
		go func() {
			id, _, startErr := runner.StartOrReuse(handlers.ScanOptionsFromConfig(mgr))
			if startErr != nil {
				log.Printf("启动自动扫描失败: %v", startErr)
				return
			}
			log.Printf("  已自动启动扫描 id=%s，等待结果…", id)
		}()
	}

	// 仅缩略图参数热更新。cacheDir / ffmpegPath 涉及多个协作服务，配置接口
	// 会明确返回 requiresRestart，避免只切换部分实例造成缓存与元数据分裂。
	mgr.OnChange("thumbnail", func(snapshot *config.Config) {
		if err := thumbs.UpdateOptions(services.ThumbnailOptions{
			MaxAgeDays: snapshot.CacheMaxAgeDays,
			LRUSize:    snapshot.ThumbCacheSize,
			VideoCover: services.NewVideoCoverExtractor(services.VideoCoverOptions{
				FFmpegPath: cfg.FFmpegPath,
				Quality:    85, Timeout: 10 * time.Second,
			}),
			ImageConverter: services.NewImageConverter(services.ImageConverterOptions{
				FFmpegPath: cfg.FFmpegPath,
				Quality:    85, Timeout: 10 * time.Second,
			}),
		}); err != nil {
			log.Printf("警告：缩略图服务热更新失败: %v", err)
		}
	})

	onConfigUpdate := handlers.ConfigScanApply(mgr, runner, resourceCatalog, scanCache)

	accessGate := middleware.NewAccessGate(mgr.Get)
	api := app.Group("/api")
	api.Use(accessGate.Middleware())
	// 认证必须先于资源 ID / path 解析，避免未认证请求借错误差异探测目录。
	api.Use(safetyMw)
	api.Get("/auth/session", accessGate.SessionStatusHandler())
	api.Post("/auth/session", accessGate.SessionCreateHandler())
	api.Delete("/auth/session", accessGate.SessionDeleteHandler())
	api.Get("/health", handlers.HealthHandler(mgr, resourceCatalog))
	api.Post("/scans", handlers.AsyncScanStartHandler(runner, mgr))
	api.Get("/scans/:id/events", handlers.AsyncScanEventsHandler(runner))
	api.Delete("/scans/:id", handlers.AsyncScanCancelHandler(runner))
	api.Get("/library/overview", handlers.LibraryQueryHandler(resourceCatalog, prefs, activities))
	api.Get("/library/manifest", handlers.LibraryManifestHandler(resourceCatalog))
	// 照片流要排在 /library/:id/children 之前：那条是带参数的路由，
	// 静态段先注册才不会落到参数路由上。
	api.Get("/library/media-feed", handlers.LibraryMediaFeedHandler(resourceCatalog, mediaDimensions, picks))
	api.Get("/library/:id/children", handlers.LibraryChildrenPageHandler(resourceCatalog))
	api.Post("/library/nodes/query", handlers.LibraryNodesQueryHandler(resourceCatalog))
	api.Get("/library/recent", handlers.LibraryRecentHandler(resourceCatalog))
	api.Get("/library/on-this-day", handlers.LibraryOnThisDayHandler(resourceCatalog, mediaDimensions))
	api.Get("/library/activity-summary", handlers.LibraryActivitySummaryHandler(resourceCatalog, activities, unreadIndex))
	api.Get("/library/dashboard", handlers.LibraryHomeDashboardHandler(resourceCatalog, activities, unreadIndex))
	api.Get("/library/unread", handlers.LibraryUnreadAlbumsPageHandler(resourceCatalog, activities, unreadIndex))
	api.Delete("/library", handlers.ScanCacheClearHandler(scanCache, resourceCatalog, runner))
	api.Get("/locations", handlers.GPSLocationsHandler(resourceCatalog, aiJobs, safetyState.Validate, picks))
	api.Get("/locations/:id/media", handlers.GPSLocationsHandler(resourceCatalog, aiJobs, safetyState.Validate, picks))
	api.Get("/people", handlers.PeopleHandler(peopleService, aiJobs, resourceCatalog, safetyState.Validate))
	api.Delete("/people", handlers.PeopleHandler(peopleService, aiJobs, resourceCatalog, safetyState.Validate))
	api.Get("/people/:id/media", handlers.PersonMediaHandler(peopleService, aiJobs, resourceCatalog, safetyState.Validate))
	api.Put("/people/:id", handlers.PersonHandler(peopleService))
	api.Post("/people/merge", handlers.PeopleMergeHandler(peopleService))
	api.Post("/people/split", handlers.PeopleSplitHandler(peopleService))
	api.Get("/ai/jobs", handlers.AIJobsHandler(aiJobs))
	api.Post("/ai/jobs", handlers.AIJobStartHandler(aiJobs))
	api.Post("/ai/jobs/sequence", handlers.AIJobSequenceStartHandler(aiJobs))
	api.Get("/ai/semantic/status", handlers.AIEmbeddingStatusHandler(embeddingAnalyzer, aiJobs, resourceCatalog))
	api.Post("/ai/search", handlers.SemanticSearchHandler(embeddingAnalyzer, aiJobs, ocrSearchIndex, resourceCatalog, safetyState.Validate, cacheLayout.TempDir, prefs, picks, peopleService))
	api.Post("/ai/faces/search", handlers.FaceSimilaritySearchHandler(aiJobs, resourceCatalog, safetyState.Validate))
	api.Get("/ai/jobs/settings", handlers.AIJobSettingsHandler(aiJobs, peopleService))
	api.Put("/ai/jobs/settings", handlers.AIJobSettingsHandler(aiJobs, peopleService))
	// 核算要排在 /ai/jobs/:id 之前：那条是带参数的路由，静态段先注册
	// 才不会落到参数路由上。
	api.Get("/ai/jobs/estimate", handlers.AIJobEstimateHandler(aiJobs))
	api.Delete("/ai/jobs/queue", handlers.AIJobQueueHandler(aiJobs))
	api.Delete("/ai/jobs/history", handlers.AIJobHistoryHandler(aiJobs))
	api.Get("/ai/jobs/:id/events", handlers.AIJobEventsHandler(aiJobs))
	api.Get("/ai/jobs/:jobId/output", handlers.AIJobOutputHandler(aiJobs, jobOutputs))
	api.Get("/ai/jobs/:id", handlers.AIJobStatusHandler(aiJobs))
	api.Post("/ai/jobs/:id/move", handlers.AIJobQueueMoveHandler(aiJobs))
	api.Delete("/ai/jobs/:id", handlers.AIJobHistoryItemHandler(aiJobs))
	api.Post("/ai/jobs/:id/pause", handlers.AIJobActionHandler(aiJobs, "pause"))
	api.Post("/ai/jobs/:id/resume", handlers.AIJobActionHandler(aiJobs, "resume"))
	api.Post("/ai/jobs/:id/cancel", handlers.AIJobActionHandler(aiJobs, "cancel"))
	api.Post("/ai/jobs/:id/retry", handlers.AIJobActionHandler(aiJobs, "retry"))
	resourceParam := middleware.ResourceParam(resourceCatalog, safetyState)
	api.Get("/albums/random", handlers.LibraryRandomAlbumHandler(resourceCatalog, activities, unreadIndex))
	api.Get("/albums/:id/media", handlers.AlbumMediaPageHandler(resourceCatalog, mediaDimensions, picks))
	// 自定义封面：用户可在阅读器内手动设置/清除每本相册的封面。
	// file 必须是 path 子路径 + 真实存在的文件；越权请求会被 400 拒绝。
	api.Put("/albums/:id/cover", resourceParam, handlers.AlbumSetCoverHandler(scanCache, coverOverrides, resourceCatalog))
	api.Delete("/albums/:id/cover", resourceParam, handlers.AlbumClearCoverHandler(scanCache, coverOverrides, resourceCatalog))
	api.Get("/search", handlers.SearchHandler(resourceCatalog))
	api.Get("/tags", handlers.LibraryTagsPageHandler(resourceCatalog))
	api.Post("/tags/query", handlers.LibraryTagsQueryHandler(resourceCatalog))
	api.Get("/tags/:tag/albums", handlers.TagAlbumsPageHandler(resourceCatalog))
	api.Get("/thumbs/:id", resourceParam, handlers.ThumbHandler(thumbs))
	api.Post("/thumbs/cleanup", handlers.ThumbCleanupHandlerWithCacheStats(thumbs, cacheStats))
	// 统一清空入口:scope=thumbs|faststart|transcode|all。
	// Settings 页在"缓存占用"面板中按 scope 提供独立清理和一键全清。
	api.Post("/cache/clear", handlers.CacheClearHandler(thumbs, faststart, transcode, videoInfo.ClearCache, cacheStats))
	api.Get("/cache/stats", handlers.CacheStatsHandler(mgr, cacheStats))
	api.Post("/cache/rebuild", handlers.CacheRebuildStartHandler(cacheRebuild))
	api.Get("/cache/rebuild/:id", handlers.CacheRebuildStatusHandler(cacheRebuild))
	api.Delete("/cache/rebuild/:id", handlers.CacheRebuildCancelHandler(cacheRebuild))
	api.Get("/cache/rebuild/:id/events", handlers.CacheRebuildEventsHandler(cacheRebuild))
	api.Get("/media/:id", resourceParam, handlers.MediaHandler(transcode, faststart, thumbs))
	api.Get("/previews/:id", resourceParam, handlers.PreviewHandler(thumbs))
	api.Get("/images/:id/info", resourceParam, handlers.ImageInfoHandler(resourceCatalog))
	api.Get("/images/:id/metadata", resourceParam, handlers.ImageMetadataHandler(aiJobs))
	api.Get("/images/:id/analysis", resourceParam, handlers.ImageAnalysisHandler(aiJobs))
	// 视频流 + 元信息（前端 <video> 元素 / HoverPreview / 时长显示使用）
	api.Get("/videos/:id/info", resourceParam, handlers.VideoInfoHandler(videoInfo, transcode, resourceCatalog))
	api.Post("/videos/info/batch", handlers.VideoInfoBatchHandler(videoInfo, transcode, resourceCatalog, safetyState))
	// 转码进度（轮询；SSE）
	api.Get("/videos/:id/transcode/status", resourceParam, handlers.TranscodeStatusHandler(transcode))
	api.Get("/videos/:id/transcode/events", resourceParam, handlers.TranscodeEventsHandler(transcode))
	api.Post("/videos/:id/transcode/cancel", resourceParam, handlers.TranscodeCancelHandler(transcode))
	// 视频封面回填：前端浏览器抽帧后 POST 原始字节
	api.Post("/thumbs/:id/cover", resourceParam, handlers.ThumbCoverHandler(thumbs))
	api.Post("/fs/open", middleware.LoopbackOnly(), handlers.FsOpenResourceHandler(mgr, resourceCatalog, safetyState, middleware.OpenInOS))
	api.Get("/admin/fs/open", middleware.LoopbackOnly(), handlers.FsOpenHandler(mgr))
	api.Post("/admin/fs/directories", middleware.LoopbackOnly(), handlers.DirectoriesHandler())

	// 配置读写
	backupService := &services.StateBackupService{Prefs: prefs, Activities: activities, Covers: coverOverrides, Picks: picks, People: peopleService, Catalog: resourceCatalog, ScanCache: scanCache, ValidatePath: safetyState.Validate, BackupDir: services.StateBackupDirectory(cacheLayout)}
	api.Get("/admin/state/export", middleware.LoopbackOnly(), handlers.StateExportHandler(backupService))
	api.Post("/admin/state/import/preview", middleware.LoopbackOnly(), handlers.StatePreviewHandler(backupService))
	api.Post("/admin/state/import", middleware.LoopbackOnly(), handlers.StateImportHandler(backupService))
	api.Get("/storage/usage", handlers.StorageUsageHandler(storageUsage, handlers.StorageHandlerOptions{
		CacheRoot:       cacheLayout.Root,
		WorkerDirectory: filepath.Dir(workerOptions.ScriptPath),
	}))
	api.Get("/storage/paths", middleware.LoopbackOnly(), handlers.StoragePathsHandler(storageUsage, services.AIStoragePathOptions{
		ConfigPath:       mgr.Path(),
		WorkingDirectory: ".",
		CacheRoot:        cacheLayout.Root,
		WorkerDirectory:  filepath.Dir(workerOptions.ScriptPath),
		PythonPath:       workerOptions.PythonPath,
	}))
	api.Get("/config", middleware.LoopbackOnly(), handlers.ConfigGetHandler(mgr))
	api.Put("/config", middleware.LoopbackOnly(), handlers.ConfigUpdateHandler(mgr, onConfigUpdate))

	// 偏好 / 收藏 / 历史
	api.Get("/prefs", handlers.PrefsGetHandler(prefs))
	api.Patch("/prefs", handlers.PrefsPatchHandler(prefs))
	api.Post("/favorites/batch", handlers.FavoritesBatchHandler(prefs))
	api.Get("/favorites", handlers.FavoritesListHandler(prefs))
	api.Post("/favorites", handlers.FavoriteAddHandler(prefs))
	api.Delete("/favorites", handlers.FavoriteRemoveHandler(prefs))
	api.Post("/favorites/prune", handlers.FavoritesPruneHandler(prefs, resourceCatalog))
	api.Get("/history", handlers.HistoryListHandler(prefs))
	api.Post("/history", handlers.HistoryAddHandler(prefs))
	api.Delete("/history", handlers.HistoryClearHandler(prefs))

	// 照片级精选（与上面的相册级收藏是两份数据）
	api.Get("/picks", handlers.PicksListHandler(picks))
	api.Post("/picks/batch", handlers.PicksBatchHandler(picks))
	api.Get("/picks/media", handlers.PicksMediaPageHandler(resourceCatalog, picks, mediaDimensions))
	api.Get("/activity", handlers.ActivityGetHandler(activities))
	api.Put("/activity", handlers.ActivityPutHandler(activities))
	api.Delete("/activity", handlers.ActivityDeleteHandler(activities))
	api.Post("/activity/query", handlers.ActivityQueryHandler(activities))
	api.Delete("/activity/batch", handlers.ActivityBatchDeleteHandler(activities))
	api.Put("/activity/batch", handlers.ActivityBatchPutHandler(activities))
	api.Delete("/activity/all", handlers.ActivityClearHandler(activities))

	// ---- 静态资源托管（生产模式：同端口托管前端） ----
	if staticDir != "" {
		if info, err := os.Stat(staticDir); err == nil && info.IsDir() {
			registerStatic(app, staticDir)
			log.Printf("  StaticDir: <configured> (已托管前端 + SPA fallback)")
		} else {
			log.Printf("  StaticDir: <configured> 不存在或不是目录，跳过静态托管")
		}
	} else {
		log.Printf("  StaticDir: <未配置>，跳过静态托管")
	}

	// ---- 启动与优雅退出 ----
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	aiJobs.StartScheduler(ctx)
	maintenanceDone := make(chan struct{})
	go func() {
		defer close(maintenanceDone)
		services.RunCacheMaintenance(ctx, time.Hour, func(ctx context.Context) error {
			current := mgr.Get()
			deleted, err := services.MaintainDerivedCache(ctx, cacheLayout, current.CacheMaxSizeMB*1024*1024, current.CacheMaxAgeDays)
			if deleted > 0 {
				cacheStats.Invalidate()
			}
			if err != nil && ctx.Err() == nil {
				log.Print("派生缓存自动清理未完成，请检查工作目录权限")
			}
			return err
		})
	}()
	err = runServer(ctx, app, cfg.Addr(), runner, transcode, scanCache, aiJobs)
	stop()
	<-maintenanceDone
	if err != nil {
		log.Printf("服务退出异常: %v", err)
		os.Exit(1)
	}
}

// runServer 在接收退出信号后停止接收新连接，同时取消后台扫描/转码并
// 强制刷新扫描缓存。信号本身属于正常退出，不作为错误返回。
func runServer(
	ctx context.Context,
	app *fiber.App,
	addr string,
	runner *services.AsyncScanRunner,
	transcode *services.TranscodeService,
	scanCache *services.ScanResultCache,
	aiJobs *services.AIJobService,
) error {
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return errors.Join(fmt.Errorf("监听失败: %w", err), shutdownRuntime(cleanupCtx, runner, transcode, scanCache, aiJobs))
	}

	listenDone := make(chan error, 1)
	go func() {
		listenDone <- app.Listener(listener)
	}()

	select {
	case listenErr := <-listenDone:
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return errors.Join(listenErr, shutdownRuntime(cleanupCtx, runner, transcode, scanCache, aiJobs))
	case <-ctx.Done():
		log.Printf("收到退出信号，正在停止后台任务并刷新缓存…")
	}

	cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runtimeDone := make(chan error, 1)
	go func() {
		runtimeDone <- shutdownRuntime(cleanupCtx, runner, transcode, scanCache, aiJobs)
	}()

	httpErr := app.ShutdownWithTimeout(5 * time.Second)
	runtimeErr := <-runtimeDone
	listenErr := <-listenDone
	return errors.Join(httpErr, runtimeErr, listenErr)
}

func shutdownRuntime(
	ctx context.Context,
	runner *services.AsyncScanRunner,
	transcode *services.TranscodeService,
	scanCache *services.ScanResultCache,
	aiJobs *services.AIJobService,
) error {
	var scanErr, transcodeErr, cacheErr, aiJobsErr error
	if runner != nil {
		scanErr = runner.Shutdown(ctx)
	}
	if transcode != nil {
		transcodeErr = transcode.Shutdown(ctx)
	}
	if scanCache != nil {
		cacheErr = scanCache.Flush()
	}
	if aiJobs != nil {
		aiJobsErr = aiJobs.Shutdown(ctx)
	}
	return errors.Join(scanErr, transcodeErr, cacheErr, aiJobsErr)
}

// isCompressiblePath 判断静态资源是否值得压缩。
//
// 按扩展名判断而不是按 Content-Type：压缩中间件在响应产生之前就要
// 决定跳过与否，那时 Content-Type 还没定下来。
//
// 图片与字体本身已经是压缩格式，再压一遍几乎不省字节，只白费 CPU；
// 文本类（html/js/css/json/svg/map）压缩率很高。
func isCompressiblePath(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".html", ".htm", ".css", ".js", ".mjs", ".json", ".map",
		".svg", ".xml", ".txt", ".webmanifest":
		return true
	}
	return false
}

// registerStatic 挂上静态资源托管。
//
// 三件事：
//   - 压缩：文本类资源（html/js/css/json/svg）走 brotli/gzip。
//     这个中间件注册在 API 路由之后，因此不会碰 /api/ 下的媒体响应。
//   - 缓存：Vite 产物的文件名带内容哈希，改版即换名，可以长期缓存；
//     入口文件（index.html 与 SPA 回退）必须每次回源，否则发新版后
//     用户拿到的仍是旧的入口文件。
//   - SPA 回退：前端路由刷新后请求的路径在磁盘上不存在，回退到
//     index.html 交给前端路由处理。
func registerStatic(app *fiber.App, staticDir string) {
	indexPath, _ := filepath.Abs(filepath.Join(staticDir, "index.html"))

	app.Use(compress.New(compress.Config{
		Level: compress.LevelDefault,
		Next: func(c *fiber.Ctx) bool {
			return !isCompressiblePath(c.Path())
		},
	}))

	// SPA fallback：先注册通配兜底（只对 GET/HEAD，且非 /api/，且静态文件不存在）
	// 放到 Static 之前，避免 Static 内部对 404 也保留 200 状态码导致误判
	app.Use(func(c *fiber.Ctx) error {
		if c.Method() != fiber.MethodGet && c.Method() != fiber.MethodHead {
			return c.Next()
		}
		p := c.Path()
		if len(p) >= 5 && p[:5] == "/api/" {
			return c.Next()
		}
		if strings.HasPrefix(p, "/assets/") {
			c.Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			c.Set("Cache-Control", "no-cache")
		}
		// 已经是 index.html 或根路径：交给 Static
		rel := strings.TrimPrefix(p, "/")
		if rel == "" {
			return c.Next()
		}
		// 静态文件实际存在则交给 Static
		filePath := filepath.Join(staticDir, filepath.FromSlash(rel))
		if info, err := os.Stat(filePath); err == nil && !info.IsDir() {
			return c.Next()
		}
		// 否则回退到 SPA index.html
		c.Set("Content-Type", "text/html; charset=utf-8")
		return c.SendFile(indexPath)
	})
	app.Static("/", staticDir)
}
