// Package services 提供本地画廊核心业务服务。
package services

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"os"
	"path/filepath"
	"sync"

	lru "github.com/hashicorp/golang-lru/v2"
)

// MediaDimensions 是一份媒体文件的原始像素尺寸。
//
// Size 与 MTime 用于判断文件是否被替换过：尺寸缓存必须跟着文件走，
// 否则用户替换了同名图片后布局会一直沿用旧比例。
type MediaDimensions struct {
	Width  int   `json:"width"`
	Height int   `json:"height"`
	Size   int64 `json:"size"`
	MTime  int64 `json:"mtime"` // Unix 毫秒
}

// Known 表示这份尺寸是真实探测出来的，而不是「猜的」。
func (d MediaDimensions) Known() bool {
	return d.Width > 0 && d.Height > 0
}

// Ratio 是宽高比（宽 / 高）。未知尺寸返回 0。
func (d MediaDimensions) Ratio() float64 {
	if !d.Known() {
		return 0
	}
	return float64(d.Width) / float64(d.Height)
}

// MediaDimensionService 缓存媒体的原始像素尺寸。
//
// 照片墙要按图片真实宽高比排布，必须先知道每张图是横是竖。只读图片头部
// （image.DecodeConfig）就够算尺寸，不必解码整张图，因此代价很低；
// 结果缓存在内存 LRU 与磁盘派生缓存里，第二次打开同一本相册零成本。
//
// 磁盘缓存落在 derived/ 下：它完全可由源文件重建，属于派生数据而不是用户状态。
type MediaDimensionService struct {
	mu    sync.Mutex
	cache *lru.Cache[string, MediaDimensions]
	path  string
}

// NewMediaDimensionService 创建尺寸缓存服务并载入已有派生缓存。
// path 指向磁盘缓存文件；目录不存在时会被创建。
func NewMediaDimensionService(path string) (*MediaDimensionService, error) {
	cache, err := lru.New[string, MediaDimensions](8192)
	if err != nil {
		return nil, fmt.Errorf("create media dimension cache: %w", err)
	}
	s := &MediaDimensionService{cache: cache, path: path}
	s.load()
	return s, nil
}

// dimensionRecord 是磁盘缓存的一行。
type dimensionRecord struct {
	Path   string `json:"path"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Size   int64  `json:"size"`
	MTime  int64  `json:"mtime"`
}

// load 读取磁盘缓存。文件不存在或损坏时静默忽略：缓存丢了只是重新探测一次。
func (s *MediaDimensionService) load() {
	file, err := os.Open(s.path)
	if err != nil {
		return
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var record dimensionRecord
		if err := json.Unmarshal(line, &record); err != nil {
			continue
		}
		if record.Path == "" {
			continue
		}
		s.cache.Add(record.Path, MediaDimensions{
			Width:  record.Width,
			Height: record.Height,
			Size:   record.Size,
			MTime:  record.MTime,
		})
	}
}

// Dimensions 返回文件的原始像素尺寸；无法探测时返回零值尺寸。
//
// 缓存命中且文件未变化时直接返回；否则读取图片头重新探测并写入缓存。
func (s *MediaDimensionService) Dimensions(path string) MediaDimensions {
	if path == "" {
		return MediaDimensions{}
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return MediaDimensions{}
	}
	size := info.Size()
	mtime := info.ModTime().UnixMilli()

	s.mu.Lock()
	cached, ok := s.cache.Get(path)
	s.mu.Unlock()
	if ok && cached.Size == size && cached.MTime == mtime {
		return cached
	}

	dimensions := MediaDimensions{Size: size, MTime: mtime}
	width, height := decodeImageDimensions(path)
	dimensions.Width = width
	dimensions.Height = height

	s.mu.Lock()
	s.cache.Add(path, dimensions)
	s.appendLocked(dimensionRecord{
		Path:   path,
		Width:  width,
		Height: height,
		Size:   size,
		MTime:  mtime,
	})
	s.mu.Unlock()
	return dimensions
}

// appendLocked 追加一条缓存记录。调用方必须已持有锁。
//
// 每次写入都打开并立即关闭文件：Windows 上长期持有派生缓存文件的句柄会让
// 「清空缓存」无法删除它，测试的临时目录清理也会失败。新尺寸只在第一次
// 遇到文件时产生，额外的开关文件开销远低于一次图片头解码。
func (s *MediaDimensionService) appendLocked(record dimensionRecord) {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return
	}
	data, err := json.Marshal(record)
	if err != nil {
		return
	}
	file, err := os.OpenFile(s.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer file.Close()
	if _, err := file.Write(append(data, '\n')); err != nil {
		return
	}
	// 每条都刷盘：派生缓存丢几条不影响正确性，但延迟刷盘会在进程被杀时
	// 留下半行 JSON。刷盘成本远低于一次解码。
	_ = file.Sync()
}

// Close 释放资源。派生缓存不需要常驻句柄，这里只是保持调用方接口完整。
func (s *MediaDimensionService) Close() error {
	return nil
}

// decodeImageDimensions 读取图片头得到像素尺寸。
//
// HEIC/HEIF 当前没有纯 Go 解码器（见 image_info.go 的说明），
// 因此这两类文件返回 0，前端会退回默认比例。
func decodeImageDimensions(path string) (int, int) {
	file, err := os.Open(path)
	if err != nil {
		return 0, 0
	}
	defer file.Close()
	config, _, err := image.DecodeConfig(file)
	if err != nil {
		return 0, 0
	}
	return config.Width, config.Height
}

// ErrMediaDimensionUnavailable 表示尺寸服务尚未初始化。
var ErrMediaDimensionUnavailable = errors.New("media dimension service is not initialized")
