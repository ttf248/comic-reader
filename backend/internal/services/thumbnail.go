package services

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/disintegration/imaging"
	lru "github.com/hashicorp/golang-lru/v2"
	"golang.org/x/sync/semaphore"
	"golang.org/x/sync/singleflight"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// ErrUnsupportedFormat 图片格式不受支持。
var ErrUnsupportedFormat = errors.New("unsupported image format")

// ErrSourceMissing 源媒体不存在或不再是普通文件。
var ErrSourceMissing = errors.New("media source not found")

// ErrVideoCoverMissing 视频封面尚未生成。
//
// 流程：前端首次访问视频封面时 GetOrCreate 返回此错误，handler 透传
// 404 + code=video_cover_missing 触发前端 `<video>` 抽帧 → SaveVideoCover
// 回填。第二次访问直接命中磁盘缓存。
var ErrVideoCoverMissing = errors.New("video cover not yet extracted")

// 缩略图解码的并发与内存预算。
//
// 真实媒体库里手机原图动辄 12–48MP，单张解码要 200–400ms，且解码后的
// 像素缓冲按原图尺寸计（24MP 的 YCbCr 约 36MB）。原来的固定 4 路并发
// 在 16 核机器上只用到四分之一算力，专辑首屏 30 张缩略图要等 3–4 秒。
//
// 现在改成两道闸门：
//   - workerSlots：并行度上限，跟随 CPU 核数；
//   - decodePixels：像素预算（单位：百万像素），限制同时解码的像素总量，
//     大图自然只能少量并行，小图（截图等）可以跑满并行度而不撑爆内存。
const (
	// thumbnailDecodePixelBudget 同时解码的像素上限（百万像素）。
	// 24MP 原图约合 36MB YCbCr，192MP 预算大致对应 300MB 级别的解码缓冲。
	thumbnailDecodePixelBudget = 192
	// thumbnailMaxWorkers 并行解码的任务上限。
	thumbnailMaxWorkers = 12
	// thumbnailUnknownPixelWeight 读不到图片头时的保守权重：
	// 按大图对待，只允许少量并发，避免意外的文件把内存打爆。
	thumbnailUnknownPixelWeight = 24

	// convertedMaxDim 整图转换后的最长边像素上限。
	// 12MP 原图转成 JPEG 约 3–5MB，缩到 2560 后约 1MB，够看也够快。
	convertedMaxDim = 2560
	// convertedCacheSize 整图转换结果的内存缓存条数（每条约 1MB）。
	convertedCacheSize = 8

	// previewCacheSize 预览图内存 LRU 条数（每条几百 KB）。
	previewCacheSize = 16
	// previewJPEGQuality 预览图 JPEG 质量，与缩略图一致（85）：
	// 1600px 宽的照片在 q85 下约 200–400KB，肉眼几乎无损。
	previewJPEGQuality = 85
)

// ThumbnailService 缩略图服务：LRU 内存缓存 + 磁盘缓存。
//
// 缓存 key 由 (abs_path, mtime, size) 派生，确保源文件变更后能自动失效。
type ThumbnailService struct {
	cacheDir   string
	maxAgeDays int
	lruSize    int
	// rootDir 是缓存根目录（state/ 与 derived/ 的父目录）。
	// 早期版本把缩略图平铺在缓存根下，那批遗留文件没有任何代码路径
	// 会去读或清理，只能靠清理动作顺带扫掉。
	rootDir string
	// convertedDir 存放"浏览器可直接显示"的整图转换结果（HEIC/TIFF 等）。
	// 与缩略图分开存放，避免同一目录里混两种用途的文件。
	convertedDir string
	// previewDir 存放阅读器用的预览图（按请求宽度缩放的 JPEG）。
	// 单张几百 KB，与缩略图（十几 KB）混在一起会让缩略图 LRU 很快被冲掉，
	// 所以单独一个目录和单独一个 LRU。
	previewDir string

	mu       sync.RWMutex
	memCache *lru.Cache[string, []byte]
	// convertedCache 单独缓存整图转换结果：一张 JPEG 动辄几 MB，
	// 与缩略图共用一个 LRU 会把缩略图全部挤掉。
	convertedCache *lru.Cache[string, []byte]
	// previewCache 单独缓存预览图：单张几百 KB，混进缩略图 LRU 同样会挤掉缩略图。
	previewCache *lru.Cache[string, []byte]

	// singleflight 防缓存击穿：同一 key 并发请求时只跑一次生成，
	// 其他协程等结果。冷启动 / 用户翻到未缓存的合集时（首页 20+ 张
	// 同时 miss）特别有用。
	flight singleflight.Group

	// 视频抽帧比图片缩放更吃 CPU/IO；即使不同视频 key 不同，也不能让
	// 一个视口同时启动几十个 ffmpeg。singleflight 负责同文件去重，
	// 这个槽位限制不同文件的并发数。
	videoCoverSlots chan struct{}
	// imageSlots 限制并行解码的任务数（跟随 CPU 核数）。
	imageSlots chan struct{}
	// decodePixels 限制同时解码的像素总量，防止大图把内存打爆。
	decodePixels *semaphore.Weighted

	// videoCover 用于服务端 FFmpeg 抽帧（可选）。为 nil 时,
	// 视频封面维持原"客户端抽帧 + 上传"流程(见 getVideoCover)。
	// FFmpeg 抽帧失败时同样回退到 ErrVideoCoverMissing,
	// 让前端继续走原有 fallback。
	videoCover *VideoCoverExtractor

	// imageConverter 用于服务端 FFmpeg 转换纯 Go 解不了的图片
	// （目前是 iPhone 的 HEIC/HEIF）。为 nil 或 ffmpeg 不可用时，
	// 这类文件按"不支持的格式"处理（415），前端显示占位图。
	imageConverter *ImageConverter
}

