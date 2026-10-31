package services

import (
	"os"
	"sort"
	"sync"
	"testing"
	"time"
)

// VIDEO_INFO_BENCH_FILE 仅供性能测试选择只读样本；未指定时使用临时合成视频。
// 固定调用数：go test ./internal/services -run '^$' -bench BenchmarkVideoInfoRepeated -benchtime=32x -count=3 -benchmem
func BenchmarkVideoInfoRepeated(b *testing.B) {
	for _, workers := range []int{1, 4} {
		name := "Sequential"
		if workers == 4 {
			name = "FourWorkers"
		}
		b.Run(name, func(b *testing.B) { benchmarkVideoInfoRepeated(b, workers) })
	}
}

func benchmarkVideoInfoRepeated(b *testing.B, workers int) {
	ffmpeg := findFFmpeg(b)
	path := os.Getenv("VIDEO_INFO_BENCH_FILE")
	if path == "" {
		path = generateTestVideo(b, ffmpeg)
	}
	info, err := os.Stat(path)
	if err != nil {
		b.Fatal("无法读取性能测试样本")
	}
	svc := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ffmpeg})
	meta, err := svc.Probe(path)
	if err != nil || meta == nil {
		b.Fatal("无法探测性能测试样本")
	}
	// 预热文件系统及服务；计时区间只包含同一未修改文件的重复查询。
	times := make([]time.Duration, b.N)
	jobs := make(chan int)
	var wg sync.WaitGroup
	b.ReportAllocs()
	b.ResetTimer()
	started := time.Now()
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				start := time.Now()
				if _, err := svc.Probe(path); err != nil {
					b.Error("重复视频探测失败")
				}
				times[index] = time.Since(start)
			}
		}()
	}
	for index := range times {
		jobs <- index
	}
	close(jobs)
	wg.Wait()
	elapsed := time.Since(started)
	b.StopTimer()
	sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
	b.ReportMetric(float64(b.N)/elapsed.Seconds(), "probes/s")
	b.ReportMetric(float64(times[(95*b.N+99)/100-1].Nanoseconds())/1e6, "p95-ms")
	b.ReportMetric(float64(info.Size())/(1024*1024), "sample-MiB")
}
