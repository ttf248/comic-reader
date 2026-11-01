package middleware

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/httputil"
	"github.com/tianlongxiang/local-gallery/internal/pathutil"
)

// OpenInOS 在系统文件管理器中打开给定路径。
// 仅当 allowOsOpen=true 时由 handler 调用，否则返回 403。
func OpenInOS(path string) error {
	if path == "" {
		return fmt.Errorf("empty path")
	}
	st, err := os.Stat(path)
	if err != nil {
		return err
	}
	target := path
	if st.IsDir() {
		target = path
	} else {
		target = filepath.Dir(path)
	}

	switch runtime.GOOS {
	case "windows":
		// explorer.exe /select,"<file>" 高亮文件
		if !st.IsDir() {
			return exec.Command("explorer.exe", "/select,", path).Run()
		}
		return exec.Command("explorer.exe", path).Run()
	case "darwin":
		return exec.Command("open", target).Run()
	default:
		return exec.Command("xdg-open", target).Run()
	}
}

// pathState 当前生效的规范化根集合；校验时选择最具体的根。
type pathState struct {
	roots []string
}

// safetyState 用 atomic.Pointer 持有 pathState，handler 读无锁。
type safetyState struct {
	v atomic.Pointer[pathState]
}

// ResourceResolver 把业务资源 ID 解析为内部绝对路径。
type ResourceResolver interface {
	Resolve(id string) (string, bool)
}

// SnapshotResourceResolver 在解析资源时固定它所属的库快照。
// snapshot 作为不透明值传给 handler，中间件不依赖具体服务类型。
type SnapshotResourceResolver interface {
	ResolveWithSnapshot(id string) (path string, snapshot any, ok bool)
}

// PathValidator 对资源目录解析出的内部路径执行当前根集合校验。
type PathValidator interface {
	Validate(path string) (string, error)
}

// PathSafetyMiddleware 返回中间件：把 ?path=<abs> 解析后按最具体媒体根校验。
// Manager 变更回调通过 SetRoots 原子替换根集合；空列表拒绝所有媒体路径。
func PathSafetyMiddleware(initialRoots []string, resolvers ...ResourceResolver) (fiber.Handler, *safetyState) {
	state := &safetyState{}
	state.setRoots(initialRoots)
	var resolver ResourceResolver
	if len(resolvers) > 0 {
		resolver = resolvers[0]
	}
	handler := func(c *fiber.Ctx) error {
		path := c.Query("path")
		if path == "" {
			return c.Next()
		}
		// smart: 前缀不是绝对路径，但 handler 需据此查询"按标签聚合的合集"
		if strings.HasPrefix(path, "smart:") {
			c.Locals("safePath", path)
			return c.Next()
		}
		// 设置页是唯一允许直接提交配置路径的入口；handler 会再次按配置白名单校验。
		if c.Query("allowConfig") == "1" {
			c.Locals("skipSafety", true)
			return c.Next()
		}
		if resolver != nil {
			resolved, ok := resolver.Resolve(path)
			if !ok {
				return httputil.BadRequest(c, "invalid_resource_id", "resource id is invalid or stale")
			}
			path = resolved
		}
		ps := state.v.Load()
		if ps == nil || len(ps.roots) == 0 {
			return httputil.BadRequest(c, "media_roots_unconfigured", "mediaRoots not configured")
		}
		clean, err := validatePathMulti(ps.roots, path)
		if err != nil {
			return httputil.BadRequest(c, "invalid_media_path", "media path is invalid")
		}
		// 校验后的安全路径存到 c.Locals("safePath")，下游 handler 用 SafePath(c) 取
		c.Locals("safePath", clean)
		return c.Next()
	}
	return handler, state
}

// setRoots 规范化并替换根集合，空白项不能变成进程工作目录。
func (s *safetyState) setRoots(roots []string) {
	s.v.Store(&pathState{roots: pathutil.NormalizeRoots(roots)})
}

// SetRoots 公开方法，供 Manager 回调调用以热更新根集合。
func (s *safetyState) SetRoots(roots []string) {
	s.setRoots(roots)
}

// Validate 使用当前原子快照校验路径，供资源参数中间件复用。
func (s *safetyState) Validate(path string) (string, error) {
	ps := s.v.Load()
	if ps == nil || len(ps.roots) == 0 {
		return "", fmt.Errorf("mediaRoots not configured")
	}
	return validatePathMulti(ps.roots, path)
}

// SafePath 从 c.Locals 取出已校验的绝对路径。
func SafePath(c *fiber.Ctx) string {
	if v, ok := c.Locals("safePath").(string); ok && v != "" {
		return v
	}
	return c.Query("path")
}

// IsSafetyBypassed 报告当前请求是否通过 allowConfig=1 跳过了 path safety。
// 跳过后 handler 应自行做白名单校验（不允许直接放行任意 path）。
func IsSafetyBypassed(c *fiber.Ctx) bool {
	v, ok := c.Locals("skipSafety").(bool)
	return ok && v
}

// validatePathMulti 按最具体的配置根校验绝对路径，再逐级拒绝该根内部的链接。
func validatePathMulti(roots []string, p string) (string, error) {
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("path must be absolute")
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	root, _, matched := pathutil.MostSpecificRoot(abs, roots)
	if !matched {
		return "", fmt.Errorf("path outside any configured media root")
	}
	// 配置根本身是用户显式授权的边界；其内部不跟随链接，也不回退到更宽泛的父根。
	for current := abs; ; current = filepath.Dir(current) {
		if relative, _ := filepath.Rel(root, current); relative == "." {
			break
		}
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			continue // 已删除的资源由 handler 返回 404，仍检查其父目录。
		}
		if err != nil {
			return "", fmt.Errorf("cannot validate media path")
		}
		if info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
			return "", fmt.Errorf("media path contains a link")
		}
	}
	return abs, nil
}