// ThumbnailOptions 构造选项。
type ThumbnailOptions struct {
	CacheDir   string // 必填
	MaxAgeDays int    // 默认 30
	LRUSize    int    // 默认 500

	// RootDir 可选：缓存根目录。清理缩略图时顺带扫掉早期版本平铺在
	// 根目录下的遗留 JPEG。
	RootDir string

	// ConvertedDir 可选：整图转换结果的缓存目录。
	// 留空时复用 CacheDir 下的 converted 子目录。
	ConvertedDir string

	// PreviewDir 可选：预览图（阅读器按宽度缩放图）的缓存目录。
	// 留空时复用 CacheDir 下的 previews 子目录。
	PreviewDir string

	// VideoCover 可选:传入后,视频封面在服务端用 ffmpeg 抽帧;
	// 不传则维持原"客户端抽帧 + 上传"流程。
	VideoCover *VideoCoverExtractor

	// ImageConverter 可选:传入后,HEIC/HEIF 等纯 Go 解不了的图片
	// 由 ffmpeg 转成缩略图;不传则按"不支持的格式"处理。
	ImageConverter *ImageConverter
}

// NewThumbnailService 创建缩略图服务。
func NewThumbnailService(opts ThumbnailOptions) (*ThumbnailService, error) {
	if opts.CacheDir == "" {
		return nil, errors.New("cacheDir is required")
	}
	if err := os.MkdirAll(opts.CacheDir, 0o755); err != nil {
		return nil, fmt.Errorf("create cache dir: %w", err)
	}

	days := opts.MaxAgeDays
	if days <= 0 {
		days = 30
	}
	lruSize := opts.LRUSize
	if lruSize <= 0 {
		lruSize = 500
	}

	convertedDir := opts.ConvertedDir
	if convertedDir == "" {
		convertedDir = filepath.Join(opts.CacheDir, "converted")
	}
	previewDir := opts.PreviewDir
	if previewDir == "" {
		previewDir = filepath.Join(opts.CacheDir, "previews")
	}
	if err := os.MkdirAll(previewDir, 0o755); err != nil {
		return nil, fmt.Errorf("create preview dir: %w", err)
	}

	cache, err := lru.New[string, []byte](lruSize)
	if err != nil {
		return nil, fmt.Errorf("create lru: %w", err)
	}
	convertedCache, err := lru.New[string, []byte](convertedCacheSize)
	if err != nil {
		return nil, fmt.Errorf("create converted lru: %w", err)
	}
	previewCache, err := lru.New[string, []byte](previewCacheSize)
	if err != nil {
		return nil, fmt.Errorf("create preview lru: %w", err)
	}

	return &ThumbnailService{
		cacheDir:        opts.CacheDir,
		rootDir:         opts.RootDir,
		convertedDir:    convertedDir,
		previewDir:      previewDir,
		maxAgeDays:      days,
		lruSize:         lruSize,
		memCache:        cache,
		convertedCache:  convertedCache,
		previewCache:    previewCache,
		videoCover:      opts.VideoCover,
		imageConverter:  opts.ImageConverter,
		videoCoverSlots: make(chan struct{}, 2),
		imageSlots:      make(chan struct{}, min(thumbnailMaxWorkers, runtime.NumCPU())),
		decodePixels:    semaphore.NewWeighted(thumbnailDecodePixelBudget),
	}, nil
}

// CacheKey 计算缓存键。
//
// key = md5(abs_path + "|" + mtime_ns + "|" + size)
func CacheKey(absPath string, mtime time.Time, size int64) string {
	h := md5.New()
	fmt.Fprintf(h, "%s|%d|%d", absPath, mtime.UnixNano(), size)
	return hex.EncodeToString(h.Sum(nil))
}

// CacheKeyFromStat 便捷方法：从文件信息生成 key。
func CacheKeyFromStat(absPath string, fi os.FileInfo) string {
	return CacheKey(absPath, fi.ModTime(), fi.Size())
}

// videoCoverKey 视频封面专用缓存键。
//
// 在普通 CacheKey 前加 "vc2:" 前缀，避免与同路径下的图片缩略图键碰撞
// （虽然一般不会同路径同时有图有视频，但显式区分更安全）。失效策略
// 与图片一致：mtime 或 size 变化时自动重新生成。
//
// 前缀里的版本号 vc2：封面早期用 letterbox 补黑边到固定尺寸，与图片
// 缩略图（等比缩放、不补边）形状不一致；改为等比缩放后必须换前缀，
// 否则磁盘上已有的补边封面会继续命中缓存，修复不会生效。
func videoCoverKey(absPath string, mtime time.Time, size int64) string {
	h := md5.New()
	fmt.Fprintf(h, "vc2:%s|%d|%d", absPath, mtime.UnixNano(), size)
	return hex.EncodeToString(h.Sum(nil))
}

// videoCoverMasterWidth 视频封面母版的宽度。
//
// 母版只抽一次，各档渲染图都从母版缩出来。取 1280 是为了在照片墙
// 550px 的瓦片上，即使屏幕是 2 倍像素也拿得到够宽的一档。
const videoCoverMasterWidth = 1280

// videoCoverMasterKey 封面母版（未分档）的缓存键。
//
// 与分档渲染图的键（renditionKey）分开：母版是缩放的来源，
// 分档图是从母版派生出来的产物，两者生命周期不同。
func videoCoverMasterKey(absPath string, mtime time.Time, size int64) string {
	h := md5.New()
	fmt.Fprintf(h, "vcm:%s|%d|%d", absPath, mtime.UnixNano(), size)
	return hex.EncodeToString(h.Sum(nil))
}

// JPEGExt 磁盘缓存扩展名。200x350 的 PNG 普遍 100-300KB，对漫画/照片
// 这种平滑渐变内容性价比极低；JPEG quality 85 同样大小降 5-10x 且肉眼
// 几乎无差。文件扩展名与 Content-Type 一致，方便手动排错。
const JPEGExt = ".jpg"

