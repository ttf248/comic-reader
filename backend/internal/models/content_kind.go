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

// AppMode 是「全局工作台模式」：应用当前面向哪一类相册。
//
// 它与 ContentKind 正交：ContentKind 是每本相册的属性（这本怎么打开），
// AppMode 是用户的当前选择（我现在看哪一类）。切换 AppMode 只改变列表里
// 出现什么、页面用什么措辞，永远不改变某本相册自己的打开方式。
type AppMode string

const (
	// AppModePhoto 照片工作台：只列照片相册，用「继续浏览 / 未浏览」的说法。
	AppModePhoto AppMode = "photo"
	// AppModeComic 漫画工作台：只列漫画相册，用「继续阅读 / 未读」的说法。
	AppModeComic AppMode = "comic"
	// AppModeAll 全部相册：不过滤，两种相册混排。它是逃生舱而非第三个工作台。
	AppModeAll AppMode = "all"
)

// DefaultAppMode 是没有明确选择时使用的默认工作台。
const DefaultAppMode = AppModePhoto

// IsValidAppMode 判断字符串是否是受支持的工作台模式。
func IsValidAppMode(value string) bool {
	switch AppMode(strings.TrimSpace(value)) {
	case AppModePhoto, AppModeComic, AppModeAll:
		return true
	}
	return false
}

// NormalizeAppMode 归一化工作台模式；非法或空值回落到默认模式。
func NormalizeAppMode(value string) AppMode {
	if IsValidAppMode(value) {
		return AppMode(strings.TrimSpace(value))
	}
	return DefaultAppMode
}
