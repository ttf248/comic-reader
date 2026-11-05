package models

import "strings"

// ContentKind 区分媒体目录的「内容属性」：照片还是漫画。
//
// 它与媒体文件类型（image / video）是两件事：同一本相册里的文件既可能是
// 图片也可能是视频，而「这批内容该用哪种方式看」是用户决定的产品语义。
//
// 属性只由所属媒体根决定，目录下的相册与集合一并继承它；不按图片数量猜测，
// 也不按单本相册单独设置。
type ContentKind string

const (
	// ContentKindPhoto 照片目录：平铺照片墙 + 沉浸式看图，不出现阅读器专属控件。
	ContentKindPhoto ContentKind = "photo"
	// ContentKindComic 漫画目录：单页阅读器 + 阅读进度 + 双页 / RTL 等阅读模式。
	ContentKindComic ContentKind = "comic"
)

// DefaultContentKind 是目录没有显式属性时使用的属性。
const DefaultContentKind = ContentKindPhoto

// IsValidContentKind 判断字符串是否是受支持的内容属性。
func IsValidContentKind(value string) bool {
	switch ContentKind(strings.TrimSpace(value)) {
	case ContentKindPhoto, ContentKindComic:
		return true
	}
	return false
}

// NormalizeContentKind 归一化内容属性；非法或空值回落到默认属性。
func NormalizeContentKind(value string) ContentKind {
	if IsValidContentKind(value) {
		return ContentKind(strings.TrimSpace(value))
	}
	return DefaultContentKind
}

// AppMode 是「工作台模式」：应用当前面向哪一类目录。
//
// 目录属性（ContentKind）把媒体库分成照片与漫画两半，两半互斥：
// 照片模式的列表只出现照片目录的相册，漫画模式只出现漫画目录的相册。
// 两种模式的菜单与文案各自成套，互不掺入对方的操作。
type AppMode string

const (
	// AppModePhoto 照片工作台：只列照片目录的相册，用「浏览 / 收藏 / 最近」的说法。
	AppModePhoto AppMode = "photo"
	// AppModeComic 漫画工作台：只列漫画目录的相册，用「继续阅读 / 未读」的说法。
	AppModeComic AppMode = "comic"
)

// DefaultAppMode 是没有明确选择时使用的默认工作台。
const DefaultAppMode = AppModePhoto

// IsValidAppMode 判断字符串是否是受支持的工作台模式。
func IsValidAppMode(value string) bool {
	switch AppMode(strings.TrimSpace(value)) {
	case AppModePhoto, AppModeComic:
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