// GetConvertedImage 返回浏览器可直接显示的整图 JPEG。
//
// HEIC/HEIF（iPhone 照片）与 TIFF 浏览器原生解不了，原样发送只会得到
// 破图；这里用 ffmpeg 转成 JPEG，并用独立的内存 LRU + 磁盘缓存保存，
// 转换只做一次（磁盘命中即返回）。
//
// 转换不可用（没有 ffmpeg）或失败时返回 ErrUnsupportedFormat，调用方
// 应回退成"该格式无法显示"的提示，而不是把原文件当图片发出去。
func (s *ThumbnailService) GetConvertedImage(absPath string) ([]byte, error) {
	if s.imageConverter == nil || !s.imageConverter.Available() {
		return nil, ErrUnsupportedFormat
	}
	fi, err := os.Stat(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrSourceMissing
		}
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, ErrSourceMissing
	}

	key := convertedKey(CacheKeyFromStat(absPath, fi))
	if data, ok := s.convertedCache.Get(key); ok {
		return data, nil
	}
	diskPath := filepath.Join(s.convertedDir, key+JPEGExt)
	if data, err := os.ReadFile(diskPath); err == nil {
		s.convertedCache.Add(key, data)
		return data, nil
	}

	v, err, _ := s.flight.Do(key, func() (interface{}, error) {
		if data, ok := s.convertedCache.Get(key); ok {
			return data, nil
		}
		if data, err := os.ReadFile(diskPath); err == nil {
			s.convertedCache.Add(key, data)
			return data, nil
		}
		return s.generateConverted(absPath, diskPath, key)
	})
	if err != nil {
		return nil, err
	}
	return v.([]byte), nil
}

// convertedKey 整图转换的缓存键：在普通 CacheKey 前加 "cv:" 前缀，
// 避免与同源文件的缩略图缓存键碰撞。
func convertedKey(sourceKey string) string {
	sum := md5.Sum([]byte("cv:" + sourceKey))
	return hex.EncodeToString(sum[:])
}

// generateConverted 转换整图并写盘 + 写内存缓存。
func (s *ThumbnailService) generateConverted(absPath, diskPath, key string) ([]byte, error) {
	data, err := s.imageConverter.ConvertJPEGBytes(absPath, convertedMaxDim)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrUnsupportedFormat, err.Error())
	}
	// 目录按需创建：没有转换任务时不留空目录，缩略图缓存目录保持干净。
	if derr := os.MkdirAll(s.convertedDir, 0o755); derr != nil {
		return nil, fmt.Errorf("create converted cache dir: %w", derr)
	}
	if werr := os.WriteFile(diskPath, data, 0o644); werr != nil {
		// 写失败不影响返回（仅缓存丢失，下次重新转换）
		fmt.Fprintf(os.Stderr, "write converted cache key=%s: %v\n", key, werr)
	}
	s.convertedCache.Add(key, data)
	return data, nil
}

// GetOrCreate 获取或生成指定宽度的渲染图。返回 JPEG 字节。
//
// width 是渲染档位的目标宽度；调用方应先用 SnapRenditionWidth 把它对齐
// 到档位阶梯上，缓存键里带的就是这个宽度。
//
// 按源文件类型自动分流：
//   - 图片（jpg/png/gif/bmp/webp/tiff）：解码 → 缩放 → 缓存
//   - 视频（mp4/webm/mov/mkv/avi/m4v）：仅查询已缓存的封面
//     （由前端浏览器抽帧后回填到 SaveVideoCover），未命中返回
//     ErrVideoCoverMissing，handler 端透传 404 + code 让前端触发抽帧。
func (s *ThumbnailService) GetOrCreate(absPath string, width int) ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if models.IsVideoFile(filepath.Base(absPath)) {
		return s.getVideoCover(absPath, width)
	}
	return s.getOrCreateImage(absPath, width)
}

// PreviewImage 预览图结果。
//
// ContentType 恒为 image/jpeg：预览图要么是缩放后重新编码的 JPEG，
// 要么是原图本身就是 JPEG 且不宽于目标宽度时直接复用原图字节。
type PreviewImage struct {
	Data        []byte
	ContentType string
	// ETag 由源文件版本与目标档位派生，
	// 源文件变化或换了档位都会让旧缓存失效。
	ETag string
	// Version 是源文件的内容版本号，供 handler 判断能否回 immutable。
	Version string
}

