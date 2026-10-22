// Command server 本地画廊后端入口。
//
// 启动流程：
//  1. 解析 flag：仅 --config（指定 YAML 路径）
//  2. 通过 config.Manager 加载 config.yaml（缺失则用内置默认；显式字段覆盖默认）
//  3. 校验 MediaRoots 必须存在且均为目录
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

	"github.com/tianlongxiang/local-gallery/internal/config"
	"github.com/tianlongxiang/local-gallery/internal/handlers"
	"github.com/tianlongxiang/local-gallery/internal/httputil"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
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
	log.Printf("  Thumbnail: %dx%d", cfg.ThumbSizeW, cfg.ThumbSizeH)
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
		// BodyLimit 提到 6 MiB：默认 4 MiB 不够 /api/thumbs/cover 上传
		// 4K canvas JPEG 封面（典型 2-4 MB）。
		BodyLimit: 6 * 1024 * 1024,
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
		Width:      cfg.ThumbSizeW,
		Height:     cfg.ThumbSizeH,
		Quality:    85,
		Timeout:    10 * time.Second,
	})
	if videoCover.Available() {
		log.Printf("  FFmpeg:    <可用> (服务端视频封面已启用)")
	} else {
		log.Printf("  FFmpeg:    <不可用 / 未配置> → 视频封面回退到客户端浏览器抽帧")
	}

	// ffprobe 元数据服务(可选)
	videoInfo := services.NewVideoInfoService(services.VideoInfoOptions{
		FFmpegPath: cfg.FFmpegPath,
		Timeout:    5 * time.Second,
	})
	if videoInfo.Available() {
		log.Printf("  FFprobe:   <可用> (视频元数据已启用)")
	}

	cacheLayout, err := services.EnsureCacheLayout(cfg.CacheDir)
	if err != nil {
		log.Fatalf("初始化缓存目录失败: %v", err)
	}

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
		CacheDir:   cacheLayout.ThumbnailDir,
		Width:      cfg.ThumbSizeW,
		Height:     cfg.ThumbSizeH,
		MaxAgeDays: cfg.CacheMaxAgeDays,
		LRUSize:    cfg.ThumbCacheSize,
		VideoCover: videoCover,
	})
	if err != nil {
		log.Fatalf("初始化缩略图服务失败: %v", err)
	}
	cacheStats := services.NewCacheStatsService(30 * time.Second)
	runner := services.NewAsyncScanRunner()
	unreadIndex := services.NewUnreadLibraryIndex()
	prefs := store.NewPrefsStore(cacheLayout.PreferencesPath)
	activities := store.NewActivityStore(cacheLayout.ActivityPath)
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
		log.Printf("  缓存的根目录与当前 mediaRoots 不一致，已清空旧缓存")
	}

	// 启动时若缓存为空（首次启动 / 缓存根目录不匹配被清空 / 磁盘无缓存），
	// 自动跑一次扫描，避免前端打开时看到 404 或空数据。
	// 用 goroutine 异步执行，不阻塞服务启动；扫描进度通过 /api/scans/:id/events
	// 暴露给前端。
	if scanCache.Get() == nil && len(currentRoots) > 0 {
		go func() {
			id, _, startErr := runner.Start(handlers.ScanOptionsFromConfig(mgr))
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
			Width:      snapshot.ThumbSizeW,
			Height:     snapshot.ThumbSizeH,
			MaxAgeDays: snapshot.CacheMaxAgeDays,
			LRUSize:    snapshot.ThumbCacheSize,
			VideoCover: services.NewVideoCoverExtractor(services.VideoCoverOptions{
				FFmpegPath: cfg.FFmpegPath,
				Width:      snapshot.ThumbSizeW, Height: snapshot.ThumbSizeH,
				Quality: 85, Timeout: 10 * time.Second,
			}),
		}); err != nil {
			log.Printf("警告：缩略图服务热更新失败: %v", err)
		}
	})

	// 当 MediaRoots 变更：清空扫描缓存，扫描器/handler 已通过 mgr.Roots() 读最新值
	onConfigUpdate := func(newCfg *config.Config, mediaRootsChanged bool) error {
		if mediaRootsChanged {
			runner.Invalidate()
			if err := resourceCatalog.ClearWithCache(scanCache); err != nil {
				return fmt.Errorf("clear scan cache: %w", err)
			}
			roots := newCfg.Roots()
			if len(roots) == 1 {
				log.Printf("  MediaRoot 变更为 %s，已清空扫描缓存", filepath.Base(roots[0]))
			} else {
				log.Printf("  MediaRoots 变更为 %d 个目录，已清空扫描缓存", len(roots))
			}
		}
		return nil
	}

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
	api.Get("/library/manifest", handlers.LibraryManifestHandler(resourceCatalog))
	api.Get("/library/:id/children", handlers.LibraryChildrenPageHandler(resourceCatalog))
	api.Post("/library/nodes/query", handlers.LibraryNodesQueryHandler(resourceCatalog))
	api.Get("/library/activity-summary", handlers.LibraryActivitySummaryHandler(resourceCatalog, activities, unreadIndex))
	api.Get("/library/dashboard", handlers.LibraryHomeDashboardHandler(resourceCatalog, activities, unreadIndex))
	api.Get("/library/unread", handlers.LibraryUnreadAlbumsPageHandler(resourceCatalog, activities, unreadIndex))
	api.Delete("/library", handlers.ScanCacheClearHandler(scanCache, resourceCatalog, runner))
	resourceParam := middleware.ResourceParam(resourceCatalog, safetyState)
	api.Get("/albums/random", handlers.LibraryRandomAlbumHandler(resourceCatalog, activities, unreadIndex))
	api.Get("/albums/:id/media", handlers.AlbumMediaPageHandler(resourceCatalog))
	// 自定义封面：用户可在阅读器内手动设置/清除每本相册的封面。
	// file 必须是 path 子路径 + 真实存在的文件；越权请求会被 400 拒绝。
	api.Put("/albums/:id/cover", resourceParam, handlers.AlbumSetCoverHandler(scanCache, coverOverrides, resourceCatalog))
	api.Delete("/albums/:id/cover", resourceParam, handlers.AlbumClearCoverHandler(scanCache, coverOverrides, resourceCatalog))
	api.Get("/search", handlers.SearchHandler(resourceCatalog))
	api.Get("/tags", handlers.LibraryTagsPageHandler(resourceCatalog))
	api.Get("/tags/:tag/albums", handlers.TagAlbumsPageHandler(resourceCatalog))
	api.Get("/thumbs/:id", resourceParam, handlers.ThumbHandler(thumbs))
	api.Post("/thumbs/cleanup", handlers.ThumbCleanupHandlerWithCacheStats(thumbs, cacheStats))
	// 统一清空入口:scope=thumbs|faststart|transcode|all。
	// Settings 页在"缓存占用"面板中按 scope 提供独立清理和一键全清。
	api.Post("/cache/clear", handlers.CacheClearHandler(thumbs, faststart, transcode, cacheStats))
	api.Get("/cache/stats", handlers.CacheStatsHandler(mgr, cacheStats))
	api.Get("/media/:id", resourceParam, handlers.MediaHandler(transcode, faststart))
	api.Get("/images/:id/info", resourceParam, handlers.ImageInfoHandler(resourceCatalog))
	// 视频流 + 元信息（前端 <video> 元素 / HoverPreview / 时长显示使用）
	api.Get("/videos/:id/info", resourceParam, handlers.VideoInfoHandler(videoInfo, transcode, resourceCatalog))
	api.Post("/videos/info/batch", handlers.VideoInfoBatchHandler(videoInfo, transcode, resourceCatalog))
	// 转码进度（轮询；SSE）
	api.Get("/videos/:id/transcode/status", resourceParam, handlers.TranscodeStatusHandler(transcode))
	api.Get("/videos/:id/transcode/events", resourceParam, handlers.TranscodeEventsHandler(transcode))
	api.Post("/videos/:id/transcode/cancel", resourceParam, handlers.TranscodeCancelHandler(transcode))
	// 视频封面回填：前端浏览器抽帧后 POST 原始字节
	api.Post("/thumbs/:id/cover", resourceParam, handlers.ThumbCoverHandler(thumbs))
	api.Post("/fs/open", middleware.LoopbackOnly(), handlers.FsOpenResourceHandler(mgr, resourceCatalog))
	api.Get("/admin/fs/open", middleware.LoopbackOnly(), handlers.FsOpenHandler(mgr))

	// 配置读写
	api.Get("/config", middleware.LoopbackOnly(), handlers.ConfigGetHandler(mgr))
	api.Put("/config", middleware.LoopbackOnly(), handlers.ConfigUpdateHandler(mgr, onConfigUpdate))

	// 偏好 / 收藏 / 历史
	api.Get("/prefs", handlers.PrefsGetHandler(prefs))
	api.Patch("/prefs", handlers.PrefsPatchHandler(prefs))
	api.Get("/favorites", handlers.FavoritesListHandler(prefs))
	api.Post("/favorites", handlers.FavoriteAddHandler(prefs))
	api.Delete("/favorites", handlers.FavoriteRemoveHandler(prefs))
	api.Post("/favorites/prune", handlers.FavoritesPruneHandler(prefs, resourceCatalog))
	api.Get("/history", handlers.HistoryListHandler(prefs))
	api.Post("/history", handlers.HistoryAddHandler(prefs))
	api.Delete("/history", handlers.HistoryClearHandler(prefs))
	api.Get("/activity", handlers.ActivityGetHandler(activities))
	api.Put("/activity", handlers.ActivityPutHandler(activities))
	api.Delete("/activity", handlers.ActivityDeleteHandler(activities))
	api.Post("/activity/query", handlers.ActivityQueryHandler(activities))
	api.Put("/activity/batch", handlers.ActivityBatchPutHandler(activities))
	api.Delete("/activity/all", handlers.ActivityClearHandler(activities))

	// ---- 静态资源托管（生产模式：同端口托管前端） ----
	if staticDir != "" {
		if info, err := os.Stat(staticDir); err == nil && info.IsDir() {
			indexPath, _ := filepath.Abs(filepath.Join(staticDir, "index.html"))
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
	if err := runServer(ctx, app, cfg.Addr(), runner, transcode, scanCache); err != nil {
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
) error {
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return errors.Join(fmt.Errorf("监听失败: %w", err), shutdownRuntime(cleanupCtx, runner, transcode, scanCache))
	}

	listenDone := make(chan error, 1)
	go func() {
		listenDone <- app.Listener(listener)
	}()

	select {
	case listenErr := <-listenDone:
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return errors.Join(listenErr, shutdownRuntime(cleanupCtx, runner, transcode, scanCache))
	case <-ctx.Done():
		log.Printf("收到退出信号，正在停止后台任务并刷新缓存…")
	}

	cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runtimeDone := make(chan error, 1)
	go func() {
		runtimeDone <- shutdownRuntime(cleanupCtx, runner, transcode, scanCache)
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
) error {
	var scanErr, transcodeErr, cacheErr error
	if runner != nil {
		scanErr = runner.Shutdown(ctx)
	}
	if transcode != nil {
		transcodeErr = transcode.Shutdown(ctx)
	}
	if scanCache != nil {
		cacheErr = scanCache.Flush()
	}
	return errors.Join(scanErr, transcodeErr, cacheErr)
}
