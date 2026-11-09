package store

import (
	"fmt"
	"github.com/tianlongxiang/local-gallery/internal/models"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

func benchmarkActivityStore(b *testing.B, size int) *ActivityStore {
	b.Helper()
	s := NewActivityStore(filepath.Join(b.TempDir(), "activity.json"))
	s.items = map[string]models.Activity{}
	s.loaded = true
	stamp := time.Now().UTC()
	for i := 0; i < size; i++ {
		a := models.Activity{AlbumID: batchAlbumID(i), MediaKind: models.MediaKindImage, PageCount: 3, PageIndex: 0, Status: models.ActivityInProgress, Updated: stamp}
		key, _ := a.Identity().Key()
		s.items[key] = a
	}
	if err := s.commitLocked(s.items); err != nil {
		b.Fatal(err)
	}
	return s
}
func BenchmarkActivityWrites(b *testing.B) {
	for _, size := range []int{1000, 10000, 100000} {
		for _, changed := range []bool{false, true} {
			b.Run(fmt.Sprintf("records=%d/changed=%t", size, changed), func(b *testing.B) {
				s := benchmarkActivityStore(b, size)
				durations := make([]time.Duration, 0, b.N)
				b.ReportAllocs()
				b.ResetTimer()
				startAll := b.Elapsed()
				for i := 0; i < b.N; i++ {
					index := 0
					if changed {
						index = 1 + i%2
					}
					start := b.Elapsed()
					if err := s.Set(models.Activity{AlbumID: batchAlbumID(0), MediaKind: models.MediaKindImage, PageCount: 3, PageIndex: index}); err != nil {
						b.Fatal(err)
					}
					durations = append(durations, b.Elapsed()-start)
				}
				elapsed := b.Elapsed() - startAll
				b.StopTimer()
				sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
				b.ReportMetric(float64(durations[(len(durations)-1)*95/100].Nanoseconds()), "p95-ns")
				b.ReportMetric(float64(b.N)/elapsed.Seconds(), "writes/s")
			})
		}
	}
}
func BenchmarkActivityReadWhileRepeatedWrites(b *testing.B) {
	s := benchmarkActivityStore(b, 100000)
	durations := make([]time.Duration, 0, b.N)
	done := make(chan error, 1)
	start := make(chan struct{})
	b.ResetTimer()
	go func() {
		<-start
		for i := 0; i < b.N; i++ {
			if err := s.Set(models.Activity{AlbumID: batchAlbumID(0), MediaKind: models.MediaKindImage, PageCount: 3}); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	close(start)
	for i := 0; i < b.N; i++ {
		before := b.Elapsed()
		if _, _, err := s.Get(models.ActivityIdentity{AlbumID: batchAlbumID(0), MediaKind: models.MediaKindImage}); err != nil {
			b.Fatal(err)
		}
		durations = append(durations, b.Elapsed()-before)
	}
	if err := <-done; err != nil {
		b.Fatal(err)
	}
	b.StopTimer()
	sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
	b.ReportMetric(float64(durations[(len(durations)-1)*95/100].Nanoseconds()), "read-p95-ns")
}