// GetOrCreatePreview 返回按 maxWidth 缩放的预览图。
//
// 阅读器连续模式按视口宽度展示图片，如果直接发原图，手机照片动辄
// 12MP / 5MB，一屏就是几 MB，整本翻下来是 GB 级流量；浏览器还要为每张
// 原图解码出几十 MB 的位图。这里按请求宽度等比缩放并缓存到磁盘，
// 1600px 宽的 q85 JPEG 约 200–400KB，是原图的 1/10~1/30。
//
// maxWidth 会被对齐到档位阶梯（SnapRenditionWidth）：档位固定之后，
// 同一个源图不会因为视口差几十像素就多出一份缓存产物。
// 缓存键包含源文件版本与目标档位，源文件改了或换了档位都会重新生成。
func (s *ThumbnailService) GetOrCreatePreview(absPath string, maxWidth int) (PreviewImage, error) {
	maxWidth = SnapRenditionWidth(maxWidth)
	fi, err := os.Stat(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			return PreviewImage{}, ErrSourceMissing
		}
		return PreviewImage{}, err
	}
	if !fi.Mode().IsRegular() {
		return PreviewImage{}, ErrSourceMissing
	}

	version := MediaVersionFromStat(fi)
	sourceKey := CacheKeyFromStat(absPath, fi)
	key := previewCacheKey(sourceKey, maxWidth)
	etag := RenditionETag(version, maxWidth)

	s.mu.RLock()
	defer s.mu.RUnlock()

	if data, ok := s.previewCache.Get(key); ok {
		return PreviewImage{Data: data, ContentType: "image/jpeg", ETag: etag, Version: version}, nil
	}
	diskPath := filepath.Join(s.previewDir, key+JPEGExt)
	if data, err := os.ReadFile(diskPath); err == nil {
		s.previewCache.Add(key, data)
		return PreviewImage{Data: data, ContentType: "image/jpeg", ETag: etag, Version: version}, nil
	}

	// 同 key 并发只生成一次，避免一屏多张图同时请求时重复解码原图。
	v, err, _ := s.flight.Do(key, func() (interface{}, error) {
		if data, ok := s.previewCache.Get(key); ok {
			return data, nil
		}
		if data, err := os.ReadFile(diskPath); err == nil {
			s.previewCache.Add(key, data)
			return data, nil
		}
		data, err := s.generatePreview(absPath, maxWidth)
		if err != nil {
			return nil, err
		}
		if werr := os.WriteFile(diskPath, data, 0o644); werr != nil {
			// 写失败不影响返回（仅缓存丢失，下次重新生成）
			fmt.Fprintf(os.Stderr, "write preview cache key=%s: %v\n", key, werr)
		}
		s.previewCache.Add(key, data)
		return data, nil
	})
	if err != nil {
		return PreviewImage{}, err
	}
	return PreviewImage{Data: v.([]byte), ContentType: "image/jpeg", ETag: etag, Version: version}, nil
}

// previewCacheKey 把目标档位纳入缓存键。
//
// 同一张图按不同档位请求会得到不同产物，键里必须带档位；
// 前缀 pv1 与缩略图 / 整图转换的键区分开，避免互相覆盖。
// 渲染算法版本也进键：算法升级后旧产物不再命中。
func previewCacheKey(sourceKey string, maxWidth int) string {
	sum := md5.Sum([]byte(fmt.Sprintf("pv1:%s|%d|jpeg-r%d", sourceKey, maxWidth, renditionAlgoVersion)))
	return hex.EncodeToString(sum[:])
}

// generatePreview 解码 → 按宽度缩放 → 编码 JPEG。
//
// 源图本身是 JPEG 且不宽于目标宽度时直接复用原图字节：零编码开销、
// 零画质损失（常见情况），缓存里存的仍是一份 .jpg。
func (s *ThumbnailService) generatePreview(absPath string, maxWidth int) ([]byte, error) {
	ext := strings.ToLower(filepath.Ext(absPath))
	if (ext == ".jpg" || ext == ".jpeg") && !models.NeedsBrowserConversion(filepath.Base(absPath)) {
		if width, _, err := imageDimensions(absPath); err == nil && width > 0 && width <= maxWidth {
			return os.ReadFile(absPath)
		}
	}

	// 与缩略图共用解码闸门：原图动辄几十 MB 解码缓冲，
	// 不加预算的话一屏并发就能把内存顶高。
	weight, err := decodePixelWeight(absPath)
	if err != nil {
		return nil, err
	}
	if err := s.decodePixels.Acquire(context.Background(), weight); err != nil {
		return nil, fmt.Errorf("acquire decode budget: %w", err)
	}
	defer s.decodePixels.Release(weight)

	s.imageSlots <- struct{}{}
	defer func() { <-s.imageSlots }()

	img, err := decodeImage(absPath)
	if err != nil {
		if errors.Is(err, ErrUnsupportedFormat) {
			// 纯 Go 解不了的格式（HEIC/HEIF）：交给 ffmpeg 转换后再缩放。
			converted, cerr := s.convertUnsupported(absPath, maxWidth)
			if cerr != nil {
				return nil, ErrUnsupportedFormat
			}
			img = converted
		} else {
			return nil, fmt.Errorf("decode: %w", err)
		}
	}

	resized := resizeToWidth(img, maxWidth)
	// JPEG 没有 alpha 通道，PNG 的透明区域要先压到白底，
	// 否则透明像素会变成黑块（漫画线稿常见）。
	flat := flattenOnWhite(resized)
	buf, err := encodeJPEG(flat, previewJPEGQuality)
	if err != nil {
		return nil, fmt.Errorf("encode preview: %w", err)
	}
	return buf, nil
}

// resizeToWidth 把图片等比缩放到不超过 maxWidth 宽（不放大）。
//
// 两步降采样：先用廉价的 Box 面积平均压到目标宽度的 2 倍以内，
// 再用 Lanczos 收尾 —— 与缩略图同一套做法，避免大图直接跑 Lanczos
// 时的几十毫秒开销。
func resizeToWidth(img image.Image, maxWidth int) image.Image {
	srcW := img.Bounds().Dx()
	if srcW <= maxWidth {
		return img
	}
	pre := imaging.Resize(img, maxWidth*2, 0, imaging.Box)
	return imaging.Resize(pre, maxWidth, 0, imaging.Lanczos)
}

// flattenOnWhite 把带 alpha 的图压到白底。
//
// JPEG 不支持透明通道，直接编码会让透明区域变成黑色；
// 漫画 / 透明 PNG 压到白底才是读者预期的样子。
func flattenOnWhite(img image.Image) *image.NRGBA {
	b := img.Bounds()
	dst := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(dst, dst.Bounds(), &image.Uniform{C: color.White}, image.Point{}, draw.Src)
	draw.Draw(dst, dst.Bounds(), img, b.Min, draw.Over)
	return dst
}

// imageDimensionsOf 从字节读图片头，返回宽高。读不出来时返回错误。
func imageDimensionsOf(data []byte) (int, int, error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0, err
	}
	return cfg.Width, cfg.Height, nil
}

