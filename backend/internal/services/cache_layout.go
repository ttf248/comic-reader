package services

import (
	"fmt"
	"os"
	"path/filepath"
)

const (
	cacheStateDirName   = "state"
	cacheDerivedDirName = "derived"
	cacheTempDirName    = "temp"
	thumbnailDirName    = "thumbnails"
	convertedDirName    = "converted"
	previewDirName      = "previews"
)

// CacheLayout 把不可随意删除的应用状态与可重建的派生资源隔离开。
// CacheRoot 仍来自 config.yaml 的 cacheDir，保持单一配置入口。
type CacheLayout struct {
	Root               string
	StateDir           string
	DerivedDir         string
	TempDir            string
	ThumbnailDir       string
	ConvertedDir       string
	PreviewDir         string
	ScanCachePath      string
	PreferencesPath    string
	ActivityPath       string
	CoverOverridesPath string
}

// ResolveCacheLayout 只计算路径，不访问文件系统。
func ResolveCacheLayout(root string) CacheLayout {
	cleanRoot := filepath.Clean(root)
	stateDir := filepath.Join(cleanRoot, cacheStateDirName)
	derivedDir := filepath.Join(cleanRoot, cacheDerivedDirName)
	return CacheLayout{
		Root:               cleanRoot,
		StateDir:           stateDir,
		DerivedDir:         derivedDir,
		TempDir:            filepath.Join(cleanRoot, cacheTempDirName),
		ThumbnailDir:       filepath.Join(derivedDir, thumbnailDirName),
		ConvertedDir:       filepath.Join(derivedDir, convertedDirName),
		PreviewDir:         filepath.Join(derivedDir, previewDirName),
		ScanCachePath:      filepath.Join(stateDir, "scan_cache.json"),
		PreferencesPath:    filepath.Join(stateDir, "web_settings.json"),
		ActivityPath:       filepath.Join(stateDir, "activity.json"),
		CoverOverridesPath: filepath.Join(stateDir, "cover_overrides.json"),
	}
}

// EnsureCacheLayout 只创建当前分层缓存目录。
//
// 开发版不会读取、迁移或删除旧版 cacheDir 顶层文件；它们保留在原处，
// 当前状态仅从 state / derived / temp 布局读取。
func EnsureCacheLayout(root string) (CacheLayout, error) {
	if root == "" {
		return CacheLayout{}, fmt.Errorf("cache root is required")
	}
	layout := ResolveCacheLayout(root)
	for _, dir := range []string{layout.Root, layout.StateDir, layout.DerivedDir, layout.TempDir, layout.ThumbnailDir, layout.ConvertedDir, layout.PreviewDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return CacheLayout{}, fmt.Errorf("create cache layout: %w", err)
		}
	}

	return layout, nil
}
