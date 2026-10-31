package services

import (
	"errors"
	"io"
	"os"
	"path/filepath"
)

// scanRoot 固定本轮根目录的身份；同一路径被替换也不能发布混合快照。
type scanRoot struct {
	path string
	info os.FileInfo
}

func prepareScanRoots(opts ScanOptions) ([]scanRoot, error) {
	paths := opts.effectiveRoots()
	if len(paths) == 0 {
		return nil, errors.New("root is empty")
	}
	roots := make([]scanRoot, 0, len(paths))
	for _, path := range paths {
		absolute, err := filepath.Abs(path)
		if err != nil {
			return nil, err
		}
		info, err := readScanRoot(absolute)
		if err != nil {
			return nil, err
		}
		roots = append(roots, scanRoot{path: absolute, info: info})
	}
	return roots, nil
}

// 只尝试读取一个目录项，确认可枚举性；空根合法，不预遍历目录树。
func readScanRoot(path string) (os.FileInfo, error) {
	directory, err := os.Open(path)
	if err != nil {
		return nil, scanRootReadError(path, err)
	}
	defer directory.Close()
	info, err := directory.Stat()
	if err != nil {
		return nil, scanRootReadError(path, err)
	}
	if !info.IsDir() {
		return nil, &ScanError{Kind: ScanRootNotDir, Path: path, Err: errors.New("not a directory")}
	}
	if _, err := directory.ReadDir(1); err != nil && !errors.Is(err, io.EOF) {
		return nil, scanRootReadError(path, err)
	}
	return info, nil
}

func scanRootReadError(path string, err error) *ScanError {
	kind := ScanRootUnreadable
	if os.IsNotExist(err) {
		kind = ScanRootMissing
	}
	return &ScanError{Kind: kind, Path: path, Err: err}
}

func (root scanRoot) validate() error {
	info, err := readScanRoot(root.path)
	if err != nil {
		return err
	}
	if !os.SameFile(root.info, info) {
		return &ScanError{Kind: ScanRootChanged, Path: root.path, Err: errors.New("directory identity changed")}
	}
	return nil
}

func validateScanRoots(roots []scanRoot) error {
	for _, root := range roots {
		if err := root.validate(); err != nil {
			return err
		}
	}
	return nil
}

func scanRootPaths(roots []scanRoot) []string {
	paths := make([]string, len(roots))
	for i, root := range roots {
		paths[i] = root.path
	}
	return paths
}
