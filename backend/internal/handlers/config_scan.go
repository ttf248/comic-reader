package handlers

import (
	"github.com/tianlongxiang/local-gallery/internal/config"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

// ConfigScanResult 区分配置已保存与后台扫描是否启动。
type ConfigScanResult struct {
	ScanID         string
	ScanStartError string
}

// ConfigScanApply 由配置 handler 串行调用；扫描由 runner 持有而非 HTTP 请求持有。
func ConfigScanApply(mgr *config.Manager, runner *services.AsyncScanRunner, catalog *services.ResourceCatalog, cache *services.ScanResultCache) func(*config.Config, bool) (ConfigScanResult, error) {
	return func(cfg *config.Config, changed bool) (ConfigScanResult, error) {
		if !changed {
			return ConfigScanResult{}, nil
		}
		runner.Invalidate()
		if err := catalog.ClearWithCache(cache); err != nil {
			return ConfigScanResult{}, err
		}
		if len(cfg.Roots()) == 0 {
			return ConfigScanResult{}, nil
		}
		id, _, err := runner.StartOrReuse(ScanOptionsFromConfig(mgr))
		if err != nil {
			return ConfigScanResult{ScanStartError: "scan_start_failed"}, nil
		}
		return ConfigScanResult{ScanID: id}, nil
	}
}
