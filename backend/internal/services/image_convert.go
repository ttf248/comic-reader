package services

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// ErrImageConvertUnavailable 表示 ffmpeg 不可用，或无法处理该图片。
//
// 与 ErrFFmpegUnavailable 同属"可选依赖缺失"语义：调用方应回退到
// "不支持的格式"处理，而不是报错。
var ErrImageConvertUnavailable = errors.New("image conversion unavailable")

// ImageConverter 用 ffmpeg 把纯 Go 解码器不支持的图片格式转成缩略图 JPEG。
//
// 目前真正需要的是 iPhone 的 HEIC/HEIF：扫描器按扩展名白名单把 .heic
// 收进媒体库，但 Go 标准库与 imaging 都解不了 HEIC，结果这类照片在
// 相册里全部显示成破图（/api/thumbs 返回 415）。ffmpeg 自带 heif
// 解码器，可以直接转成 JPEG。
//
// ffmpeg 是可选依赖：不可用时 Convert 返回 ErrImageConvertUnavailable，
// 调用方继续按"不支持的格式"处理（前端显示占位图而不是破图）。
type ImageConverter struct {
	ffmpegPath string
	width      int
	height     int
	quality    int
	timeout    time.Duration
	// scaleW/scaleH 是 ffmpeg 侧的解码尺寸（默认缩略图的两倍），
	// 留出余量给 Go 侧再做一次高质量缩放。
	scaleW int
	scaleH int

	// 可用性探测缓存：整个 service 生命周期只跑一次 `ffmpeg -version`。
	availOnce sync.Once
	avail     bool
}

// ImageConverterOptions 构造选项。
type ImageConverterOptions struct {
	FFmpegPath  string        // ffmpeg 可执行文件路径；为空则不可用
	Width       int           // 缩略图宽度，默认 320
	Height      int           // 缩略图高度，默认 350
	Quality     int           // JPEG 质量 1-100，默认 85
	Timeout     time.Duration // 单次转换超时，默认 10s
	ScaleWidth  int           // 内部解码尺寸，默认宽高的两倍
	ScaleHeight int
}

// NewImageConverter 构造转换器。FFmpegPath 为空时构造仍成功，
// 但 Available()=false，Convert 一律返回 ErrImageConvertUnavailable。
func NewImageConverter(opts ImageConverterOptions) *ImageConverter {
	w := opts.Width
	if w <= 0 {
		w = 320
	}
	h := opts.Height
	if h <= 0 {
		h = 350
	}
	q := opts.Quality
	if q <= 0 {
		q = jpegQuality
	}
	t := opts.Timeout
	if t <= 0 {
		t = 10 * time.Second
	}
	sw := opts.ScaleWidth
	if sw <= 0 {
		sw = 2 * w
	}
	sh := opts.ScaleHeight
	if sh <= 0 {
		sh = 2 * h
	}
	return &ImageConverter{
		ffmpegPath: opts.FFmpegPath,
		width:      w,
		height:     h,
		quality:    q,
		timeout:    t,
		scaleW:     sw,
		scaleH:     sh,
	}
}

// Available 返回 ffmpeg 是否可用（只探测一次）。
func (c *ImageConverter) Available() bool {
	if c == nil || c.ffmpegPath == "" {
		return false
	}
	c.availOnce.Do(func() {
		cmd := exec.Command(c.ffmpegPath, "-version")
		c.avail = cmd.Run() == nil
	})
	return c.avail
}

// Convert 把图片转成可解码的位图（HEIC/HEIF → JPEG）。
//
// 返回的是解码后的图像，缩放与编码仍由缩略图服务统一走同一条路径，
// 保证 HEIC 缩略图与其它格式的尺寸、质量完全一致。
//
// 失败时返回 ErrImageConvertUnavailable（ffmpeg 不可用 / 转换失败），
// 调用方应回退到"不支持的格式"。
func (c *ImageConverter) Convert(absPath string) (image.Image, error) {
	img, _, err := c.convert(absPath, c.scaleW, c.scaleH)
	return img, err
}

// ConvertJPEGBytes 把图片转成 JPEG 字节，最长边不超过 maxDim。
//
// 与 Convert 的区别：不再解码回位图，直接返回 ffmpeg 编码好的 JPEG，
// 少一次解码 + 重编码，画质损失更小、内存占用也更低。用于"原图直出"
// 这类浏览器原生解不了的格式（HEIC/HEIF/TIFF）。
func (c *ImageConverter) ConvertJPEGBytes(absPath string, maxDim int) ([]byte, error) {
	if maxDim <= 0 {
		maxDim = 2560
	}
	_, out, err := c.convert(absPath, maxDim, maxDim)
	return out, err
}

// convert 统一执行 ffmpeg 转换：返回解码后的位图与原始 JPEG 字节。
func (c *ImageConverter) convert(absPath string, scaleW, scaleH int) (image.Image, []byte, error) {
	if !c.Available() {
		return nil, nil, ErrImageConvertUnavailable
	}
	ctx, cancel := context.WithTimeout(context.Background(), c.timeout)
	defer cancel()

	// HEIF/AVIF 的码流由多个帧组成，ffmpeg 会把它当作"复杂滤镜图"，
	// 因此这里必须用 -filter_complex + -map，-vf 会直接报错。
	filter := fmt.Sprintf(
		"[0:v:0]scale=%d:%d:force_original_aspect_ratio=decrease[v]",
		scaleW, scaleH,
	)
	cmd := exec.CommandContext(ctx, c.ffmpegPath,
		"-hide_banner",
		"-loglevel", "error",
		"-i", absPath,
		"-filter_complex", filter,
		"-map", "[v]",
		"-frames:v", "1",
		"-q:v", "2",
		"-f", "image2pipe",
		"-vcodec", "mjpeg",
		"-",
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if cmd.ProcessState == nil {
			return nil, nil, fmt.Errorf("%w: %s", ErrImageConvertUnavailable, err.Error())
		}
		if ctx.Err() == context.DeadlineExceeded {
			return nil, nil, fmt.Errorf("image convert timeout: %w", ctx.Err())
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, nil, fmt.Errorf("image convert: %s", msg)
	}
	out := stdout.Bytes()
	if len(out) == 0 {
		return nil, nil, fmt.Errorf("%w: empty output", ErrImageConvertUnavailable)
	}

	img, _, err := image.Decode(bytes.NewReader(out))
	if err != nil {
		return nil, nil, fmt.Errorf("decode converted image: %w", err)
	}
	return img, out, nil
}
