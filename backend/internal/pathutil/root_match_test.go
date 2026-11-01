package pathutil

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestMostSpecificRootUsesPathBoundariesAndIgnoresOrder(t *testing.T) {
	parent := t.TempDir()
	child := filepath.Join(parent, "series")
	grandchild := filepath.Join(child, "archive")
	cases := []struct {
		name, path, owner, relative string
	}{
		{"deepest", filepath.Join(grandchild, "page.png"), grandchild, "page.png"},
		{"root-itself", child, child, "."},
		{"neighbor-prefix", filepath.Join(parent, "series-backup", "page.png"), parent, filepath.Join("series-backup", "page.png")},
		{"outside", filepath.Join(filepath.Dir(parent), "outside", "page.png"), "", ""},
		{"relative", "series/page.png", "", ""},
		{"empty", "", "", ""},
	}
	for _, roots := range [][]string{{parent, child, grandchild}, {grandchild, parent, child}, {child, grandchild, parent}} {
		for _, item := range cases {
			owner, relative, matched := MostSpecificRoot(item.path, roots)
			if matched != (item.owner != "") || owner != item.owner || relative != item.relative {
				t.Errorf("%s: owner=%q relative=%q matched=%t", item.name, owner, relative, matched)
			}
		}
	}
	if _, _, matched := MostSpecificRoot(filepath.Join(parent, "page.png"), []string{"."}); matched {
		t.Fatal("relative root implicitly authorized current working directory")
	}
}

func TestMostSpecificRootUsesPlatformCaseRules(t *testing.T) {
	parent := t.TempDir()
	child := filepath.Join(parent, "series")
	path := strings.ToUpper(filepath.Join(child, "page.png"))
	owner, relative, matched := MostSpecificRoot(path, []string{parent, child})
	if runtime.GOOS == "windows" {
		if !matched || owner != child || relative != "PAGE.PNG" {
			t.Fatalf("Windows root case mismatch: owner=%q relative=%q matched=%t", owner, relative, matched)
		}
	} else if matched {
		t.Fatal("different case matched on a case-sensitive path policy")
	}
}
