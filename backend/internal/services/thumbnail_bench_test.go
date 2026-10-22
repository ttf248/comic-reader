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
