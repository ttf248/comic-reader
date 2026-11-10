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

	"github.com/tianlongxiang/local-gallery/internal/models"
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
	// Undecodable 标记这份文件解码不出来：不是浏览器打不开的格式
	// （HEIC/HEIF 由服务端转换），而是文件本身坏了 —— 扩展名说是 JPEG，
	// 内容却不是；或者头能读、像素数据却是截断的。
	//
	// 两种来源：读图片头就失败（当场判定），以及渲染时整张解码失败
	// （MarkUndecodable 补记）。界面上据此显示「无法解码」，而不是
	// 让用户对着一个破图图标猜。
	Undecodable bool `json:"undecodable,omitempty"`
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
	// pending 是已探测、还没落盘的记录。一页两百张照片就是两百条，
	// 逐条刷盘等于两百次 fsync —— 实测一页要两秒，翻年墙时非常明显。
	// 攒成一批写，一次 fsync 就够。
	pending []dimensionRecord
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
	Path        string `json:"path"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	Size        int64  `json:"size"`
	MTime       int64  `json:"mtime"`
	Undecodable bool   `json:"undecodable,omitempty"`
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
			Width:       record.Width,
			Height:      record.Height,
			Size:        record.Size,
			MTime:       record.MTime,
			Undecodable: record.Undecodable,
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
		return s.withHeaderVerdict(path, cached)
	}

	dimensions := MediaDimensions{Size: size, MTime: mtime}
	width, height, headerOK := decodeImageDimensions(path)
	dimensions.Width = width
	dimensions.Height = height
	// 图片头都读不出来：这个文件多半不是它声称的那种图片。需要转换的
	// 格式（HEIC/HEIF/TIFF）不算 —— 它们由服务端转换，不该判成坏文件。
	dimensions.Undecodable = !headerOK && !models.NeedsBrowserConversion(filepath.Base(path))

	s.mu.Lock()
	s.cache.Add(path, dimensions)
	s.pending = append(s.pending, dimensionRecord{
		Path:        path,
		Width:       width,
		Height:      height,
		Size:        size,
		MTime:       mtime,
		Undecodable: dimensions.Undecodable,
	})
	// 攒到一定量就自己落盘：调用方忘了刷也不会把内存吃满。
	needFlush := len(s.pending) >= dimensionFlushThreshold
	s.mu.Unlock()
	if needFlush {
		s.Flush()
	}
	return dimensions
}

// dimensionFlushThreshold 是待落盘记录的攒批上限。
//
// 超过它就自己落盘：调用方忘了刷也不会把内存吃满。
const dimensionFlushThreshold = 4096

// Flush 把待落盘的尺寸记录一次写完。
//
// 派生缓存丢几条不影响正确性（下次重新探测），但延迟刷盘会在进程被杀时
// 留下半行 JSON。因此仍然刷盘，只是攒成一批：一次写、一次 fsync，
// 而不是每条一次。
func (s *MediaDimensionService) Flush() {
	s.mu.Lock()
	records := s.pending
	s.pending = nil
	s.mu.Unlock()
	if len(records) == 0 {
		return
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return
	}
	buffer := make([]byte, 0, len(records)*96)
	for _, record := range records {
		data, err := json.Marshal(record)
		if err != nil {
			continue
		}
		buffer = append(buffer, data...)
		buffer = append(buffer, '\n')
	}
	if len(buffer) == 0 {
		return
	}
	file, err := os.OpenFile(s.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer file.Close()
	if _, err := file.Write(buffer); err != nil {
		return
	}
	_ = file.Sync()
}

// withHeaderVerdict 给尺寸记录补上"读不出图片头"的判定。
//
// 尺寸缓存早于「无法解码」这个标记，磁盘上的旧记录没有这一位：宽高都
// 是 0 的记录就是读不出图片头，按同一规则补判即可，不必为此让整份
// 缓存作废、重新探测全库。
func (s *MediaDimensionService) withHeaderVerdict(path string, dimensions MediaDimensions) MediaDimensions {
	if dimensions.Undecodable || dimensions.Known() {
		return dimensions
	}
	if models.NeedsBrowserConversion(filepath.Base(path)) {
		return dimensions
	}
	dimensions.Undecodable = true
	return dimensions
}

// MarkUndecodable 记下"这个文件解码不出来"。
//
// 图片头能读、像素数据却是坏的（截断的 JPEG 之类），只有真正解码一次
// 才暴露出来。渲染路径遇到这种失败会回调这里，记完之后照片墙就能把这
// 张图标成「无法解码」，而不是让用户对着破图图标猜。
//
// 记录跟着文件走：文件被替换（大小或修改时间变了）后判定作废，下次
// 重新探测。
func (s *MediaDimensionService) MarkUndecodable(path string) {
	if path == "" {
		return
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return
	}
	size := info.Size()
	mtime := info.ModTime().UnixMilli()

	s.mu.Lock()
	defer s.mu.Unlock()
	cached, ok := s.cache.Get(path)
	if ok && (cached.Size != size || cached.MTime != mtime) {
		// 文件已经换了：这条判定针对的是旧内容，不作数。
		return
	}
	dimensions := MediaDimensions{
		Width:       cached.Width,
		Height:      cached.Height,
		Size:        size,
		MTime:       mtime,
		Undecodable: true,
	}
	s.cache.Add(path, dimensions)
	s.pending = append(s.pending, dimensionRecord{
		Path:        path,
		Width:       dimensions.Width,
		Height:      dimensions.Height,
		Size:        size,
		MTime:       mtime,
		Undecodable: true,
	})
}

// Close 释放资源。派生缓存不需要常驻句柄，这里只是保持调用方接口完整。
func (s *MediaDimensionService) Close() error {
	s.Flush()
	return nil
}

// decodeImageDimensions 读取图片头得到像素尺寸。
//
// 第三个返回值表示图片头是否读得出来：读不出来说明这个文件压根不是
// 一张能解码的图片（扩展名说是 JPEG，内容却不是）。
//
// HEIC/HEIF 当前没有纯 Go 解码器（见 image_info.go 的说明），
// 因此这两类文件返回 0，前端会退回默认比例。
func decodeImageDimensions(path string) (int, int, bool) {
	file, err := os.Open(path)
	if err != nil {
		return 0, 0, false
	}
	defer file.Close()
	config, _, err := image.DecodeConfig(file)
	if err != nil {
		return 0, 0, false
	}
	return config.Width, config.Height, true
}

// ErrMediaDimensionUnavailable 表示尺寸服务尚未初始化。
var ErrMediaDimensionUnavailable = errors.New("media dimension service is not initialized")
