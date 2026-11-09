package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// MaintainDerivedCache 仅清理三个派生目录内的完整哈希命名文件。
// Root 限制删除范围；临时文件、链接、状态文件和十分钟内的新产物不参与淘汰。
// 容量是软上限：新产物或正在被系统占用的文件可暂时超过预算。
func MaintainDerivedCache(ctx context.Context, layout CacheLayout, maxBytes int64, maxAgeDays int) (int, error) {
	root, err := os.OpenRoot(layout.DerivedDir)
	if err != nil {
		return 0, err
	}
	defer root.Close()
	type entry struct {
		name     string
		size     int64
		modified time.Time
		// temp 标记临时产物：它们不受保留天数与容量上限约束。
		temp bool
	}
	var entries []entry
	var total int64
	for _, scope := range []string{"thumbnails", "converted", "previews", "video-faststart", "video-transcode"} {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		dir, err := root.Open(scope)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return 0, err
		}
		files, err := dir.ReadDir(-1)
		dir.Close()
		if err != nil {
			return 0, err
		}
		for _, file := range files {
			if !file.Type().IsRegular() {
				continue
			}
			name := file.Name()
			// 临时产物（.tmp）永远没有保留价值：任务要么完成（已改名成正式
			// 缓存），要么失败（就地作废）。它们不匹配任何缓存键，只能靠
			// 这一条规则清掉。
			isTemp := isCacheTempFile(name)
			if !isTemp {
				ext := ".mp4"
				if scope == "thumbnails" || scope == "converted" || scope == "previews" {
					ext = ".jpg"
				}
				if !strings.HasSuffix(name, ext) || !isThumbnailCacheFile(strings.TrimSuffix(name, ext)+".jpg") {
					continue
				}
			}
			info, err := file.Info()
			if err != nil {
				continue
			}
			entries = append(entries, entry{filepath.Join(scope, name), info.Size(), info.ModTime(), isTemp})
			total += info.Size()
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].modified.Before(entries[j].modified) })
	now := time.Now()
	deleted := 0
	for _, item := range entries {
		if err := ctx.Err(); err != nil {
			return deleted, err
		}
		if now.Sub(item.modified) < 10*time.Minute {
			continue
		}
		if item.temp {
			// 临时产物不受保留天数与容量上限约束：十分钟后一律清掉。
			if err := root.Remove(item.name); err == nil {
				deleted++
				total -= item.size
			}
			continue
		}
		old := maxAgeDays > 0 && item.modified.Before(now.AddDate(0, 0, -maxAgeDays))
		if !old && (maxBytes <= 0 || total <= maxBytes) {
			continue
		}
		current, err := root.Lstat(item.name)
		if err != nil || !current.Mode().IsRegular() || current.Size() != item.size || !current.ModTime().Equal(item.modified) {
			continue
		}
		if err := root.Remove(item.name); err == nil {
			deleted++
			total -= item.size
		}
	}
	return deleted, nil
}

// RunCacheMaintenance 启动时执行一次，此后按固定周期运行；退出时取消并等待调用返回。
func RunCacheMaintenance(ctx context.Context, interval time.Duration, clean func(context.Context) error) {
	if interval <= 0 {
		interval = time.Hour
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		if err := clean(ctx); errors.Is(err, context.Canceled) {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