// imageDimensions 只读图片头，返回宽高。读不出来时返回错误。
func imageDimensions(absPath string) (int, int, error) {
	f, err := os.Open(absPath)
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return 0, 0, err
	}
	return cfg.Width, cfg.Height, nil
}

// renditionKey 把渲染档位和编码版本纳入磁盘及内存缓存标识。
// 宽度进键：同一张源图在不同档位下是不同产物，必须分开存。
func (s *ThumbnailService) renditionKey(sourceKey string, width int) string {
	sum := md5.Sum([]byte(fmt.Sprintf("%s|%d|jpeg-r%d", sourceKey, width, renditionAlgoVersion)))
	return hex.EncodeToString(sum[:])
}

// getOrCreateImage 图片渲染流程：按目标宽度等比缩放，不裁剪、不放大。
func (s *ThumbnailService) getOrCreateImage(absPath string, width int) ([]byte, error) {
	fi, err := os.Stat(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrSourceMissing
		}
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, ErrSourceMissing
	}

	key := s.renditionKey(CacheKeyFromStat(absPath, fi), width)

	// 1) 内存缓存
	if data, ok := s.memCache.Get(key); ok {
		return data, nil
	}

	// 2) 磁盘缓存
	diskPath := filepath.Join(s.cacheDir, key+JPEGExt)
	if data, err := os.ReadFile(diskPath); err == nil {
		s.memCache.Add(key, data)
		return data, nil
	}

	// 3) 生成：singleflight 同 key 并发只跑一次。
	//    返回值是 []byte；singleflight.Any 类型一致即可。
	v, err, _ := s.flight.Do(key, func() (interface{}, error) {
		// 双重检查：进入临界区后再次读磁盘/内存，避免上一个协程
		// 刚生成完的成果被本协程重新覆盖生成。
		if data, ok := s.memCache.Get(key); ok {
			return data, nil
		}
		if data, err := os.ReadFile(diskPath); err == nil {
			s.memCache.Add(key, data)
			return data, nil
		}
		return s.generateAndPersist(absPath, key, width)
	})
	if err != nil {
		return nil, err
	}
	return v.([]byte), nil
}

// generateAndPersist 调用 decode+resize+encode 并把结果写盘 + 加内存缓存。
// 假定 diskPath 还没命中（已经被 singleflight 拦截过一次）。调用方需持
// memCache.Add 路径锁；这里串行写避免与并发 singleflight 重复覆盖。
func (s *ThumbnailService) generateAndPersist(absPath, key string, width int) ([]byte, error) {
	data, err := s.generate(absPath, width)
	if err != nil {
		return nil, err
	}
	diskPath := filepath.Join(s.cacheDir, key+JPEGExt)
	if werr := os.WriteFile(diskPath, data, 0o644); werr != nil {
		// 写失败不影响返回（仅缓存丢失，下次重新生成）
		fmt.Fprintf(os.Stderr, "write thumbnail cache key=%s: %v\n", key, werr)
	}
	s.memCache.Add(key, data)
	return data, nil
}

// getVideoCover 查询视频封面缓存。优先级:
//
//  1. 内存 LRU 命中 → 直接返回
//  2. 磁盘缓存命中 → 返回并回填 LRU
//  3. 配置了 VideoCover(ffmpeg) → 尝试服务端抽帧
//     - 成功:写入磁盘 + LRU,返回
//     - 失败:回退到 ErrVideoCoverMissing,让前端继续走浏览器抽帧
//  4. 未配置 ffmpeg / 抽帧失败 → ErrVideoCoverMissing
//
// 注意:先做 Stat 校验源文件存在,避免对已删除视频返回错误状态码
// 误导前端"以为要抽帧"。
func (s *ThumbnailService) getVideoCover(absPath string, width int) ([]byte, error) {
	fi, err := os.Stat(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrSourceMissing
		}
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, ErrSourceMissing
	}
	sourceKey := videoCoverKey(absPath, fi.ModTime(), fi.Size())
	tierKey := s.renditionKey(sourceKey, width)

	// 1) 档位缓存
	if data, ok := s.memCache.Get(tierKey); ok {
		return data, nil
	}
	diskPath := filepath.Join(s.cacheDir, tierKey+JPEGExt)
	if data, err := os.ReadFile(diskPath); err == nil {
		s.memCache.Add(tierKey, data)
		return data, nil
	}

	master, err := s.videoCoverMaster(absPath, fi)
	if err != nil {
		return nil, err
	}

	// 母版比这一档还窄时直接给母版，不放大。
	if masterWidth, _, derr := imageDimensionsOf(master); derr == nil && masterWidth <= width {
		s.memCache.Add(tierKey, master)
		return master, nil
	}

	// 2) 从母版缩出这一档。
	img, _, derr := image.Decode(bytes.NewReader(master))
	if derr != nil {
		return nil, ErrVideoCoverMissing
	}
	buf, err := encodeJPEG(flattenOnWhite(resizeToWidth(img, width)), jpegQuality)
	if err != nil {
		return nil, err
	}
	if werr := os.WriteFile(diskPath, buf, 0o644); werr != nil {
		// 写失败不影响返回（仅缓存丢失，下次重新生成）
		fmt.Fprintf(os.Stderr, "write video cover rendition key=%s: %v\n", tierKey, werr)
	}
	s.memCache.Add(tierKey, buf)
	return buf, nil
}

