package services

import (
	"container/heap"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const DirectoryPageSize = 200

var ErrInvalidDirectory = errors.New("invalid directory")

type DirectoryEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type DirectoryPage struct {
	Directory string           `json:"directory"`
	Parent    string           `json:"parent"`
	Roots     []string         `json:"roots"`
	Items     []DirectoryEntry `json:"items"`
	NextAfter string           `json:"nextAfter"`
}

// BrowseDirectories 仅供本机配置管理使用，不复用媒体资源 ID 接口。
// 路径由服务端解析；空目录从当前用户主目录开始，不跟随列表中的链接。
func BrowseDirectories(directory, after string) (*DirectoryPage, error) {
	if strings.ContainsRune(directory, 0) || strings.ContainsRune(after, 0) {
		return nil, ErrInvalidDirectory
	}
	if directory == "" {
		var err error
		directory, err = os.UserHomeDir()
		if err != nil {
			return nil, err
		}
	}
	abs, err := filepath.Abs(directory)
	if err != nil {
		return nil, ErrInvalidDirectory
	}
	canonical, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(canonical)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, ErrInvalidDirectory
	}
	// 固定大小的最大堆保留游标之后最小的 201 个目录名，大目录不整表入内存。
	names := &directoryNames{}
	for {
		entries, readErr := f.ReadDir(256)
		for _, entry := range entries {
			if !entry.IsDir() || entry.Type()&(os.ModeSymlink|os.ModeIrregular) != 0 || entry.Name() <= after {
				continue
			}
			if names.Len() < DirectoryPageSize+1 {
				heap.Push(names, entry.Name())
			} else if entry.Name() < (*names)[0] {
				(*names)[0] = entry.Name()
				heap.Fix(names, 0)
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return nil, readErr
		}
	}
	sort.Strings(*names)
	page := &DirectoryPage{Directory: canonical, Roots: directoryRoots(), Items: make([]DirectoryEntry, 0, DirectoryPageSize)}
	if parent := filepath.Dir(canonical); parent != canonical {
		page.Parent = parent
	}
	if names.Len() > DirectoryPageSize {
		*names = (*names)[:DirectoryPageSize]
		page.NextAfter = (*names)[DirectoryPageSize-1]
	}
	for _, name := range *names {
		page.Items = append(page.Items, DirectoryEntry{Name: name, Path: filepath.Join(canonical, name)})
	}
	return page, nil
}

type directoryNames []string

func (n directoryNames) Len() int           { return len(n) }
func (n directoryNames) Less(i, j int) bool { return n[i] > n[j] }
func (n directoryNames) Swap(i, j int)      { n[i], n[j] = n[j], n[i] }
func (n *directoryNames) Push(v any)        { *n = append(*n, v.(string)) }
func (n *directoryNames) Pop() any {
	last := len(*n) - 1
	v := (*n)[last]
	*n = (*n)[:last]
	return v
}
