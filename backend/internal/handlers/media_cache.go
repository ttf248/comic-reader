package handlers

import (
	"net/http"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
)

// mediaNotModified 为稳定媒体 URL 统一设置重新验证策略，并处理条件请求。
func mediaNotModified(c *fiber.Ctx, etag string, modified time.Time) bool {
	c.Set("Cache-Control", "private, no-cache")
	c.Set("ETag", etag)
	c.Set("Last-Modified", modified.UTC().Format(http.TimeFormat))
	match := mediaIfNoneMatchValue(c)
	since := c.Get("If-Modified-Since")
	if match != "" {
		return mediaIfNoneMatch(match, etag)
	}
	if since != "" {
		if value, err := http.ParseTime(since); err == nil {
			return !modified.Truncate(time.Second).After(value)
		}
	}
	return false
}

// mediaIfNoneMatchValue 合并重复字段行，与单行逗号列表采用相同语义。
func mediaIfNoneMatchValue(c *fiber.Ctx) string {
	values := c.Request().Header.PeekAll("If-None-Match")
	if len(values) < 2 {
		return c.Get("If-None-Match")
	}
	var combined strings.Builder
	combined.Write(values[0])
	for _, value := range values[1:] {
		combined.WriteByte(',')
		combined.Write(value)
	}
	return combined.String()
}

// mediaIfNoneMatch 按弱比较解析 If-None-Match，保留标识引号内的逗号。
// 调用方须先确认当前资源存在；格式错误的列表不返回缓存命中。
func mediaIfNoneMatch(value, etag string) bool {
	value = strings.Trim(value, " \t")
	if value == "*" {
		return true
	}
	etag = strings.TrimPrefix(etag, "W/")
	matched := false
	for {
		value = strings.TrimLeft(value, " \t,")
		if value == "" {
			return matched
		}
		value = strings.TrimPrefix(value, "W/")
		if len(value) < 2 || value[0] != '"' {
			return false
		}
		end := strings.IndexByte(value[1:], '"') + 1
		if end == 0 {
			return false
		}
		for i := 1; i < end; i++ {
			if value[i] < 0x21 || value[i] == 0x7f {
				return false
			}
		}
		if value[:end+1] == etag {
			matched = true
		}
		value = strings.TrimLeft(value[end+1:], " \t")
		if value != "" && value[0] != ',' {
			return false
		}
	}
}

// mediaRangeMatches 仅允许当前强 ETag 或精确到秒的修改时间继续分段读取。
func mediaRangeMatches(value, etag string, modified time.Time) bool {
	if value == "" || value == etag {
		return true
	}
	if modified.IsZero() {
		return false
	}
	date, err := http.ParseTime(value)
	return err == nil && date.Unix() == modified.Unix()
}
