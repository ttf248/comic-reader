// Package models 定义前后端共用的领域模型。
package models

import (
	"encoding/json"
	"time"
)

// 支持的图片扩展名（小写，含点）。
//
// 含 iPhone 照片常用的 HEIC/HEIF；缩略图与原图解码分别由
// `goheif` + `imaging` 处理，扫描阶段先做扩展名白名单。
var ImageExts = map[string]bool{
	".jpg":  true,
	".jpeg": true,
	".jfif": true, // JFIF 就是 JPEG 变体，浏览器与 Go 解码器都能直接处理
	".png":  true,
	".gif":  true,
	".bmp":  true,
	".webp": true,
	".tiff": true,
	".tif":  true,
	".heic": true,
	".heif": true,
}

// IsImageFile 判断文件名是否为支持的图片格式（不区分大小写）。
func IsImageFile(name string) bool {
	if len(name) < 5 {
		return false
	}
	ext := lowerExt(name)
	return ImageExts[ext]
}

// NeedsBrowserConversion 判断该图片格式浏览器原生解不了，需要服务端转换。
//
// HEIC/HEIF 是 iPhone 照片的默认格式，TIFF 常见于扫描件与设计稿；
// 浏览器拿到原文件只会显示破图，因此这类文件改由服务端转成 JPEG。
func NeedsBrowserConversion(name string) bool {
	switch lowerExt(name) {
	case ".heic", ".heif", ".tif", ".tiff":
		return true
	}
	return false
}

// VideoExts 支持的视频扩展名（小写，含点）。
//
// 选型：覆盖浏览器原生 `<video>` 元素能直接播放的常见容器。
// 视频的"封面"由前端在浏览器内通过 `<video>` + canvas 抽帧后回传
// 到 `/api/thumbs/cover`（实现见 handlers 包）；本服务不依赖 ffmpeg。
var VideoExts = map[string]bool{
	".mp4":  true,
	".m4v":  true,
	".webm": true,
	".mov":  true,
	".mkv":  true,
	".avi":  true, // 部分浏览器不支持 AVI 容器（含老式 XviD/DivX），但列入白名单方便后续扩展
	".3gp":  true, // 手机录制常用；浏览器放不了，走服务端转码
}

// FileMediaKind 返回文件对应的媒体类型："image" / "video"；不是受支持的媒体时返回空串。
//
// 这是扩展名白名单的唯一事实来源：扫描器、封面类型判定、设封面校验都用它，
// 避免各处复制一份清单后互相漂移（曾经 .tiff 能被扫描却在"设为封面"时被拒）。
func FileMediaKind(name string) string {
	ext := lowerExt(name)
	if ImageExts[ext] {
		return string(MediaKindImage)
	}
	if VideoExts[ext] {
		return string(MediaKindVideo)
	}
	return ""
}

// IsVideoFile 判断文件名是否为支持的视频格式（不区分大小写）。
func IsVideoFile(name string) bool {
	if len(name) < 5 {
		return false
	}
	ext := lowerExt(name)
	return VideoExts[ext]
}

func lowerExt(name string) string {
	for i := len(name) - 1; i >= 0 && i > len(name)-6; i-- {
		if name[i] == '.' {
			s := name[i:]
			b := []byte(s)
			for j := range b {
				if b[j] >= 'A' && b[j] <= 'Z' {
					b[j] += 32
				}
			}
			return string(b)
		}
	}
	return ""
}

// VirtualAlbumName 是"本目录媒体"视图的类型常量。
//
// 所有散图相册的 Name 都是它（用来区分相册类型），展示名另由
// Location（归属目录相对媒体根的路径）给出。
const VirtualAlbumName = "本目录媒体"

// Album 含有图片的文件夹。
//
// 多根场景（mediaRoots 配置多个目录）下，扫描器会填充 SourceRoot（绝对路径）/
// SourceName（根的 basename，用于 badge 显示）；若不同根下出现同名相册，
// DisplayName 会加 "[SourceName] " 前缀避免歧义，否则与 Name 相同。
type Album struct {
	Type        string    `json:"type"`                  // 始终为 "album"
	Path        string    `json:"path"`                  // 绝对路径
	Name        string    `json:"name"`                  // 文件夹名（原始名）
	DisplayName string    `json:"displayName,omitempty"` // 同名冲突时加来源前缀；否则等于 Name
	SourceRoot  string    `json:"sourceRoot,omitempty"`  // 所属媒体根（绝对路径）；多根扫描时填充
	SourceName  string    `json:"sourceName,omitempty"`  // 所属媒体根的 basename，用于 UI badge
	ImageFiles  []string  `json:"imageFiles"`
	VideoFiles  []string  `json:"videoFiles"`
	CoverImage  string    `json:"coverImage"` // 封面（图片时为原图绝对路径；视频时为视频绝对路径，缩略图由前端抽帧）
	ImageCount  int       `json:"imageCount"`
	VideoCount  int       `json:"videoCount,omitempty"` // 视频数量（0 时省略）
	FolderSize  int64     `json:"folderSize"`           // 字节
	Tags        []string  `json:"tags,omitempty"`       // 标签（从方括号解析），可能多个
	ModTime     time.Time `json:"modTime"`
	// Date 是相册在时间轴上的统一业务时间；DateSource 说明该时间的
	// 来源，前端不再根据文件夹名自行猜测。优先级固定为
	// captured > folder > modified。
	Date       time.Time `json:"date"`
	DateSource string    `json:"dateSource"` // captured / folder / modified
	// CoverKind 标识封面来源："image" / "video" / ""（未指定时按是否有视频推断）。
	// 前端据此决定卡片样式（图卡 vs 视频▶卡）和点击进入的播放器类型。
	CoverKind string `json:"coverKind,omitempty"`
	// Virtual 表示“本目录媒体”视图。它与所属 Collection 共享物理目录，
	// 但使用不同资源类型 ID，不再伪造磁盘上不存在的 .loose 路径。
	Virtual bool `json:"virtual,omitempty"`
	// Location 是虚拟相册归属目录相对所属媒体根的路径（斜杠分隔），
	// 例如 "2020年" 或 "2011年/10.1一号公馆"。根目录自身的散图用根名。
	// 非虚拟相册为空。
	//
	// 存在的理由：虚拟相册的 Name 恒为“本目录媒体”，在未读/最近等扁平
	// 列表里几十张卡片同名，用户无法分辨归属目录；Location 提供唯一且
	// 稳定的展示标识。
	Location string `json:"location,omitempty"`
}

