// Package services 提供本地画廊核心业务服务。
package services

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// ContentKindStore 持久化用户对单个相册的「内容用途」覆盖。
//
// 持久化位置：cacheDir/state/content_kinds.json。
//
//	key:   album 绝对路径（与扫描结果里的 album.path 一致）
//	value: "photo" / "comic"
//
// 覆盖优先级高于媒体根默认值：用户手动切换过的相册始终按用户的选择打开。
// 删掉覆盖后回落到媒体根默认值，再回落到全局默认值。
//
// 与封面覆盖（cover_overrides.json）一样，它属于「用户状态」而不是
// 「可重建缓存」，因此落在 state/ 而不是 derived/。
type ContentKindStore struct {
	path string

	mu   sync.RWMutex
	data map[string]models.ContentKind // key = album path
}

// NewContentKindStore 创建 store；path 为磁盘 JSON 文件位置。
// 文件不存在不算错误——当作「没有覆盖」。
func NewContentKindStore(path string) *ContentKindStore {
	return &ContentKindStore{path: path, data: make(map[string]models.ContentKind)}
}

// Load 从磁盘加载覆盖记录。文件不存在时 store 保持空。
func (s *ContentKindStore) Load() error {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read content kinds: %w", err)
	}
	var raw map[string]string
	if err := json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("parse content kinds: %w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data = make(map[string]models.ContentKind, len(raw))
	for key, value := range raw {
		if !models.IsValidContentKind(value) {
			continue
		}
		s.data[filepath.Clean(key)] = models.NormalizeContentKind(value)
	}
	return nil
}

// flush 写盘。空集合时删除文件，避免磁盘上留空文件。
func (s *ContentKindStore) flush() error {
	s.mu.RLock()
	cp := make(map[string]string, len(s.data))
	for k, v := range s.data {
		cp[k] = string(v)
	}
	s.mu.RUnlock()

	if len(cp) == 0 {
		if err := os.Remove(s.path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cp, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Set 设置 album path 的用途覆盖并落盘。
func (s *ContentKindStore) Set(albumPath string, kind models.ContentKind) error {
	albumPath = filepath.Clean(albumPath)
	s.mu.Lock()
	s.data[albumPath] = models.NormalizeContentKind(string(kind))
	s.mu.Unlock()
	return s.flush()
}

// Clear 删除 album path 的用途覆盖并落盘。
func (s *ContentKindStore) Clear(albumPath string) error {
	albumPath = filepath.Clean(albumPath)
	s.mu.Lock()
	delete(s.data, albumPath)
	s.mu.Unlock()
	return s.flush()
}

// Snapshot 返回所有覆盖的浅拷贝。
func (s *ContentKindStore) Snapshot() map[string]models.ContentKind {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]models.ContentKind, len(s.data))
	for k, v := range s.data {
		out[k] = v
	}
	return out
}

// ContentKindPolicy 描述内容用途的默认解析规则。
//
// 优先级：相册覆盖 > 媒体根默认值 > 全局默认值。
// Roots 用归一化后的媒体根绝对路径做键（Windows 下大小写不敏感）。
type ContentKindPolicy struct {
	Default models.ContentKind
	Roots   map[string]models.ContentKind
}

// NewContentKindPolicy 依据配置构造策略。
//
// defaultKind 是全局默认值（非法值回落 photo）；rootKinds 是「媒体根路径 →
// 用途」的用户配置，键可以是相对路径、大小写不同或带尾斜杠；只有命中
// 当前媒体根列表的条目才会生效。
func NewContentKindPolicy(defaultKind string, roots []string, rootKinds map[string]string) ContentKindPolicy {
	policy := ContentKindPolicy{
		Default: models.NormalizeContentKind(defaultKind),
		Roots:   map[string]models.ContentKind{},
	}
	if len(rootKinds) == 0 {
		return policy
	}
	byKey := make(map[string]models.ContentKind, len(rootKinds))
	for path, kind := range rootKinds {
		if !models.IsValidContentKind(kind) {
			continue
		}
		byKey[normalizeRootKey(path)] = models.NormalizeContentKind(kind)
	}
	for _, root := range roots {
		key := normalizeRootKey(root)
		kind, ok := byKey[key]
		if !ok {
			continue
		}
		policy.Roots[key] = kind
	}
	return policy
}

// KindFor 返回某个媒体根下的默认用途；未配置时返回全局默认值。
//
// 全局默认值本身也做归一化：零值策略（Default 为空）等同于「默认按照片打开」。
func (p ContentKindPolicy) KindFor(sourceRoot string) models.ContentKind {
	if sourceRoot != "" {
		if kind, ok := p.Roots[normalizeRootKey(sourceRoot)]; ok {
			return kind
		}
	}
	return models.NormalizeContentKind(string(p.Default))
}

// normalizeRootKey 把媒体根路径归一化成可比较的键：绝对化 + 清理，
// Windows 下再折叠大小写。
func normalizeRootKey(path string) string {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return ""
	}
	abs, err := filepath.Abs(trimmed)
	if err != nil {
		abs = filepath.Clean(trimmed)
	} else {
		abs = filepath.Clean(abs)
	}
	if runtime.GOOS == "windows" {
		abs = strings.ToLower(abs)
	}
	return abs
}

// ApplyContentKinds 就地写回每个相册的有效内容用途。
//
// 就地修改是刻意的：调用方（catalog 发布流程）已经持有扫描结果的私有副本，
// 再复制一份会白白放大内存占用。相册在根列表、集合与智能合集里各有一份
// 拷贝，三处都要写，否则同一本相册会在不同视图里显示不同用途。
func ApplyContentKinds(
	result *models.ScanResult,
	overrides map[string]models.ContentKind,
	policy ContentKindPolicy,
) {
	if result == nil {
		return
	}
	apply := func(album *models.Album) {
		defaultKind := policy.KindFor(album.SourceRoot)
		kind := defaultKind
		overridden := false
		if explicit, ok := overrides[filepath.Clean(album.Path)]; ok {
			kind = explicit
			overridden = true
		}
		album.ContentKind = string(kind)
		album.ContentKindOverridden = overridden
	}
	for i := range result.Albums {
		apply(&result.Albums[i])
	}
	var walkCollections func([]models.Collection)
	walkCollections = func(collections []models.Collection) {
		for i := range collections {
			for j := range collections[i].Albums {
				apply(&collections[i].Albums[j])
			}
			walkCollections(collections[i].Collections)
		}
	}
	walkCollections(result.Collections)
	for i := range result.SmartCollections {
		for j := range result.SmartCollections[i].Albums {
			apply(&result.SmartCollections[i].Albums[j])
		}
	}
}
