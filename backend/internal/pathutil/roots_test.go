package pathutil

import (
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

func TestNormalizeRootsKeepsOrderAndSignificantSpaces(t *testing.T) {
	parent := t.TempDir()
	t.Chdir(parent)
	first := filepath.Join(parent, "photos")
	second := filepath.Join(parent, " leading space")
	input := []string{"", "\t", "photos", first, "./photos", " leading space", "./ leading space"}
	if runtime.GOOS == "windows" {
		input = append(input, strings.ToUpper(first))
	}
	before := slices.Clone(input)
	if got := NormalizeRoots(input); !slices.Equal(got, []string{first, second}) {
		t.Fatalf("normalized roots=%q", got)
	}
	if !slices.Equal(input, before) {
		t.Fatal("normalization mutated caller input")
	}
	if got := NormalizeRoots(nil); got == nil {
		t.Fatal("empty roots must be a non-nil slice")
	}
}

func TestEqualRootsUsesCanonicalSetAndPlatformCaseRules(t *testing.T) {
	parent := t.TempDir()
	t.Chdir(parent)
	first, second := filepath.Join(parent, "photos"), filepath.Join(parent, "videos")
	cases := []struct {
		name string
		a, b []string
		want bool
	}{
		{"aliases", []string{"photos", first, "./photos"}, []string{first}, true},
		{"reordered", []string{first, second}, []string{"videos", "photos", first}, true},
		{"different", []string{first}, []string{second}, false},
		{"empty", []string{"", " "}, nil, true},
		{"one-empty", nil, []string{first}, false},
		{"case", []string{first}, []string{strings.ToUpper(first)}, runtime.GOOS == "windows"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			if got := EqualRoots(item.a, item.b); got != item.want {
				t.Fatalf("root equality=%t want %t", got, item.want)
			}
		})
	}
}
