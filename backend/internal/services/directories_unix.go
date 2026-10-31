//go:build !windows

package services

func directoryRoots() []string { return []string{"/"} }
