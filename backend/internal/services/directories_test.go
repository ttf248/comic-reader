package services

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

func TestBrowseDirectoriesReturnsExactPathsAndOnlyDirectories(t *testing.T) {
	root := t.TempDir()
	names := []string{"z folder", "A [100%] #", "照片"}
	for _, name := range names {
		if err := os.Mkdir(filepath.Join(root, name), 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	page, err := BrowseDirectories(filepath.Join(root, names[0], ".."), "")
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	if page.Directory != canonical || page.Parent != filepath.Dir(canonical) || page.NextAfter != "" || len(page.Roots) == 0 {
		t.Fatalf("unexpected location: %+v", page)
	}
	sort.Strings(names)
	if len(page.Items) != len(names) {
		t.Fatalf("items=%+v", page.Items)
	}
	for i, item := range page.Items {
		if item.Name != names[i] || item.Path != filepath.Join(canonical, item.Name) {
			t.Fatalf("item=%+v", item)
		}
	}
	empty, err := BrowseDirectories(page.Items[0].Path, "")
	if err != nil || empty == nil || empty.Items == nil || len(empty.Items) != 0 {
		t.Fatalf("empty=%+v err=%v", empty, err)
	}
}

func TestBrowseDirectoriesPagesWithoutOmissions(t *testing.T) {
	root := t.TempDir()
	want := make([]string, 0, DirectoryPageSize*2+7)
	for i := DirectoryPageSize*2 + 6; i >= 0; i-- {
		name := fmt.Sprintf("folder-%04d", i)
		if err := os.Mkdir(filepath.Join(root, name), 0755); err != nil {
			t.Fatal(err)
		}
		want = append(want, name)
	}
	sort.Strings(want)
	var got []string
	after := ""
	for requests := 0; requests < 4; requests++ {
		page, err := BrowseDirectories(root, after)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Items) > DirectoryPageSize {
			t.Fatal("unbounded page")
		}
		for _, item := range page.Items {
			got = append(got, item.Name)
		}
		if page.NextAfter == "" {
			break
		}
		if page.NextAfter <= after {
			t.Fatal("cursor did not advance")
		}
		after = page.NextAfter
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("pagination returned %d of %d directories", len(got), len(want))
	}
}

func TestBrowseDirectoriesRejectsInvalidAndUnavailableLocations(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, nil, 0600); err != nil {
		t.Fatal(err)
	}
	for _, input := range []struct{ directory, after string }{{"bad\x00path", ""}, {file, ""}, {root, "bad\x00cursor"}} {
		if _, err := BrowseDirectories(input.directory, input.after); !errors.Is(err, ErrInvalidDirectory) {
			t.Fatalf("err=%v; want invalid directory", err)
		}
	}
	if _, err := BrowseDirectories(filepath.Join(root, "missing"), ""); !os.IsNotExist(err) {
		t.Fatalf("err=%v; want not found", err)
	}
}

func TestBrowseDirectoriesDefaultsToUserHome(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("USERPROFILE", root)
	page, err := BrowseDirectories("", "")
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil || page.Directory != canonical {
		t.Fatalf("unexpected default directory")
	}
}
