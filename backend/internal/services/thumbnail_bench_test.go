package services

import (
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/disintegration/imaging"
)

// BenchmarkThumbnailCold 使用合成 2048×2048 JPEG，8 个请求 worker，全部冷缓存。
// 推荐固定样本：go test ./internal/services -run '^$' -bench BenchmarkThumbnailCold -benchtime=24x -benchmem
func BenchmarkThumbnailCold(b *testing.B) {
	dir := b.TempDir()
	img := image.NewRGBA(image.Rect(0, 0, 2048, 2048))
	for y := 0; y < 2048; y++ {
		for x := 0; x < 2048; x++ {
			img.SetRGBA(x, y, color.RGBA{uint8(x * y), uint8(x + y), uint8(y * 3), 255})
		}
	}
	paths := make([]string, b.N)
	for i := range paths {
		paths[i] = filepath.Join(dir, fmt.Sprintf("%d.jpg", i))
		f, err := os.Create(paths[i])
		if err != nil {
			b.Fatal(err)
		}
		if err := jpeg.Encode(f, img, nil); err != nil {
			b.Fatal(err)
		}
		f.Close()
	}
	img = nil
	runtime.GC()
	svc, err := NewThumbnailService(ThumbnailOptions{CacheDir: filepath.Join(dir, "cache"), Width: 320, Height: 350})
	if err != nil {
		b.Fatal(err)
	}
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	base, peak := stats.HeapAlloc, stats.HeapAlloc
	done, sampled := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(sampled)
		ticker := time.NewTicker(2 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				runtime.ReadMemStats(&stats)
				if stats.HeapAlloc > peak {
					peak = stats.HeapAlloc
				}
			}
		}
	}()
	times := make([]time.Duration, b.N)
	jobs := make(chan int)
	var wg sync.WaitGroup
	b.ResetTimer()
	start := time.Now()
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				t := time.Now()
				if _, err := svc.GetOrCreate(paths[i]); err != nil {
					b.Error(err)
				}
				times[i] = time.Since(t)
			}
		}()
	}
	for i := range paths {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	elapsed := time.Since(start)
	b.StopTimer()
	close(done)
	<-sampled
	sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
	b.ReportMetric(float64(b.N)/elapsed.Seconds(), "images/s")
	b.ReportMetric(float64(times[(95*b.N+99)/100-1].Microseconds())/1000, "p95-ms")
	b.ReportMetric(float64(peak-base)/(1024*1024), "peak-heap-MiB")
}

// BenchmarkThumbnail 用真实原图测量解码与各缩放滤波器的耗时对照，
// 为缩略图管线的性能调整提供依据（大原图解码是主要成本，缩放滤波器次之）。
//
// 用法：
//
//	THUMB_BENCH_FILE="E:/存照/2012年/DSC00811.JPG" \
//	  go test ./internal/services -run XXX -bench BenchmarkThumbnail -benchtime 5x -v
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

	// 缩略图实际使用的路径：先 Box 预缩放，再 Lanczos。
	b.Run("FitToThumbnail", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			thumb := fitToThumbnail(img, 320, 350)
			if _, err := encodeJPEG(thumb, jpegQuality); err != nil {
				b.Fatal(err)
			}
		}
	})
}
