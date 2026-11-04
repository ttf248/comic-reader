package models

import "strings"

// ContentKind 区分相册的「浏览用途」：照片墙还是漫画阅读器。
//
// 它与媒体文件类型（image / video）是两件事：同一本相册里的文件既可能是
// 图片也可能是视频，而「这本相册该用哪种方式看」是用户决定的产品语义。
// 用途只由「媒体根默认值 + 单个相册覆盖」决定，绝不按图片数量猜测。
type ContentKind string

const (
	// ContentKindPhoto 照片相册：平铺照片墙 + 沉浸式看图，不出现阅读器专属控件。
	ContentKindPhoto ContentKind = "photo"
	// ContentKindComic 漫画相册：单页阅读器 + 阅读进度 + 双页 / RTL 等阅读模式。
	ContentKindComic ContentKind = "comic"
)

// DefaultContentKind 是既没有媒体根默认值也没有相册覆盖时使用的用途。
const DefaultContentKind = ContentKindPhoto

// IsValidContentKind 判断字符串是否是受支持的内容用途。
func IsValidContentKind(value string) bool {
	switch ContentKind(strings.TrimSpace(value)) {
	case ContentKindPhoto, ContentKindComic:
		return true
	}
	return false
}

// NormalizeContentKind 归一化内容用途；非法或空值回落到默认用途。
func NormalizeContentKind(value string) ContentKind {
	if IsValidContentKind(value) {
		return ContentKind(strings.TrimSpace(value))
	}
	return DefaultContentKind
}
