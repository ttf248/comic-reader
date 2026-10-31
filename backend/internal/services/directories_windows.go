package services

import "golang.org/x/sys/windows"

func directoryRoots() []string {
	mask, err := windows.GetLogicalDrives()
	if err != nil {
		return []string{}
	}
	roots := make([]string, 0, 26)
	for i := uint(0); i < 26; i++ {
		if mask&(1<<i) != 0 {
			roots = append(roots, string(rune('A'+i))+`:\`)
		}
	}
	return roots
}
