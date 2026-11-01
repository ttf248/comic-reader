package services

import (
	"errors"
	"os"
	"path/filepath"
)

var errInvalidVideoCache = errors.New("video cache is not a nonempty regular file")

// statVideoCache 不跟随缓存条目自身的链接，空文件和非普通文件均不算命中。
func statVideoCache(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 {
		return nil, errInvalidVideoCache
	}
	return info, nil
}

// newVideoCacheTemp 为一次生成分配独立文件，完成后在同目录原子发布。
func newVideoCacheTemp(dstPath string) (string, error) {
	if err := os.MkdirAll(filepath.Dir(dstPath), 0o755); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(filepath.Dir(dstPath), "."+filepath.Base(dstPath)+"-*.tmp")
	if err != nil {
		return "", err
	}
	if err := f.Close(); err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}