// videoCoverMaster 取视频封面的母版（未分档）。
//
// 母版只做一次：服务端 ffmpeg 抽帧，或前端浏览器抽帧后上传回来的那张。
// 各档渲染图都从母版缩出来 —— 抽帧很贵，不能每个档位抽一次。
func (s *ThumbnailService) videoCoverMaster(absPath string, fi os.FileInfo) ([]byte, error) {
	key := videoCoverMasterKey(absPath, fi.ModTime(), fi.Size())
	if data, ok := s.memCache.Get(key); ok {
		return data, nil
	}
	diskPath := filepath.Join(s.cacheDir, key+JPEGExt)
	if data, err := os.ReadFile(diskPath); err == nil {
		s.memCache.Add(key, data)
		return data, nil
	}

	// 缓存都未命中：同一文件只允许一个抽帧任务，不同文件最多两个
	// ffmpeg 并行，避免滚动视频网格时把 CPU/进程表打满。
	v, err, _ := s.flight.Do("video:"+key, func() (interface{}, error) {
		if data, ok := s.memCache.Get(key); ok {
			return data, nil
		}
		if data, err := os.ReadFile(diskPath); err == nil {
			s.memCache.Add(key, data)
			return data, nil
		}

		extractor := s.videoCover
		if extractor == nil || !extractor.Available() {
			return nil, ErrVideoCoverMissing
		}

		if s.videoCoverSlots != nil {
			s.videoCoverSlots <- struct{}{}
			defer func() { <-s.videoCoverSlots }()
		}
		data, extractErr := extractor.Extract(absPath)
		if extractErr == nil && len(data) > 0 {
			if werr := os.WriteFile(diskPath, data, 0o644); werr != nil {
				// 写失败不影响返回
				fmt.Fprintf(os.Stderr, "write video cover master key=%s: %v\n", key, werr)
			}
			s.memCache.Add(key, data)
			return data, nil
		}
		// 抽帧失败(包括 ErrFFmpegUnavailable),回退到原契约：
		// 返回 ErrVideoCoverMissing,让前端继续用浏览器抽帧。
		if extractErr != nil && !errors.Is(extractErr, ErrFFmpegUnavailable) {
			fmt.Fprintf(os.Stderr, "video cover extract failed key=%s: %v\n", key, extractErr)
		}
		return nil, ErrVideoCoverMissing
	})
	if err != nil {
		return nil, err
	}
	data, ok := v.([]byte)
	if !ok {
		return nil, ErrVideoCoverMissing
	}
	return data, nil
}

// SaveVideoCover 接收前端浏览器抽帧得到的封面字节，写入缓存。
//
// 流程：
//  1. 校验 absPath 是受支持的视频扩展名 + 文件存在（用于派生 cache key）
//  2. 解码 data 为 image.Image（支持 jpeg/png，前端 canvas.toBlob 通常
//     给出 jpeg，但允许 png）
//  3. 缩到 videoCoverMasterWidth 以内，存成母版
//  4. 编码为 JPEG，写磁盘 + 加内存缓存
//
// 源文件不存在时返回 ErrSourceMissing（前端抽完帧视频已被删等场景）。
// 源文件存在但 data 不是合法图片时返回 ErrUnsupportedFormat。
func (s *ThumbnailService) SaveVideoCover(absPath string, data []byte) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !models.IsVideoFile(filepath.Base(absPath)) {
		return errors.New("source is not a supported video file")
	}
	fi, err := os.Stat(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			return ErrSourceMissing
		}
		return err
	}
	if !fi.Mode().IsRegular() {
		return ErrSourceMissing
	}

	// 解码前端上传的字节
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("decode cover data: %w", ErrUnsupportedFormat)
	}

	// 缩到母版宽度：浏览器抽帧拿到的是画布尺寸，可能比这大得多。
	thumb := resizeToWidth(img, videoCoverMasterWidth)
	buf, err := encodeJPEG(flattenOnWhite(thumb), jpegQuality)
	if err != nil {
		return fmt.Errorf("encode jpeg: %w", err)
	}

	key := videoCoverMasterKey(absPath, fi.ModTime(), fi.Size())
	diskPath := filepath.Join(s.cacheDir, key+JPEGExt)
	if werr := os.WriteFile(diskPath, buf, 0o644); werr != nil {
		return fmt.Errorf("write cover cache: %w", werr)
	}
	s.memCache.Add(key, buf)
	return nil
}

// jpegQuality JPEG 编码质量。85 是肉眼几乎不可分辨的常用值，文件大小
// 比 PNG 小 5-10x；再低（75-80）能在 320x350 网格下保持 8-15KB/张。
const jpegQuality = 85

// generate 解码 → 缩放 → 编码为 JPEG。
func (s *ThumbnailService) generate(absPath string, width int) ([]byte, error) {
	// 先按像素预算排队，再占用并行槽位：像素预算是内存闸门，先拿到它
	// 才不会让一堆大图同时进入解码阶段把内存顶高。
	weight, err := decodePixelWeight(absPath)
	if err != nil {
		return nil, err
	}
	if err := s.decodePixels.Acquire(context.Background(), weight); err != nil {
		return nil, fmt.Errorf("acquire decode budget: %w", err)
	}
	defer s.decodePixels.Release(weight)

	s.imageSlots <- struct{}{}
	defer func() { <-s.imageSlots }()

	img, err := decodeImage(absPath)
	if err != nil {
		if errors.Is(err, ErrUnsupportedFormat) {
			// 纯 Go 解不了的格式（目前是 HEIC/HEIF）：交给 ffmpeg 转换。
			converted, cerr := s.convertUnsupported(absPath, width)
			if cerr != nil {
				return nil, ErrUnsupportedFormat
			}
			img = converted
		} else {
			return nil, fmt.Errorf("decode: %w", err)
		}
	}

	// 缩放到目标宽度，保持比例（不裁剪、不填充、不放大）
	thumb := resizeToWidth(img, width)

	// JPEG 没有 alpha 通道，PNG 的透明区域要先压到白底，
	// 否则透明像素会变成黑块（漫画线稿常见）。
	buf, err := encodeJPEG(flattenOnWhite(thumb), jpegQuality)
	if err != nil {
		return nil, fmt.Errorf("encode: %w", err)
	}
	return buf, nil
}

