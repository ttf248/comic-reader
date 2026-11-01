package services

import (
	"os"
	"testing"

	"github.com/disintegration/imaging"
)

// 缩略图生成的性能基线：解码 → 缩放 → 编码。
//
// 大尺寸原图（手机/相机常见的 12MP 以上）解码是主要成本，缩放滤波器的
// 选择次之。这里记录对照数据，为缩略图管线的性能调整提供依据。
//
// 用法：
//
//	THUMB_BENCH_FILE="E:/存照/2012年/DSC00811.JPG" \
//	  go test ./internal/services/ -run XXX -bench BenchmarkThumbnail -benchtime 5x -v
//
// 未设置 THUMB_BENCH_FILE 时跳过（仓库不提交测试素材）。
func BenchmarkThumbnail(b *testing.B) {
	path := os.Getenv("THUMB_BENCH_FILE")
	if path == "" {
		b.Skip("设置 THUMB_BENCH_FILE 指向一张真实原图后再跑基准")
	}
	img, err := imaging.Open(path, imaging.AutoOrientation(true))
	if err != nil {
		b.Skipf("无法解码 %s: %v", path, err)
	}
	b.Logf("原图尺寸: %dx%d", img.Bounds().Dx(), img.Bounds().Dy())

	b.Run("Decode", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			if _, err := imaging.Open(path, imaging.AutoOrientation(true)); err != nil {
				b.Fatal(err)
			}
		}
	})

	filters := []struct {
		name   string
		filter imaging.ResampleFilter
	}{
		{"Lanczos", imaging.Lanczos},
		{"CatmullRom", imaging.CatmullRom},
		{"Linear", imaging.Linear},
		{"Box", imaging.Box},
	}
	for _, f := range filters {
		b.Run("Resize_"+f.name, func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				thumb := imaging.Fit(img, 320, 350, f.filter)
				if _, err := encodeJPEG(thumb, jpegQuality); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
