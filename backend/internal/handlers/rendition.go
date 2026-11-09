package handlers

import (
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/services"
)

// renditionCacheControl 决定渲染图的缓存策略。
//
// 带 ?v=<内容版本号> 且与当前源文件版本一致的请求，说明这个 URL 对应的
// 字节已经定死（源文件没动、渲染算法没变），可以放心让浏览器长期缓存：
// 重复打开页面时一次网络请求都不发。
//
// 版本不一致或没带 ?v= 时保持"每次重新验证"：源文件刚被改写时，
// 旧 URL 不该继续喂给浏览器陈旧的图。
func renditionCacheControl(c *fiber.Ctx, version string) string {
	if version == "" {
		return "private, no-cache"
	}
	if c.Query("v") != version {
		return "private, no-cache"
	}
	return "private, max-age=31536000, immutable"
}

// renditionWidth 解析请求的渲染档位宽度。
//
// 缺省用服务的缺省档位；非数字或非正数返回错误，由调用方转成 400。
// 合法宽度会被向上对齐到档位阶梯（SnapRenditionWidth）。
func renditionWidth(c *fiber.Ctx, fallback int) (int, error) {
	raw := strings.TrimSpace(c.Query("w"))
	if raw == "" {
		return services.SnapRenditionWidth(fallback), nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, &invalidWidthError{value: raw}
	}
	return services.SnapRenditionWidth(n), nil
}

// invalidWidthError 表示 w 参数不是合法的正整数。
type invalidWidthError struct {
	value string
}

func (e *invalidWidthError) Error() string {
	return "invalid 'w' query parameter: " + strconv.Quote(e.value)
}
