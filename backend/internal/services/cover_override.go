// CoverOverrideStore 持久化用户对每个 album 的人工封面设置。
//
// 持久化位置：cacheDir/cover_overrides.json。
//
//	key:   album 绝对路径（与 ScanResult.albums[i].path 一致）
//	value: 用户指定的封面文件绝对路径（必须在对应 album 目录里）
//
// 运行时每次从 ScanResult 拉数据都把 override 应用上；前端
// PUT/DELETE 改变 override 后，store 会重新生成应用后的 ScanResult
// 并写回 cache，前端下一次拉 scan 看到的就是新封面。
//
// 安全性：值永远受前端 + 后端双重校验，必须在对应 album 目录里，
// 越权访问会被拒绝（参见 handlers/albums.go 的 SetCover/路径安全检查）。
package services

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// CoverOverride 一条用户封面覆盖记录。
type CoverOverride struct {
	// File 用户选择的图片/视频绝对路径。必须 = CoverPath 字段
	// （handler 层验证 file 在 album path 内）。
	File string `json:"file"`
}

// CoverOverrideStore 持久化 + 内存存储用户封面覆盖。
type CoverOverrideStore struct {
	path string

	mu   sync.RWMutex
	data map[string]CoverOverride // key = album path
}

// NewCoverOverrideStore 创建 store，path 为磁盘 JSON 文件位置。
// 文件不存在不报错 — 当作"没有覆盖"。
func NewCoverOverrideStore(path string) *CoverOverrideStore {
	return &CoverOverrideStore{path: path, data: make(map[string]CoverOverride)}
}

// Load 从磁盘加载。如果文件不存在，store 保持空。
func (s *CoverOverrideStore) Load() error {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read cover overrides: %w", err)
	}
	var raw map[string]CoverOverride
	if err := json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("parse cover overrides: %w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data = make(map[string]CoverOverride, len(raw))
	for k, v := range raw {
		// 归一化路径分隔符，避免 Windows 上 '\\' vs '/' 引起的命中失败
		s.data[filepath.Clean(k)] = CoverOverride{File: filepath.Clean(v.File)}
	}
	return nil
}

// commitLocked 先原子落盘，再发布内存；失败保留原有封面状态。
func (s *CoverOverrideStore) commitLocked(next map[string]CoverOverride) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(s.path), ".covers-*.tmp")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if err = file.Chmod(0o600); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(name, s.path); err != nil {
		return err
	}
	s.data = next
	return nil
}

func (s *CoverOverrideStore) Set(albumPath, file string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.snapshotLocked()
	next[filepath.Clean(albumPath)] = CoverOverride{File: filepath.Clean(file)}
	return s.commitLocked(next)
}
func (s *CoverOverrideStore) Clear(albumPath string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.snapshotLocked()
	delete(next, filepath.Clean(albumPath))
	return s.commitLocked(next)
}

var ErrCoverStateChanged = errors.New("cover state changed since preview")

func (s *CoverOverrideStore) CompareAndReplace(expected, next map[string]CoverOverride) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !reflect.DeepEqual(s.data, expected) {
		return ErrCoverStateChanged
	}
	return s.commitLocked(next)
}
func (s *CoverOverrideStore) snapshotLocked() map[string]CoverOverride {
	next := make(map[string]CoverOverride, len(s.data))
	for key, value := range s.data {
		next[key] = value
	}
	return next
}

// Get 返回 album path 的覆盖（无则 nil）。
func (s *CoverOverrideStore) Get(albumPath string) *CoverOverride {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if v, ok := s.data[filepath.Clean(albumPath)]; ok {
		cp := v
		return &cp
	}
	return nil
}

// Snapshot 返回所有覆盖的浅拷贝（用于 ApplyToScanResult）。
func (s *CoverOverrideStore) Snapshot() map[string]CoverOverride {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]CoverOverride, len(s.data))
	for k, v := range s.data {
		out[k] = v
	}
	return out
}