// MarshalJSON 保证当前 API 的媒体列表始终是数组，避免调用方区分 null 与 []。
func (a Album) MarshalJSON() ([]byte, error) {
	type alias Album
	return json.Marshal(struct {
		alias
		ImageFiles []string `json:"imageFiles"`
		VideoFiles []string `json:"videoFiles"`
	}{
		alias:      alias(a),
		ImageFiles: nonNilStrings(a.ImageFiles),
		VideoFiles: nonNilStrings(a.VideoFiles),
	})
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

// Collection 仅含子相册（不含图片）的文件夹。
//
// Albums 与 Collections 同时存在：本层「散图」或直属于本层无嵌套的子相册
// 放在 Albums；下钻一层仍是「集合」语义的子集合（子文件夹里没有顶层图
// 只有更深子目录）放在 Collections。这样 UI 沿 Albums/Collections 两条
// 路径递归渲染时，可以完整保留「年 / 月 / 事件」这种多层目录结构。
type Collection struct {
	Type        string       `json:"type"` // 始终为 "collection"
	Path        string       `json:"path"` // 绝对路径
	Name        string       `json:"name"` // 文件夹名
	DisplayName string       `json:"displayName,omitempty"`
	SourceRoot  string       `json:"sourceRoot,omitempty"`
	SourceName  string       `json:"sourceName,omitempty"`
	Albums      []Album      `json:"albums"`
	Collections []Collection `json:"collections,omitempty"` // 嵌套子集合
	AlbumCount  int          `json:"albumCount"`            // 直属于本层的相册数（不含嵌套集合）
}

// MarshalJSON 确保 nil Albums 序列化为 `[]`；Collections 省略字段时
// 整段不输出，避免给前端返回大量空 `[]collections`。
func (c Collection) MarshalJSON() ([]byte, error) {
	type alias Collection
	albums := c.Albums
	if albums == nil {
		albums = []Album{}
	}
	// 嵌套 collections 为空时直接省略，前端按缺省处理即可
	hasNested := len(c.Collections) > 0
	return json.Marshal(struct {
		alias
		Albums      []Album      `json:"albums"`
		Collections []Collection `json:"collections,omitempty"`
	}{
		alias:       alias(c),
		Albums:      albums,
		Collections: ternaryCollections(hasNested, c.Collections),
	})
}

func ternaryCollections(use bool, v []Collection) []Collection {
	if !use {
		return nil
	}
	return v
}

// SmartCollection 基于方括号标签聚合的智能集合。
//
// 历史命名：原本只把第一个方括号当"作者"；本地画廊产品语义下统称为
// "标签 / Tag"——一个文件夹可挂多个标签。
type SmartCollection struct {
	Type       string   `json:"type"`           // 始终为 "smartCollection"
	Tag        string   `json:"tag"`            // 标签（首个标签；当个智能合集的主键）
	Tags       []string `json:"tags,omitempty"` // 同义时省略
	Albums     []Album  `json:"albums"`
	AlbumCount int      `json:"albumCount"`
	CoverImage string   `json:"coverImage"` // 图片数最多的相册封面
}

// MarshalJSON 确保 nil Albums 序列化为 `[]`。
func (s SmartCollection) MarshalJSON() ([]byte, error) {
	type alias SmartCollection
	albums := s.Albums
	tags := s.Tags
	if albums == nil {
		albums = []Album{}
	}
	if tags == nil {
		tags = []string{}
	}
	return json.Marshal(struct {
		alias
		Albums []Album  `json:"albums"`
		Tags   []string `json:"tags"`
	}{alias: alias(s), Albums: albums, Tags: tags})
}

// ScanResult 单次扫描的完整结果。
//
// Roots 列出所有参与扫描的根（按调用方传入顺序）。AlbumCount /
// CollectionCount 包含所有根的合并统计。
type ScanResult struct {
	Roots            []string          `json:"roots"`
	Albums           []Album           `json:"albums"`
	Collections      []Collection      `json:"collections"`
	SmartCollections []SmartCollection `json:"smartCollections"`
	AlbumCount       int               `json:"albumCount"`
	CollectionCount  int               `json:"collectionCount"`
	Duration         int64             `json:"duration"` // 毫秒
	ScannedAt        time.Time         `json:"scannedAt"`
	Warnings         []ScanWarning     `json:"warnings,omitempty"`
}

// ScanWarning 是不会中断整次扫描的可恢复问题。Path 只能是根别名和
// 相对路径，禁止写入用户绝对路径。
type ScanWarning struct {
	Code    string `json:"code"`
	Path    string `json:"path,omitempty"`
	Message string `json:"message"`
}
