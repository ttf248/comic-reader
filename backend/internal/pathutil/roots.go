// Package pathutil 统一媒体根目录的路径规范化与比较规则。
package pathutil

import (
	"path/filepath"
	"runtime"
	"strings"
)

// NormalizeRoots 按进程工作目录绝对化，去空、去重并保留首次出现的顺序及大小写。
// 不探测文件系统，离线根也能稳定参与配置比较和缓存恢复。
func NormalizeRoots(roots []string) []string {
	result := make([]string, 0, len(roots))
	seen := make(map[string]struct{}, len(roots))
	for _, root := range roots {
		if strings.TrimSpace(root) == "" {
			continue
		}
		absolute, err := filepath.Abs(root)
		if err != nil {
			// 保留无法绝对化的输入，让后续路径校验报告错误，不能静默漏掉一个根。
			absolute = filepath.Clean(root)
		}
		key := RootKey(absolute)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, absolute)
	}
	return result
}

// RootKey 与资源根 ID 的规则一致：Windows 忽略大小写，其他平台保持大小写。
// 输入由调用方绝对化；仅规范路径文本，不解析符号链接或 junction。
func RootKey(root string) string {
	key := filepath.Clean(root)
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	return key
}

// EqualRoots 比较规范化后的根集合，忽略顺序与重复输入。
func EqualRoots(first, second []string) bool {
	left, right := NormalizeRoots(first), NormalizeRoots(second)
	if len(left) != len(right) {
		return false
	}
	seen := make(map[string]struct{}, len(left))
	for _, root := range left {
		seen[RootKey(root)] = struct{}{}
	}
	for _, root := range right {
		if _, exists := seen[RootKey(root)]; !exists {
			return false
		}
	}
	return true
}

// MostSpecificRoot 在绝对路径中选择最具体的配置根，与资源 ID 的归属规则一致。
// 只比较路径边界，不解析链接；返回相对路径供调用方校验根内组件或生成脱敏标签。
func MostSpecificRoot(path string, roots []string) (root, relative string, matched bool) {
	if !filepath.IsAbs(path) {
		return "", "", false
	}
	for _, candidate := range roots {
		if !filepath.IsAbs(candidate) {
			continue
		}
		candidate = filepath.Clean(candidate)
		rel, err := filepath.Rel(candidate, path)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		if len(candidate) > len(root) {
			root, relative = candidate, rel
		}
	}
	return root, relative, root != ""
}