// decodePixelWeight 读取图片头，返回该图的像素权重（单位：百万像素）。
//
// 只读文件头（不解码像素），代价可以忽略；拿到尺寸后既能作为并发
// 内存预算的权重，也避免了大图把所有并行槽位一次性占满。
//
// 读不到图片头时返回保守的大图权重：宁可少并行，也不要因为未知尺寸
// 的文件把内存打爆。
func decodePixelWeight(absPath string) (int64, error) {
	f, err := os.Open(absPath)
	if err != nil {
		return 0, fmt.Errorf("open source: %w", err)
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		// 图片头读不出来不代表不能解码（例如部分流式格式），
		// 这里不直接失败，交给后续解码给出真正的错误。
		return thumbnailUnknownPixelWeight, nil
	}
	pixels := int64(cfg.Width) * int64(cfg.Height)
	weight := (pixels + 999_999) / 1_000_000
	if weight < 1 {
		weight = 1
	}
	return weight, nil
}

// decodeImage 按扩展名选择解码器：
//   - HEIC/HEIF：纯 Go 解不了（需要 libde265 CGO 依赖），返回 ErrUnsupportedFormat
//   - 其他：imaging（覆盖 jpg/png/gif/bmp/webp/tiff）
//
// 解不出来的格式统一返回 ErrUnsupportedFormat，调用方据此决定是否
// 回退到 ffmpeg 转换。
func decodeImage(absPath string) (image.Image, error) {
	ext := strings.ToLower(filepath.Ext(absPath))
	if ext == ".heic" || ext == ".heif" {
		return nil, ErrUnsupportedFormat
	}
	img, err := imaging.Open(absPath, imaging.AutoOrientation(true))
	if err != nil {
		// 认不出格式（image.ErrFormat）与解码器不支持，统一按"不支持的
		// 格式"处理：调用方据此走 ffmpeg 兜底或返回 415。
		// I/O 错误（文件被删、读失败）保持原样，让上层区分"暂时失败"。
		if errors.Is(err, imaging.ErrUnsupportedFormat) || errors.Is(err, image.ErrFormat) {
			return nil, ErrUnsupportedFormat
		}
		return nil, err
	}
	return img, nil
}

// convertUnsupported 用 ffmpeg 把纯 Go 解不了的图片转成位图。
//
// ffmpeg 不可用或转换失败时返回错误，调用方按"不支持的格式"处理
// （前端显示占位图，不显示破图）。
func (s *ThumbnailService) convertUnsupported(absPath string, width int) (image.Image, error) {
	if s.imageConverter == nil {
		return nil, ErrImageConvertUnavailable
	}
	return s.imageConverter.Convert(absPath, width)
}

// isCacheTempFile 识别转码等流程留下的临时产物。
//
// 形如 `.c6a4e124….mp4-1618358982.tmp`：ffmpeg 输出到临时文件，再改名
// 成正式缓存。任务被取消或进程被杀时临时文件留在原地 —— 它们既不是
// 正式缓存（命名不匹配任何缓存键），又不会被容量维护清掉（本机实测
// 攒下 1GB 以上的孤儿）。因此清理与容量维护都要单独认它们。
func isCacheTempFile(name string) bool {
	return strings.HasPrefix(name, ".") && strings.HasSuffix(strings.ToLower(name), ".tmp")
}

// isThumbnailCacheFile 只识别当前 ThumbnailService 按源路径 MD5 生成的 JPEG。
// 它用于缓存统计与清理，避免误删目录中的非缓存文件。
func isThumbnailCacheFile(name string) bool {
	if !strings.EqualFold(filepath.Ext(name), JPEGExt) {
		return false
	}
	base := strings.TrimSuffix(name, filepath.Ext(name))
	if len(base) != 32 {
		return false
	}
	for _, char := range base {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
			return false
		}
	}
	return true
}

// Cleanup 删除早于 maxAgeDays 天的缓存文件。
// 返回被删除的文件数。
func (s *ThumbnailService) Cleanup() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := time.Now().AddDate(0, 0, -s.maxAgeDays)

	entries, err := os.ReadDir(s.cacheDir)
	if err != nil {
		return 0, err
	}

	count := 0
	for _, e := range entries {
		if e.IsDir() || !isThumbnailCacheFile(e.Name()) {
			continue
		}
		path := filepath.Join(s.cacheDir, e.Name())
		fi, err := e.Info()
		if err != nil {
			continue
		}
		if fi.ModTime().Before(cutoff) {
			if err := os.Remove(path); err == nil {
				count++
			}
		}
	}
	if count > 0 {
		s.memCache.Purge()
	}
	return count, nil
}

// ClearThumbnails 删除缩略图缓存目录中的所有文件,并清空缩略图内存 LRU。
//
// 与 Cleanup 不同:不按 mtime 过滤,无条件删除所有缓存条目。
// 行为契约:
//   - 内存 LRU 立即清空(下一次 GetOrCreate 会重新生成)
//   - 磁盘文件全部删除;但 cacheDir 本身保留,后续 GetOrCreate 还能写回
//   - 调用方负责:删除后通常希望"强制重建"——即下一次访问重新生成;
//     本方法不主动重新生成,只清空,避免阻塞 HTTP 路径
//   - 整图转换缓存(convertedDir)不在本方法范围内,见 ClearConverted
//
// 返回删除的文件数 + 释放的字节数(用于前端展示"已清空 N 个文件 / 释放 X MB")。
func (s *ThumbnailService) ClearThumbnails() (deleted int, freedBytes int64, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	deleted, freedBytes, err = clearCacheDir(s.cacheDir)
	if err != nil {
		return deleted, freedBytes, err
	}
	if s.rootDir != "" {
		legacyDeleted, legacyFreed, legacyErr := clearLegacyFlatCache(s.rootDir)
		if legacyErr == nil {
			deleted += legacyDeleted
			freedBytes += legacyFreed
		}
	}
	s.memCache.Purge()
	return deleted, freedBytes, nil
}

