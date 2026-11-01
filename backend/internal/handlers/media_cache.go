package handlers

import (
	"net/http"
	"time"

	"github.com/gofiber/fiber/v2"
)

// mediaNotModified 为稳定媒体 URL 统一设置重新验证策略，并处理条件请求。
func mediaNotModified(c *fiber.Ctx, etag string, modified time.Time) bool {
	c.Set("Cache-Control", "private, no-cache")
	c.Set("ETag", etag)
	c.Set("Last-Modified", modified.UTC().Format(http.TimeFormat))
	match := c.Get("If-None-Match")
	since := c.Get("If-Modified-Since")
	if match != "" {
		return match == etag
	}
	if since != "" {
		if value, err := http.ParseTime(since); err == nil {
			return !modified.Truncate(time.Second).After(value)
		}
	}
	return false
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
