// Package handlers 提供 Fiber 路由处理函数。
package handlers

import (
	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/config"
	"github.com/tianlongxiang/local-gallery/internal/pathutil"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

// ConfigResponse GET /api/config 的响应体。
//
// 配置接口是唯一允许返回本机绝对配置路径的回环接口。
type ConfigResponse struct {
	CacheMaxSizeMB        int64    `json:"cacheMaxSizeMB"`
	MediaRoots            []string `json:"mediaRoots"`
	Host                  string   `json:"host"`
	Port                  int      `json:"port"`
	AccessMode            string   `json:"accessMode"`
	AccessTokenConfigured bool     `json:"accessTokenConfigured"`
	CacheDir              string   `json:"cacheDir"`
	ThumbSizeW            int      `json:"thumbSizeW"`
	ThumbSizeH            int      `json:"thumbSizeH"`
	ThumbCacheSize        int      `json:"thumbCacheSize"`
	CacheMaxAgeDays       int      `json:"cacheMaxAgeDays"`
	AllowOsOpen           bool     `json:"allowOsOpen"`
	StaticDir             string   `json:"staticDir"`
	FFmpegPath            string   `json:"ffmpegPath"`
	FFmpegAvailable       bool     `json:"ffmpegAvailable"`
	ConfigPath            string   `json:"configPath"`

	// 排除规则:对外暴露完整三件套(SkipHidden + SystemFiles + ExcludePatterns),
	// 让前端能完整还原当前配置;而不是只暴露 ExcludePatterns 一项。
	SkipHidden      bool     `json:"skipHidden"`
	SystemFiles     []string `json:"systemFiles"`
	ExcludePatterns []string `json:"excludePatterns"`
}

// ConfigUpdateResponse PUT /api/config 的响应体。
type ConfigUpdateResponse struct {
	OK                bool           `json:"ok"`
	Config            ConfigResponse `json:"config"`
	RequiresRestart   []string       `json:"requiresRestart,omitempty"`
	MediaRootsChanged bool           `json:"mediaRootsChanged"` // 根集合是否变化（顺序无关）
}

// ConfigGetHandler 返回 /api/config GET 处理函数。
func ConfigGetHandler(mgr *config.Manager) fiber.Handler {
	return func(c *fiber.Ctx) error {
		cfg := mgr.Get()
		roots := cfg.Roots()
		// ffmpegAvailable 在 handler 层做一次探测,避免前端再发请求。
		// 注意:这里的探测是每次 GET 都跑的(成本 < 50ms),但 Config 页
		// 打开频次极低,影响可忽略。如果将来要 hot path 也用,可以加 30s TTL。
		ffPath := cfg.FFmpegPath
		ffAvailable := false
		if ffPath != "" {
			ffAvailable = services.FFmpegAvailableAt(ffPath)
		}
		return c.JSON(ConfigResponse{
			MediaRoots:            roots,
			Host:                  cfg.Host,
			Port:                  cfg.Port,
			AccessMode:            cfg.AccessMode,
			AccessTokenConfigured: cfg.AccessToken != "",
			CacheDir:              cfg.CacheDir,
			ThumbSizeW:            cfg.ThumbSizeW,
			ThumbSizeH:            cfg.ThumbSizeH,
			ThumbCacheSize:        cfg.ThumbCacheSize,
			CacheMaxAgeDays:       cfg.CacheMaxAgeDays,
			CacheMaxSizeMB:        cfg.CacheMaxSizeMB,
			AllowOsOpen:           cfg.AllowOsOpen,
			StaticDir:             cfg.StaticDir,
			FFmpegPath:            ffPath,
			FFmpegAvailable:       ffAvailable,
			ConfigPath:            mgr.Path(),
			SkipHidden:            cfg.SkipHidden,
			SystemFiles:           cfg.SystemFiles,
			ExcludePatterns:       cfg.ExcludePatterns,
		})
	}
}

// ConfigUpdateHandler 返回 /api/config PUT 处理函数。
//
// 行为：
//  1. 解析 PATCH
//  2. 委托给 Manager.Update（合并 → 校验 → 写盘 → 通知订阅者）
//  3. 报告 requiresRestart / mediaRootsChanged
func ConfigUpdateHandler(mgr *config.Manager, onUpdate func(c *config.Config, mediaRootsChanged bool) error) fiber.Handler {
	return func(c *fiber.Ctx) error {
		var patch config.ConfigPatch
		if err := c.BodyParser(&patch); err != nil {
			return writeError(c, fiber.StatusBadRequest, "invalid_config_body", "invalid JSON body")
		}

		prevRoots := mgr.Roots()
		requiresRestart, err := mgr.Update(patch)
		if err != nil {
			return writeError(c, fiber.StatusBadRequest, "invalid_config", "configuration is invalid")
		}
		newCfg := mgr.Get()
		newRoots := newCfg.Roots()
		mediaRootsChanged := !pathutil.EqualRoots(prevRoots, newRoots)

		if onUpdate != nil {
			if err := onUpdate(newCfg, mediaRootsChanged); err != nil {
				// 通知失败：内存已是新值但下游没跟上；返回 500 提示用户回滚或重启
				return writeError(c, fiber.StatusInternalServerError, "config_apply_failed", "config saved, but applying to running services failed", fiber.Map{"applied": true})
			}
		}

		return c.JSON(ConfigUpdateResponse{
			OK: true,
			Config: ConfigResponse{
				MediaRoots:            newRoots,
				Host:                  newCfg.Host,
				Port:                  newCfg.Port,
				AccessMode:            newCfg.AccessMode,
				AccessTokenConfigured: newCfg.AccessToken != "",
				CacheDir:              newCfg.CacheDir,
				ThumbSizeW:            newCfg.ThumbSizeW,
				ThumbSizeH:            newCfg.ThumbSizeH,
				ThumbCacheSize:        newCfg.ThumbCacheSize,
				CacheMaxAgeDays:       newCfg.CacheMaxAgeDays,
				CacheMaxSizeMB:        newCfg.CacheMaxSizeMB,
				AllowOsOpen:           newCfg.AllowOsOpen,
				StaticDir:             newCfg.StaticDir,
				FFmpegPath:            newCfg.FFmpegPath,
				FFmpegAvailable:       newCfg.FFmpegPath != "" && services.FFmpegAvailableAt(newCfg.FFmpegPath),
				ConfigPath:            mgr.Path(),
				SkipHidden:            newCfg.SkipHidden,
				SystemFiles:           newCfg.SystemFiles,
				ExcludePatterns:       newCfg.ExcludePatterns,
			},
			RequiresRestart:   requiresRestart,
			MediaRootsChanged: mediaRootsChanged,
		})
	}
}