// clearLegacyFlatCache 清掉早期版本平铺在缓存根目录下的缩略图。
//
// 那些文件来自 state/derived 布局之前的年代：没有任何代码路径会读它们
// （键是按 derived/thumbnails 里的文件名算的），也不会被容量维护清掉
// （维护只扫 derived/ 下的五个子目录）。留着就是纯占地方。
func clearLegacyFlatCache(rootDir string) (int, int64, error) {
	entries, err := os.ReadDir(rootDir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, 0, nil
		}
		return 0, 0, err
	}
	deleted := 0
	var freed int64
	for _, e := range entries {
		if e.IsDir() || !isThumbnailCacheFile(e.Name()) {
			continue
		}
		path := filepath.Join(rootDir, e.Name())
		var size int64
		if fi, infoErr := e.Info(); infoErr == nil {
			size = fi.Size()
		}
		if rmErr := os.Remove(path); rmErr == nil {
			deleted++
			freed += size
		}
	}
	return deleted, freed, nil
}

// ClearConverted 删除整图转换缓存(HEIC/HEIF/TIFF 转 JPEG)并清空对应内存 LRU。
//
// 与缩略图分开清理:两者占用量级差很多(整图单张可达 MB 级),
// 用户在设置页按类型分别清理时,释放字节数才能对得上自己点的那个按钮。
func (s *ThumbnailService) ClearConverted() (deleted int, freedBytes int64, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	deleted, freedBytes, err = clearCacheDir(s.convertedDir)
	if err != nil {
		return deleted, freedBytes, err
	}
	s.convertedCache.Purge()
	return deleted, freedBytes, nil
}

// ClearPreviews 删除预览图缓存并清空对应内存 LRU。
//
// 预览图是阅读器按宽度缩放出来的中间产物,删掉不影响任何原文件,
// 下次访问会按需重新生成。
func (s *ThumbnailService) ClearPreviews() (deleted int, freedBytes int64, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	deleted, freedBytes, err = clearCacheDir(s.previewDir)
	if err != nil {
		return deleted, freedBytes, err
	}
	s.previewCache.Purge()
	return deleted, freedBytes, nil
}

// clearCacheDir 删除目录里的缩略图缓存文件，返回删除数量与释放字节数。
func clearCacheDir(dir string) (int, int64, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, 0, nil
		}
		return 0, 0, err
	}

	deleted := 0
	var freed int64
	for _, e := range entries {
		if e.IsDir() || (!isThumbnailCacheFile(e.Name()) && !isCacheTempFile(e.Name())) {
			continue
		}
		path := filepath.Join(dir, e.Name())
		fi, infoErr := e.Info()
		var size int64
		if infoErr == nil {
			size = fi.Size()
		}
		if rmErr := os.Remove(path); rmErr == nil {
			deleted++
			freed += size
		}
	}
	return deleted, freed, nil
}

// Stats 返回缓存统计信息。
type ThumbnailStats struct {
	MemoryItems int    `json:"memoryItems"`
	DiskFiles   int    `json:"diskFiles"`
	CacheDir    string `json:"cacheDir"`
	MaxAgeDays  int    `json:"maxAgeDays"`
	LRUSize     int    `json:"lruSize"`
}

// Stats 返回当前缓存统计。
func (s *ThumbnailService) Stats() ThumbnailStats {
	s.mu.Lock()
	stats := ThumbnailStats{
		MemoryItems: s.memCache.Len(),
		CacheDir:    s.cacheDir,
		MaxAgeDays:  s.maxAgeDays,
		LRUSize:     s.lruSize,
	}
	s.mu.Unlock()

	if entries, err := os.ReadDir(s.cacheDir); err == nil {
		stats.DiskFiles = len(entries)
	}
	return stats
}

// SetVideoCover 注入（或清空）服务端 ffmpeg 抽帧器。传 nil 表示
// 退回"客户端抽帧 + 上传"流程。
//
// 这是为运行期切换保留的入口；构造期通过 ThumbnailOptions.VideoCover
// 一次性传入更简洁。
func (s *ThumbnailService) SetVideoCover(vc *VideoCoverExtractor) {
	s.mu.Lock()
	s.videoCover = vc
	s.mu.Unlock()
}

// UpdateOptions 热更新部分运行参数。0 值表示"不修改"（除了 LRUSize 显式
// 用 0 表示"不重建 LRU"）。调用方负责保证 CacheDir 已存在。
//
//   - MaxAgeDays 变化：影响后续 Cleanup 的截止时间
//   - LRUSize 变化：重建 LRU 内存缓存（现有项全部丢弃）
//   - CacheDir 变化：先 MkdirAll 验证新目录可创建，再切换；旧目录保留
func (s *ThumbnailService) UpdateOptions(opts ThumbnailOptions) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if opts.VideoCover != nil {
		s.videoCover = opts.VideoCover
	}
	if opts.ImageConverter != nil {
		s.imageConverter = opts.ImageConverter
	}
	if opts.MaxAgeDays > 0 {
		s.maxAgeDays = opts.MaxAgeDays
	}
	if opts.LRUSize > 0 && opts.LRUSize != s.lruSize {
		cache, err := lru.New[string, []byte](opts.LRUSize)
		if err != nil {
			return fmt.Errorf("rebuild lru: %w", err)
		}
		s.memCache = cache
		s.lruSize = opts.LRUSize
	}
	if opts.CacheDir != "" && opts.CacheDir != s.cacheDir {
		if err := os.MkdirAll(opts.CacheDir, 0o755); err != nil {
			return fmt.Errorf("create new cache dir: %w", err)
		}
		s.cacheDir = opts.CacheDir
	}
	return nil
}

// ---- 辅助：避免引入 jpeg encoder 时的循环依赖噪音 ----

func encodeJPEG(img image.Image, quality int) ([]byte, error) {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
