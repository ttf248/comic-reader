package services

import (
	"fmt"
	"math"
	"math/rand"
	"runtime"
	"sort"
	"testing"
	"time"
)

func BenchmarkVectorIndexSearch100K(b *testing.B) {
	const vectorCount = 100_000
	random := rand.New(rand.NewSource(20261113))
	values := make([]uint16, vectorCount*AIEmbeddingDimension)
	metadata := make(map[string]VectorMetadata, vectorCount)
	query := make([]float32, AIEmbeddingDimension)
	for index := range query {
		query[index] = random.Float32()*2 - 1
	}
	normalizeProfileVector(query)

	for row := 0; row < vectorCount; row++ {
		vector := make([]float32, AIEmbeddingDimension)
		var norm float64
		for column := range vector {
			vector[column] = random.Float32()*2 - 1
			norm += float64(vector[column] * vector[column])
		}
		scale := float32(1 / math.Sqrt(norm))
		for column, component := range vector {
			values[row*AIEmbeddingDimension+column] = float32ToHalf(component * scale)
		}
		resourceID := fmt.Sprintf("r-%06d", row)
		metadata[resourceID] = VectorMetadata{
			ResourceID: resourceID, Size: int64(row + 1), MTimeNs: int64(row + 1),
			ModelVersion: "profile-v1", ShardID: "all", Position: row,
		}
	}

	index := &VectorIndexStore{
		modelVersion: "profile-v1",
		shards:       map[string]vectorShardData{"all": {values: values}},
		latest:       metadata,
	}
	candidates := make([]VectorMetadata, 0, vectorCount)
	for _, item := range metadata {
		candidates = append(candidates, item)
	}
	runtime.GC()
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	indexHeapBytes := memory.HeapAlloc

	b.ReportAllocs()
	b.ResetTimer()
	durations := make([]time.Duration, 0, b.N)
	for iteration := 0; iteration < b.N; iteration++ {
		started := time.Now()
		hits, total, err := index.Search(query, candidates, 0, 10)
		durations = append(durations, time.Since(started))
		if err != nil || total != vectorCount || len(hits) != 10 {
			b.Fatalf("Search() returned total=%d, hits=%d, error=%v", total, len(hits), err)
		}
		runtime.KeepAlive(hits)
	}
	b.StopTimer()
	sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
	b.ReportMetric(float64(durations[len(durations)*50/100].Nanoseconds()), "p50-ns/op")
	p95Index := int(math.Ceil(float64(len(durations))*0.95)) - 1
	b.ReportMetric(float64(durations[p95Index].Nanoseconds()), "p95-ns/op")
	b.ReportMetric(float64(indexHeapBytes), "index-heap-B")
	b.ReportMetric(float64(vectorCount), "vectors")
	runtime.KeepAlive(index)
}

func normalizeProfileVector(vector []float32) {
	var norm float64
	for _, component := range vector {
		norm += float64(component * component)
	}
	scale := float32(1 / math.Sqrt(norm))
	for index, component := range vector {
		vector[index] = component * scale
	}
}
