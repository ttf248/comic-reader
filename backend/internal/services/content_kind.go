// Package services 提供本地画廊核心业务服务。
package services

import (
	"path/filepath"
	"strings"

	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/pathutil"
)

// RootKind 描述一个媒体根目录的内容属性。
//
// 属性只有照片与漫画两种，且互斥：一个目录要么是照片目录，要么是漫画目录。
// 目录下的相册与集合一并继承它。
type RootKind struct {
	// Path 是媒体根的绝对路径。
	Path string
	// Kind 是该目录的内容属性。
	Kind models.ContentKind
}

// ContentKindPolicy 把媒体根映射到它的内容属性。
//
// Roots 用归一化后的媒体根绝对路径做键（Windows 下大小写不敏感）。
// 目录属性是唯一来源：既没有全局默认，也没有单本相册的例外。
type ContentKindPolicy struct {
	Roots map[string]models.ContentKind
}

// NewContentKindPolicy 依据媒体根条目构造策略。
//
// 路径可以是相对路径、大小写不同或带尾斜杠；非法属性回落到默认属性。
func NewContentKindPolicy(roots []RootKind) ContentKindPolicy {
	policy := ContentKindPolicy{Roots: map[string]models.ContentKind{}}
	for _, root := range roots {
		key := normalizeRootKey(root.Path)
		if key == "" {
			continue
		}
		policy.Roots[key] = models.NormalizeContentKind(string(root.Kind))
	}
	return policy
}

// KindFor 返回某个媒体根下的内容属性；未登记的根返回默认属性。
//
// 默认属性本身也做归一化：零值策略（空 map）等同于「默认按照片处理」。
func (p ContentKindPolicy) KindFor(sourceRoot string) models.ContentKind {
	if sourceRoot != "" {
		if kind, ok := p.Roots[normalizeRootKey(sourceRoot)]; ok {
			return kind
		}
	}
	return models.DefaultContentKind
}

// normalizeRootKey 把媒体根路径归一化成可比较的键：绝对化 + 清理，
// 再按平台规则折叠大小写。它与媒体根判定共用 pathutil 的规则，
// 免得「按根定属性」和「这个文件属于哪个根」两处标准不一致。
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
	return pathutil.RootKey(abs)
}

// ApplyContentKinds 就地写回每个相册与集合的有效内容属性。
//
// 就地修改是刻意的：调用方（catalog 发布流程）已经持有扫描结果的私有副本，
// 再复制一份会白白放大内存占用。相册在根列表、集合与智能合集里各有一份
// 拷贝，三处都要写，否则同一本相册会在不同视图里显示不同属性。
func ApplyContentKinds(result *models.ScanResult, policy ContentKindPolicy) {
	if result == nil {
		return
	}
	apply := func(album *models.Album) {
		album.ContentKind = string(policy.KindFor(album.SourceRoot))
	}
	for i := range result.Albums {
		apply(&result.Albums[i])
	}
	var walkCollections func([]models.Collection)
	walkCollections = func(collections []models.Collection) {
		for i := range collections {
			collections[i].ContentKind = string(policy.KindFor(collections[i].SourceRoot))
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
