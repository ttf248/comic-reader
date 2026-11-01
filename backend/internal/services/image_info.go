package services

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"strings"
	"time"

	// Register WebP/BMP/TIFF decoders
	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
)

// ImageInfo 描述图片的元数据。
type ImageInfo struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Dir      string `json:"dir"`
	Size     int64  `json:"size"`
	MTime    string `json:"mtime"` // RFC3339
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	Format   string `json:"format"`   // jpeg/png/...
	Checksum string `json:"checksum"` // sha256 前 16 位
}

// GetImageInfo 读取指定图片的基本信息。
// 文件不存在或无法解码返回错误。
//
// HEIC/HEIF 当前不支持尺寸探测（需要 libde265 CGO 依赖）；
// 走 stdlib + x/image。
func GetImageInfo(absPath string) (*ImageInfo, error) {
	st, err := os.Stat(absPath)
	if err != nil {
		return nil, fmt.Errorf("stat: %w", err)
	}
	if !st.Mode().IsRegular() {
		return nil, ErrSourceMissing
	}

	// HEIC/HEIF：尺寸未知（返回 0），其它字段照常读取
	ext := strings.ToLower(filepath.Ext(absPath))
	if ext == ".heic" || ext == ".heif" {
		h := sha256.New()
		f2, err := os.Open(absPath)
		if err != nil {
			return nil, fmt.Errorf("open: %w", err)
		}
		defer f2.Close()
		buf := make([]byte, 64*1024)
		for {
			n, e := f2.Read(buf)
			if n > 0 {
				h.Write(buf[:n])
			}
			if e != nil {
				break
			}
		}
		return &ImageInfo{
			Path:     absPath,
			Name:     filepath.Base(absPath),
			Dir:      filepath.Dir(absPath),
			Size:     st.Size(),
			MTime:    st.ModTime().UTC().Format(time.RFC3339),
			Width:    0,
			Height:   0,
			Format:   strings.TrimPrefix(ext, "."),
			Checksum: hex.EncodeToString(h.Sum(nil))[:16],
		}, nil
	}

	// 解码图片获取尺寸/格式
	f, err := os.Open(absPath)
	if err != nil {
		return nil, fmt.Errorf("open: %w", err)
	}
	defer f.Close()

	cfg, format, err := image.DecodeConfig(f)
	if err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}

	// sha256 前 16 位
	h := sha256.New()
	if _, err := f.Seek(0, 0); err == nil {
		buf := make([]byte, 64*1024)
		for {
			n, e := f.Read(buf)
			if n > 0 {
				h.Write(buf[:n])
			}
			if e != nil {
				break
			}
		}
	}
	sum := hex.EncodeToString(h.Sum(nil))[:16]

	// 格式归一化
	if format == "" {
		format = strings.TrimPrefix(strings.ToLower(filepath.Ext(absPath)), ".")
	}

	return &ImageInfo{
		Path:     absPath,
		Name:     filepath.Base(absPath),
		Dir:      filepath.Dir(absPath),
		Size:     st.Size(),
		MTime:    st.ModTime().UTC().Format(time.RFC3339),
		Width:    cfg.Width,
		Height:   cfg.Height,
		Format:   format,
		Checksum: sum,
	}, nil
}
