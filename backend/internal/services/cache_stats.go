package services

import (
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// CacheUsage 缓存目录的占用快照。
type CacheUsage struct {
	Path       string    `json:"path"`
	TotalBytes int64     `json:"totalBytes"`
	FileCount  int       `json:"fileCount"`
	ScannedAt  time.Time `json:"scannedAt"`
	DurationMs int64     `json:"durationMs"`
	// 目录存在但还没被扫描/磁盘读取出错时给 false
	Available bool `json:"available"`

	// 按子目录细分的占用。所有可清理资源都位于 cacheDir/derived 下，
	// cacheDir/state 中的扫描结果、偏好和封面设置不计入缓存占用。
	//
	// Settings 页面用这些数据告诉用户「大头在哪」,让用户知道
	// 转码缓存过大时可以批量清理。totalBytes = 各子目录之和
	// totalBytes 只统计 derived 子树。
	//
	// Converted 是 HEIC/HEIF/TIFF 的整图转换产物(浏览器解不了的格式),
	// 单张可达 MB 级,必须单独列出来——否则细分之和与 totalBytes 对不上,
	// 用户既看不到大头在哪,也没法只清这一类。
	//
	// Previews 是阅读器按宽度缩放出来的预览图,单张几百 KB。
	// 它和缩略图放在一起会让「缩略图」这一栏随翻页剧烈波动,
	// 单独列出用户才能知道是哪一类占了空间。
	Thumbs         SubUsage `json:"thumbs"`
	Converted      SubUsage `json:"converted"`
	Previews       SubUsage `json:"previews"`
	VideoFaststart SubUsage `json:"videoFaststart"`
	VideoTranscode SubUsage `json:"videoTranscode"`
}

// SubUsage 子目录占用(单一子树)。
type SubUsage struct {
	Path      string `json:"path"` // 子目录绝对路径,UI 可用「在资源管理器中打开」
	Bytes     int64  `json:"bytes"`
	FileCount int    `json:"fileCount"`
	// 子目录不存在时为 false(用户可能还没产生过该类缓存)
	Available bool `json:"available"`
}

// CacheStatsService 缓存目录统计服务,带 30s 内存 TTL 避免频繁刷新卡 UI。
type CacheStatsService struct {
	mu     sync.Mutex
	cache  *CacheUsage
	expiry time.Time
	ttl    time.Duration
}

// NewCacheStatsService 构造;ttl 通常 30s。
func NewCacheStatsService(ttl time.Duration) *CacheStatsService {
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	return &CacheStatsService{ttl: ttl}
}

// Usage 返回 cacheDir 当前占用快照。
//
//   - 目录不存在:返回 Available=false 的空快照,不报错(用户可能没建好)
//   - TTL 内的重复调用:直接返回缓存
//   - 扫描出错(权限等):返回部分结果 + 错误(调用方按需处理)
func (s *CacheStatsService) Usage(cacheDir string) (*CacheUsage, *time.Time, error) {
	if cacheDir == "" {
		return &CacheUsage{Available: false}, nil, nil
	}

	// 先检查 TTL 命中
	s.mu.Lock()
	if s.cache != nil && s.cache.Path == cacheDir && time.Now().Before(s.expiry) {
		cp := *s.cache
		exp := s.expiry
		s.mu.Unlock()
		return &cp, &exp, nil
	}
	s.mu.Unlock()

	start := time.Now()
	layout := ResolveCacheLayout(cacheDir)
	// 先用 Stat 探测顶层:WalkDir 自身对根目录不存在的错误包装不稳定,
	// 显式 stat 一次更可靠。
	info, statErr := os.Stat(cacheDir)
	if statErr != nil {
		// 顶层目录不存在/无权限:返回空快照不算错
		usage := &CacheUsage{
			Path:      cacheDir,
			Available: false,
			ScannedAt: time.Now(),
		}
		// 仍然写入缓存(无错误,只是空),让 TTL 命中避免每次请求 stat
		s.mu.Lock()
		s.cache = usage
		s.expiry = time.Now().Add(s.ttl)
		s.mu.Unlock()
		exp := s.expiry
		return usage, &exp, nil
	}
	if !info.IsDir() {
		// 路径是文件不是目录:同样返回空
		usage := &CacheUsage{
			Path:      cacheDir,
			Available: false,
			ScannedAt: time.Now(),
		}
		s.mu.Lock()
		s.cache = usage
		s.expiry = time.Now().Add(s.ttl)
		s.mu.Unlock()
		exp := s.expiry
		return usage, &exp, nil
	}

	var (
		total   int64
		count   int
		walkErr error
	)
	// filepath.WalkDir 单次遍历;err 走 visit 的 err 参数(单文件读不到 stat 时
	// 跳过,不让整个遍历失败)
	walkErr = filepath.WalkDir(layout.DerivedDir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			// 跳过单个错误,继续扫描
			return nil
		}
		if d.IsDir() {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return nil
		}
		total += fi.Size()
		count++
		return nil
	})

	usage := &CacheUsage{
		Path:           cacheDir,
		TotalBytes:     total,
		FileCount:      count,
		ScannedAt:      time.Now(),
		DurationMs:     time.Since(start).Milliseconds(),
		Available:      walkErr == nil,
		Thumbs:         scanCacheDir(layout.ThumbnailDir),
		Converted:      scanCacheDir(layout.ConvertedDir),
		Previews:       scanCacheDir(layout.PreviewDir),
		VideoFaststart: scanSubDir(filepath.Join(layout.DerivedDir, "video-faststart")),
		VideoTranscode: scanSubDir(filepath.Join(layout.DerivedDir, "video-transcode")),
	}

	// 缓存(只有没错误的快照才缓存,避免权限错误被锁住)
	var expiry *time.Time
	if walkErr == nil {
		s.mu.Lock()
		s.cache = usage
		s.expiry = time.Now().Add(s.ttl)
		exp := s.expiry
		s.mu.Unlock()
		expiry = &exp
	}
	return usage, expiry, walkErr
}

// Invalidate 强制下一次 Usage 调用重算(用于清理缓存后立即刷新展示)。
func (s *CacheStatsService) Invalidate() {
	s.mu.Lock()
	s.cache = nil
	s.expiry = time.Time{}
	s.mu.Unlock()
}

// scanSubDir 扫描单个子目录,返回 SubUsage。
//
// 与主扫描共用相同的「跳过单文件错误,继续遍历」策略 —
// 一个权限错误不应该让整个 cache stats 报失败。
// 子目录不存在是正常情况(用户还没产生过该类缓存),返回 Available=false
// 即可,不算 error。
func scanSubDir(path string) SubUsage {
	su := SubUsage{Path: path, Available: false}
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return su
	}
	su.Available = true
	_ = filepath.WalkDir(path, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return nil
		}
		su.Bytes += fi.Size()
		su.FileCount++
		return nil
	})
	return su
}

// scanCacheDir 只统计 ThumbnailService 能识别并清理的缓存文件。
// 即使目录里被误放了其他文件，统计和清理也不会把它们当成派生缩略图。
//
// 缩略图目录与整图转换目录都用它：两者的产物都是 <md5>.jpg，
// 走同一套命名与清理规则。
func scanCacheDir(path string) SubUsage {
	su := SubUsage{Path: path, Available: false}
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return su
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return su
	}
	su.Available = true
	for _, entry := range entries {
		if entry.IsDir() || !isThumbnailCacheFile(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		su.Bytes += info.Size()
		su.FileCount++
	}
	return su
}
