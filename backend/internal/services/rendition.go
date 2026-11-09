package services

import (
	"fmt"
	"os"
)

// 渲染档位阶梯。
//
// 同一张源图在不同场景需要的像素宽度差得很远：侧栏缩略 48px、相册卡
// 254px、照片墙 550px、沉浸查看器 1440px。以前只有一个固定尺寸的缩略图，
// 小位白下载大图、大位放大发虚。改成按宽度分档之后，每个场景取自己那一档。
//
// 关键前提：渲染不裁剪，输出宽高比恒等于源图宽高比。所以同一张源图的
// 各档之间比例一致，前端才能用 srcset 让浏览器按实际显示宽度自选候选。
//
// 阶梯是前后端共同的实现约定，不是配置项：前端 src/utils/rendition.ts
// 有一份同样的常量，两边必须一致，否则 srcset 的宽度描述符会与实际
// 像素宽度对不上，浏览器会挑到不够宽的一档。
var RenditionWidths = []int{320, 640, 1280, 1920, 2560, 4096}

// DefaultRenditionWidth 是未带 w 参数时使用的档位。
const DefaultRenditionWidth = 640

// renditionAlgoVersion 渲染算法版本。
//
// 缩放算法、JPEG 质量或档位集合发生变化时必须递增：它进媒体版本号，
// 版本一变前端拼出的 URL 就变，浏览器不会继续用旧缓存。
const renditionAlgoVersion = 3

// SnapRenditionWidth 把请求宽度向上取整到最近的档位。
//
// 向上取整而不是取最近：档位是"至少要这么大"的保证。取整到更小的档位
// 会让高 DPI 屏幕上的图重新变糊，那正是这次要解决的问题。
func SnapRenditionWidth(width int) int {
	if width <= 0 {
		return DefaultRenditionWidth
	}
	for _, w := range RenditionWidths {
		if width <= w {
			return w
		}
	}
	return RenditionWidths[len(RenditionWidths)-1]
}

// MediaVersion 返回源媒体的内容版本号。
//
// 由修改时间、文件大小与渲染算法版本派生：
//   - 源文件被改写 → 版本变 → 前端 URL 变 → 浏览器丢弃旧缓存；
//   - 渲染算法升级 → 版本变 → 同上。
//
// 前端把它拼进缩略图/预览图的 URL（?v=），服务端据此回 immutable，
// 重复打开页面时浏览器直接用本地副本，一次网络请求都不发。
func MediaVersion(absPath string) (string, error) {
	fi, err := os.Stat(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", ErrSourceMissing
		}
		return "", err
	}
	if !fi.Mode().IsRegular() {
		return "", ErrSourceMissing
	}
	return MediaVersionFromStat(fi), nil
}

// MediaVersionFromStat 由已取得的文件信息派生版本号，避免重复 stat。
func MediaVersionFromStat(fi os.FileInfo) string {
	return fmt.Sprintf("%d-%d-r%d", fi.ModTime().UnixNano(), fi.Size(), renditionAlgoVersion)
}

// RenditionETag 由版本号与档位拼出强 ETag。
//
// 它标识的是"这份源文件在这一档渲染出来的字节"：同一个版本号与档位
// 渲染结果确定，所以不必再对响应字节做哈希。哈希版本的问题是要先把
// 整个文件读进内存算一遍 sha256，条件请求省不掉这笔开销；改成版本号
// 之后，304 只需要一次 stat 加一次字符串比较。
func RenditionETag(version string, width int) string {
	return fmt.Sprintf(`"%s-%d"`, version, width)
}