// ApplyCoverOverridesToResult 将持久化的封面覆盖应用到一次新扫描结果。
// 只接受仍存在且已被该相册媒体列表收录的文件，旧记录不会把任意路径
// 带回资源索引。返回值是独立快照，可直接交给 catalog/cache 发布。
func ApplyCoverOverridesToResult(result *models.ScanResult, overrides map[string]CoverOverride) (*models.ScanResult, int) {
	if result == nil || len(overrides) == 0 {
		return result, 0
	}
	next := cloneScanResult(result)
	appliedPaths := make(map[string]struct{})
	replacedCovers := make(map[string]string)
	applyAlbum := func(album *models.Album) {
		key := filepath.Clean(album.Path)
		override, ok := overrides[key]
		if !ok || !albumContainsMedia(*album, override.File) {
			return
		}
		info, err := os.Stat(override.File)
		if err != nil || info.IsDir() {
			return
		}
		kind := models.FileMediaKind(override.File)
		if kind == "" {
			return
		}
		oldCover := album.CoverImage
		album.CoverImage = filepath.Clean(override.File)
		album.CoverKind = kind
		appliedPaths[key] = struct{}{}
		if oldCover != "" {
			replacedCovers[pathKindKey(oldCover, ResourceFile)] = album.CoverImage
		}
	}
	for i := range next.Albums {
		applyAlbum(&next.Albums[i])
	}
	var walkCollections func([]models.Collection)
	walkCollections = func(collections []models.Collection) {
		for i := range collections {
			for j := range collections[i].Albums {
				applyAlbum(&collections[i].Albums[j])
			}
			walkCollections(collections[i].Collections)
		}
	}
	walkCollections(next.Collections)
	for i := range next.SmartCollections {
		for j := range next.SmartCollections[i].Albums {
			applyAlbum(&next.SmartCollections[i].Albums[j])
		}
		if cover, ok := replacedCovers[pathKindKey(next.SmartCollections[i].CoverImage, ResourceFile)]; ok {
			next.SmartCollections[i].CoverImage = cover
		}
	}
	return next, len(appliedPaths)
}

// RebuildCoverView 先将所有相册恢复为扫描器的确定性默认封面，再叠加当前
// 覆盖集合。设置和清除封面因此共用同一条路径，不会遗留标签视图的旧封面。
func RebuildCoverView(result *models.ScanResult, overrides map[string]CoverOverride) (*models.ScanResult, int) {
	if result == nil {
		return nil, 0
	}
	base := cloneScanResult(result)
	resetAlbum := func(album *models.Album) {
		switch {
		case len(album.ImageFiles) > 0:
			album.CoverImage = album.ImageFiles[0]
			album.CoverKind = "image"
		case len(album.VideoFiles) > 0:
			album.CoverImage = album.VideoFiles[0]
			album.CoverKind = "video"
		default:
			album.CoverImage = ""
			album.CoverKind = ""
		}
	}
	for i := range base.Albums {
		resetAlbum(&base.Albums[i])
	}
	var walkCollections func([]models.Collection)
	walkCollections = func(collections []models.Collection) {
		for i := range collections {
			for j := range collections[i].Albums {
				resetAlbum(&collections[i].Albums[j])
			}
			walkCollections(collections[i].Collections)
		}
	}
	walkCollections(base.Collections)
	for i := range base.SmartCollections {
		for j := range base.SmartCollections[i].Albums {
			resetAlbum(&base.SmartCollections[i].Albums[j])
		}
		if len(base.SmartCollections[i].Albums) > 0 {
			base.SmartCollections[i].CoverImage = base.SmartCollections[i].Albums[0].CoverImage
		}
	}
	return ApplyCoverOverridesToResult(base, overrides)
}

func albumContainsMedia(album models.Album, candidate string) bool {
	target := pathKindKey(candidate, ResourceFile)
	for _, files := range [][]string{album.ImageFiles, album.VideoFiles} {
		for _, file := range files {
			if pathKindKey(file, ResourceFile) == target {
				return true
			}
		}
	}
	return false
}
