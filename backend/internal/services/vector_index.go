package services

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	AIEmbeddingDimension   = 512
	vectorManifestVersion  = 1
	vectorCompactAtShards  = 128
	vectorCompactShardSize = 512
)

var ErrVectorDimension = errors.New("vector dimension does not match the model")

// VectorMetadata 是向量索引的轻量记录；媒体路径不进入向量索引。
type VectorMetadata struct {
	ResourceID   string    `json:"resourceId"`
	Size         int64     `json:"size"`
	MTimeNs      int64     `json:"mtimeNs"`
	ModelVersion string    `json:"modelVersion"`
	ShardID      string    `json:"shardId"`
	Position     int       `json:"position"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

type VectorRef struct {
	ShardID  string `json:"shardId"`
	Position int    `json:"position"`
}

type VectorIndexStatus struct {
	ModelVersion string `json:"modelVersion"`
	Dimension    int    `json:"dimension"`
	Vectors      int    `json:"vectors"`
	Shards       int    `json:"shards"`
	IndexVersion int    `json:"indexVersion"`
	Ready        bool   `json:"ready"`
}

type vectorIndexManifest struct {
	Version      int                 `json:"version"`
	Dimension    int                 `json:"dimension"`
	ModelVersion string              `json:"modelVersion"`
	Shards       []vectorShardRecord `json:"shards"`
}

type vectorShardRecord struct {
	ID             string `json:"id"`
	Count          int    `json:"count"`
	DataSHA256     string `json:"dataSha256"`
	MetadataSHA256 string `json:"metadataSha256"`
	Compacted      bool   `json:"compacted,omitempty"`
}

type vectorShardData struct {
	values []uint16
}

type VectorInput struct {
	ResourceID string
	Size       int64
	MTimeNs    int64
	Vector     []float32
}

type VectorHit struct {
	ResourceID string  `json:"resourceId"`
	Score      float64 `json:"score"`
}

// VectorIndexStore 保存 Float16 分片；每片的 metadata.jsonl 与向量数据同目录，
// manifest 最后原子发布，确保检索只看完整分片。
type VectorIndexStore struct {
	mu                sync.RWMutex
	dir               string
	modelVersion      string
	manifest          vectorIndexManifest
	shards            map[string]vectorShardData
	latest            map[string]VectorMetadata
	uncompactedShards int
	compactCh         chan struct{}
	closeCh           chan struct{}
	closed            chan struct{}
}

func OpenVectorIndex(dir, modelVersion string) (*VectorIndexStore, error) {
	if dir == "" || strings.TrimSpace(modelVersion) == "" {
		return nil, errors.New("vector index requires a directory and model version")
	}
	store := &VectorIndexStore{
		dir: dir, modelVersion: modelVersion,
		shards: make(map[string]vectorShardData), latest: make(map[string]VectorMetadata),
		compactCh: make(chan struct{}, 1), closeCh: make(chan struct{}), closed: make(chan struct{}),
	}
	if err := os.MkdirAll(filepath.Join(dir, "shards"), 0o755); err != nil {
		return nil, fmt.Errorf("create vector shard directory: %w", err)
	}
	manifestPath := filepath.Join(dir, "manifest.json")
	data, err := os.ReadFile(manifestPath)
	if errors.Is(err, os.ErrNotExist) {
		store.manifest = emptyVectorManifest(modelVersion)
		if err := writeAIJSONAtomic(manifestPath, store.manifest); err != nil {
			return nil, fmt.Errorf("initialize vector manifest: %w", err)
		}
	} else if err != nil {
		return nil, fmt.Errorf("read vector manifest: %w", err)
	} else {
		if err := json.Unmarshal(data, &store.manifest); err != nil {
			return nil, fmt.Errorf("decode vector manifest: %w", err)
		}
		if store.manifest.Version != vectorManifestVersion || store.manifest.Dimension != AIEmbeddingDimension || store.manifest.ModelVersion != modelVersion {
			store.manifest = emptyVectorManifest(modelVersion)
			if err := writeAIJSONAtomic(manifestPath, store.manifest); err != nil {
				return nil, fmt.Errorf("reset incompatible vector manifest: %w", err)
			}
		}
	}
	if store.manifest.Shards == nil {
		store.manifest.Shards = []vectorShardRecord{}
	}
	for _, shard := range store.manifest.Shards {
		if err := store.loadShard(shard); err != nil {
			return nil, err
		}
		if !shard.Compacted {
			store.uncompactedShards++
		}
	}
	store.removeUnpublishedShards()
	go store.compactionLoop()
	return store, nil
}

func emptyVectorManifest(modelVersion string) vectorIndexManifest {
	return vectorIndexManifest{Version: vectorManifestVersion, Dimension: AIEmbeddingDimension, ModelVersion: modelVersion, Shards: []vectorShardRecord{}}
}

func (s *VectorIndexStore) loadShard(record vectorShardRecord) error {
	if record.ID == "" || filepath.Base(record.ID) != record.ID || record.Count <= 0 || record.Count > vectorCompactShardSize*1024 {
		return errors.New("vector manifest contains an invalid shard")
	}
	root := filepath.Join(s.dir, "shards", record.ID)
	dataPath := filepath.Join(root, "vectors.f16")
	metadataPath := filepath.Join(root, "metadata.jsonl")
	data, err := os.ReadFile(dataPath)
	if err != nil {
		return fmt.Errorf("read vector shard: %w", err)
	}
	metadataBytes, err := os.ReadFile(metadataPath)
	if err != nil {
		return fmt.Errorf("read vector metadata: %w", err)
	}
	if hashBytes(data) != record.DataSHA256 || hashBytes(metadataBytes) != record.MetadataSHA256 {
		return fmt.Errorf("vector shard checksum mismatch: %s", record.ID)
	}
	vectorBytes := AIEmbeddingDimension * 2
	if len(data) != record.Count*vectorBytes {
		return fmt.Errorf("vector shard length mismatch: %s", record.ID)
	}
	metadata := make([]VectorMetadata, 0, record.Count)
	scanner := bufio.NewScanner(strings.NewReader(string(metadataBytes)))
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		var item VectorMetadata
		if err := json.Unmarshal(scanner.Bytes(), &item); err != nil {
			return fmt.Errorf("decode vector metadata: %w", err)
		}
		metadata = append(metadata, item)
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read vector metadata: %w", err)
	}
	if len(metadata) != record.Count {
		return fmt.Errorf("vector metadata count mismatch: %s", record.ID)
	}
	values := make([]uint16, len(data)/2)
	for index := range values {
		values[index] = binary.LittleEndian.Uint16(data[index*2 : index*2+2])
	}
	for index, item := range metadata {
		if item.ResourceID == "" || item.ModelVersion != s.modelVersion || item.ShardID != record.ID || item.Position != index || item.Size < 0 {
			return fmt.Errorf("vector metadata is inconsistent: %s", record.ID)
		}
		current, exists := s.latest[item.ResourceID]
		if !exists || !item.UpdatedAt.Before(current.UpdatedAt) {
			s.latest[item.ResourceID] = item
		}
	}
	s.shards[record.ID] = vectorShardData{values: values}
	return nil
}

func (s *VectorIndexStore) removeUnpublishedShards() {
	keep := make(map[string]struct{}, len(s.manifest.Shards))
	for _, record := range s.manifest.Shards {
		keep[record.ID] = struct{}{}
	}
	entries, err := os.ReadDir(filepath.Join(s.dir, "shards"))
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if strings.HasPrefix(entry.Name(), ".vector-") {
			_ = os.RemoveAll(filepath.Join(s.dir, "shards", entry.Name()))
			continue
		}
		if _, exists := keep[entry.Name()]; !exists {
			_ = os.RemoveAll(filepath.Join(s.dir, "shards", entry.Name()))
		}
	}
}

func (s *VectorIndexStore) Commit(ctx context.Context, inputs []VectorInput) error {
	if len(inputs) == 0 {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	metadata := make([]VectorMetadata, len(inputs))
	values := make([]uint16, len(inputs)*AIEmbeddingDimension)
	data := make([]byte, len(values)*2)
	metadataJSONL := make([]byte, 0, len(inputs)*160)
	now := time.Now().UTC()
	for index, input := range inputs {
		if input.ResourceID == "" || input.Size < 0 || len(input.Vector) != AIEmbeddingDimension {
			return ErrVectorDimension
		}
		norm := 0.0
		for _, value := range input.Vector {
			if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
				return errors.New("vector contains a non-finite value")
			}
			norm += float64(value * value)
		}
		if norm == 0 {
			return errors.New("vector has zero magnitude")
		}
		scale := float32(1 / math.Sqrt(norm))
		for column, value := range input.Vector {
			half := float32ToHalf(value * scale)
			values[index*AIEmbeddingDimension+column] = half
			binary.LittleEndian.PutUint16(data[(index*AIEmbeddingDimension+column)*2:], half)
		}
		metadata[index] = VectorMetadata{
			ResourceID: input.ResourceID, Size: input.Size, MTimeNs: input.MTimeNs,
			ModelVersion: s.modelVersion, Position: index, UpdatedAt: now,
		}
	}
	shardID := uuid.NewString()
	for index := range metadata {
		metadata[index].ShardID = shardID
		line, err := json.Marshal(metadata[index])
		if err != nil {
			return err
		}
		metadataJSONL = append(metadataJSONL, line...)
		metadataJSONL = append(metadataJSONL, '\n')
	}
	shard, err := writeVectorShard(s.dir, shardID, data, metadataJSONL, len(inputs))
	if err != nil {
		return err
	}
	next := s.manifest
	next.Shards = append(append([]vectorShardRecord(nil), s.manifest.Shards...), shard)
	if err := writeAIJSONAtomic(filepath.Join(s.dir, "manifest.json"), next); err != nil {
		_ = os.RemoveAll(filepath.Join(s.dir, "shards", shardID))
		return fmt.Errorf("publish vector shard: %w", err)
	}
	s.manifest = next
	s.shards[shardID] = vectorShardData{values: values}
	s.uncompactedShards++
	for _, item := range metadata {
		s.latest[item.ResourceID] = item
	}
	if s.uncompactedShards >= vectorCompactAtShards {
		select {
		case s.compactCh <- struct{}{}:
		default:
		}
	}
	return nil
}

func writeVectorShard(root, id string, data, metadata []byte, count int) (vectorShardRecord, error) {
	shardsDir := filepath.Join(root, "shards")
	temporary := filepath.Join(shardsDir, ".vector-"+id+".tmp")
	final := filepath.Join(shardsDir, id)
	if err := os.MkdirAll(temporary, 0o755); err != nil {
		return vectorShardRecord{}, err
	}
	if err := writeSyncedFile(filepath.Join(temporary, "vectors.f16"), data); err != nil {
		_ = os.RemoveAll(temporary)
		return vectorShardRecord{}, err
	}
	if err := writeSyncedFile(filepath.Join(temporary, "metadata.jsonl"), metadata); err != nil {
		_ = os.RemoveAll(temporary)
		return vectorShardRecord{}, err
	}
	if err := os.Rename(temporary, final); err != nil {
		_ = os.RemoveAll(temporary)
		return vectorShardRecord{}, err
	}
	return vectorShardRecord{ID: id, Count: count, DataSHA256: hashBytes(data), MetadataSHA256: hashBytes(metadata)}, nil
}

func writeSyncedFile(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func hashBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func (s *VectorIndexStore) Current(resourceID string, size, mtimeNs int64) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	metadata, exists := s.latest[resourceID]
	if !exists || metadata.Size != size || metadata.MTimeNs != mtimeNs || metadata.ModelVersion != s.modelVersion {
		return false
	}
	_, exists = s.shards[metadata.ShardID]
	return exists
}

func (s *VectorIndexStore) Metadata() []VectorMetadata {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]VectorMetadata, 0, len(s.latest))
	for _, item := range s.latest {
		result = append(result, item)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ResourceID < result[j].ResourceID })
	return result
}

func (s *VectorIndexStore) Search(query []float32, candidates []VectorMetadata, offset, limit int) ([]VectorHit, int, error) {
	if len(query) != AIEmbeddingDimension {
		return nil, 0, ErrVectorDimension
	}
	if offset < 0 || limit <= 0 {
		return []VectorHit{}, 0, nil
	}
	queryNorm := 0.0
	for _, value := range query {
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			return nil, 0, errors.New("query vector contains a non-finite value")
		}
		queryNorm += float64(value * value)
	}
	if queryNorm == 0 {
		return nil, 0, errors.New("query vector has zero magnitude")
	}
	queryScale := float32(1 / math.Sqrt(queryNorm))
	s.mu.RLock()
	defer s.mu.RUnlock()
	hits := make([]VectorHit, 0, len(candidates))
	for _, metadata := range candidates {
		current, exists := s.latest[metadata.ResourceID]
		if !exists || current.Size != metadata.Size || current.MTimeNs != metadata.MTimeNs || current.ModelVersion != metadata.ModelVersion {
			continue
		}
		metadata = current
		shard, exists := s.shards[metadata.ShardID]
		if !exists || metadata.Position < 0 || (metadata.Position+1)*AIEmbeddingDimension > len(shard.values) {
			continue
		}
		score := 0.0
		start := metadata.Position * AIEmbeddingDimension
		for column, component := range query {
			score += float64(component*queryScale) * float64(halfToFloat32(shard.values[start+column]))
		}
		hits = append(hits, VectorHit{ResourceID: metadata.ResourceID, Score: score})
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		return hits[i].ResourceID < hits[j].ResourceID
	})
	total := len(hits)
	if offset >= total {
		return []VectorHit{}, total, nil
	}
	end := min(offset+limit, total)
	return hits[offset:end], total, nil
}

func (s *VectorIndexStore) Status() VectorIndexStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return VectorIndexStatus{
		ModelVersion: s.modelVersion, Dimension: AIEmbeddingDimension,
		Vectors: len(s.latest), Shards: len(s.manifest.Shards), IndexVersion: vectorManifestVersion,
		Ready: len(s.latest) > 0,
	}
}

func (s *VectorIndexStore) compact() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.uncompactedShards < vectorCompactAtShards {
		return nil
	}
	items := make([]VectorMetadata, 0, len(s.latest))
	for _, item := range s.latest {
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ResourceID < items[j].ResourceID })
	newManifest := emptyVectorManifest(s.modelVersion)
	newShards := make(map[string]vectorShardData)
	newLatest := make(map[string]VectorMetadata, len(items))
	for start := 0; start < len(items); start += vectorCompactShardSize {
		end := min(start+vectorCompactShardSize, len(items))
		if err := s.compactChunk(items[start:end], &newManifest, newShards, newLatest); err != nil {
			for _, shard := range newManifest.Shards {
				_ = os.RemoveAll(filepath.Join(s.dir, "shards", shard.ID))
			}
			return err
		}
	}
	if err := writeAIJSONAtomic(filepath.Join(s.dir, "manifest.json"), newManifest); err != nil {
		for _, shard := range newManifest.Shards {
			_ = os.RemoveAll(filepath.Join(s.dir, "shards", shard.ID))
		}
		return err
	}
	old := s.manifest
	s.manifest, s.shards, s.latest = newManifest, newShards, newLatest
	s.uncompactedShards = 0
	for _, shard := range old.Shards {
		_ = os.RemoveAll(filepath.Join(s.dir, "shards", shard.ID))
	}
	return nil
}

func (s *VectorIndexStore) compactChunk(items []VectorMetadata, manifest *vectorIndexManifest, shards map[string]vectorShardData, latest map[string]VectorMetadata) error {
	if len(items) == 0 {
		return nil
	}
	id := uuid.NewString()
	data := make([]byte, len(items)*AIEmbeddingDimension*2)
	metadataBytes := make([]byte, 0, len(items)*160)
	values := make([]uint16, len(items)*AIEmbeddingDimension)
	for index, item := range items {
		oldShard, exists := s.shards[item.ShardID]
		if !exists || item.Position < 0 {
			return errors.New("cannot compact a missing vector shard")
		}
		start := item.Position * AIEmbeddingDimension
		if start+AIEmbeddingDimension > len(oldShard.values) {
			return errors.New("cannot compact an invalid vector position")
		}
		for column, value := range oldShard.values[start : start+AIEmbeddingDimension] {
			values[index*AIEmbeddingDimension+column] = value
			binary.LittleEndian.PutUint16(data[(index*AIEmbeddingDimension+column)*2:], value)
		}
		item.ShardID, item.Position = id, index
		line, err := json.Marshal(item)
		if err != nil {
			return err
		}
		metadataBytes = append(metadataBytes, line...)
		metadataBytes = append(metadataBytes, '\n')
		latest[item.ResourceID] = item
	}
	record, err := writeVectorShard(s.dir, id, data, metadataBytes, len(items))
	if err != nil {
		return err
	}
	record.Compacted = true
	manifest.Shards = append(manifest.Shards, record)
	shards[id] = vectorShardData{values: values}
	return nil
}

func (s *VectorIndexStore) compactionLoop() {
	defer close(s.closed)
	for {
		select {
		case <-s.closeCh:
			return
		case <-s.compactCh:
			_ = s.compact()
		}
	}
}

func (s *VectorIndexStore) Close() {
	select {
	case <-s.closeCh:
	default:
		close(s.closeCh)
	}
	<-s.closed
}

func float32ToHalf(value float32) uint16 {
	bits := math.Float32bits(value)
	sign := uint16(bits >> 16 & 0x8000)
	exponent := int((bits >> 23) & 0xff)
	mantissa := bits & 0x7fffff
	if exponent == 0xff {
		if mantissa == 0 {
			return sign | 0x7c00
		}
		return sign | 0x7e00
	}
	newExponent := exponent - 127 + 15
	if newExponent >= 31 {
		return sign | 0x7c00
	}
	if newExponent <= 0 {
		if newExponent < -10 {
			return sign
		}
		mantissa |= 0x800000
		shift := uint(14 - newExponent)
		rounded := mantissa >> shift
		if (mantissa>>(shift-1))&1 != 0 && (mantissa&((1<<(shift-1))-1) != 0 || rounded&1 != 0) {
			rounded++
		}
		return sign | uint16(rounded)
	}
	rounded := mantissa >> 13
	if mantissa&0x1000 != 0 && (mantissa&0x1fff != 0x1000 || rounded&1 != 0) {
		rounded++
		if rounded == 0x400 {
			rounded = 0
			newExponent++
			if newExponent >= 31 {
				return sign | 0x7c00
			}
		}
	}
	return sign | uint16(newExponent<<10) | uint16(rounded)
}

func halfToFloat32(value uint16) float32 {
	sign := uint32(value&0x8000) << 16
	exponent := int((value >> 10) & 0x1f)
	mantissa := uint32(value & 0x03ff)
	var bits uint32
	switch exponent {
	case 0:
		if mantissa == 0 {
			bits = sign
		} else {
			exponent = 1
			for mantissa&0x0400 == 0 {
				mantissa <<= 1
				exponent--
			}
			mantissa &= 0x03ff
			bits = sign | uint32(exponent+112)<<23 | mantissa<<13
		}
	case 0x1f:
		bits = sign | 0x7f800000 | mantissa<<13
	default:
		bits = sign | uint32(exponent+112)<<23 | mantissa<<13
	}
	return math.Float32frombits(bits)
}
