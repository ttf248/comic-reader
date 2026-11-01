package handlers

import (
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/valyala/fasthttp"

	"github.com/tianlongxiang/local-gallery/internal/httputil"
)

// serveMediaFile 仅接受已校验的源路径或服务端派生路径，不缓存文件句柄。
// 响应头和范围使用同一次打开的文件信息，流由 Fiber 在完成或断连时关闭。
func serveMediaFile(c *fiber.Ctx, path, contentType, notFoundCode string) error {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return httputil.NotFound(c, notFoundCode, "media resource was not found")
		}
		return httputil.Internal(c, "media_read_failed", "failed to read media resource")
	}
	streamed := false
	defer func() {
		if !streamed {
			f.Close()
		}
	}()
	info, err := f.Stat()
	if err != nil {
		return httputil.Internal(c, "media_read_failed", "failed to read media resource")
	}
	if !info.Mode().IsRegular() {
		return httputil.NotFound(c, notFoundCode, "media resource was not found")
	}
	size := int(info.Size())
	if int64(size) != info.Size() {
		return httputil.Internal(c, "media_read_failed", "media resource is too large")
	}
	etag := mediaETag(info)
	if mediaNotModified(c, etag, info.ModTime()) {
		return c.SendStatus(fiber.StatusNotModified)
	}
	if contentType == "" {
		ext := strings.ToLower(filepath.Ext(path))
		if ext == ".heic" || ext == ".heif" {
			contentType = "image/heic"
		} else {
			contentType = mime.TypeByExtension(ext)
		}
		if contentType == "" {
			var head [512]byte
			n, _ := f.ReadAt(head[:], 0)
			contentType = http.DetectContentType(head[:n])
		}
	}
	c.Set("Content-Type", contentType)
	c.Set("Accept-Ranges", "bytes")
	start, end := 0, size-1
	if header := c.Get("Range"); header != "" && mediaRangeMatches(c.Get("If-Range"), etag, info.ModTime()) {
		start, end, err = fasthttp.ParseByteRange([]byte(header), size)
		if err != nil || start < 0 || end < start || end >= size {
			c.Response().Header.Del("ETag")
			c.Response().Header.Del("Last-Modified")
			c.Set("Cache-Control", "no-store")
			c.Set("Content-Range", fmt.Sprintf("bytes */%d", size))
			return httputil.Error(c, fiber.StatusRequestedRangeNotSatisfiable, "invalid_range", "requested media range is invalid")
		}
		c.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, size))
		c.Status(fiber.StatusPartialContent)
	}
	length := end - start + 1
	var reader io.Reader = f
	if start != 0 || length != size {
		reader = io.NewSectionReader(f, int64(start), int64(length))
	}
	streamed = true
	return c.SendStream(&mediaFileStream{reader: reader, file: f}, length)
}

func mediaETag(info os.FileInfo) string {
	return fmt.Sprintf(`"%x-%x"`, info.ModTime().UnixNano(), info.Size())
}

type mediaFileStream struct {
	reader io.Reader
	file   *os.File
}

func (s *mediaFileStream) Read(p []byte) (int, error) {
	n, err := s.reader.Read(p)
	return n, mediaStreamError(err)
}

func (s *mediaFileStream) WriteTo(w io.Writer) (int64, error) {
	n, err := io.Copy(w, s.reader)
	return n, mediaStreamError(err)
}

func (s *mediaFileStream) Close() error {
	return mediaStreamError(s.file.Close())
}

func mediaStreamError(err error) error {
	var pathError *os.PathError
	if errors.As(err, &pathError) {
		return pathError.Err
	}
	return err
}
