package services

import (
	"path/filepath"
	"testing"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// TestSearchHitScoreRanksByMatchQuality 验证搜索命中的档位：
// 完全匹配 > 前缀 > 包含 > 标签；散图只有命中自己那一段目录名才算前缀命中，
// 只命中上级目录名（路径里的同名目录）排在最后。
func TestSearchHitScoreRanksByMatchQuality(t *testing.T) {
	cases := []struct {
		name string
		hit  LibrarySearchHit
		want int
		ok   bool
	}{
		{
			name: "完全等于",
			hit:  LibrarySearchHit{Name: "旅行"},
			want: searchRankExact,
			ok:   true,
		},
		{
			name: "前缀",
			hit:  LibrarySearchHit{Name: "旅行日记"},
			want: searchRankPrefix,
			ok:   true,
		},
		{
			name: "包含",
			hit:  LibrarySearchHit{Name: "我的旅行日记"},
			want: searchRankContain,
			ok:   true,
		},
		{
			name: "标签",
			hit:  LibrarySearchHit{Name: "别的名字", Tags: []string{"旅行"}},
			want: searchRankTag,
			ok:   true,
		},
		{
			name: "散图命中自己那一段",
			hit:  LibrarySearchHit{Name: "2015年/旅行", Virtual: true},
			want: searchRankPrefix,
			ok:   true,
		},
		{
			name: "散图只命中上级目录",
			hit:  LibrarySearchHit{Name: "旅行/子目录", Virtual: true},
			want: searchRankPath,
			ok:   true,
		},
		{
			name: "不匹配",
			hit:  LibrarySearchHit{Name: "别的名字"},
			want: 0,
			ok:   false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rank, _, ok := searchHitScore(tc.hit, "旅行")
			if ok != tc.ok || (ok && rank != tc.want) {
				t.Fatalf("score=(%d, %v), want (%d, %v)", rank, ok, tc.want, tc.ok)
			}
		})
	}
}

// TestSearchLibraryRanksBeforeTruncating 验证搜索先按匹配质量排序再截断。
//
// 背景：搜索索引是按目录顺序排的，先截断等于「前 N 条碰巧命中的」——
// 用户搜「旅行」时，第一条可能是一本只是恰好待在「旅行」目录下的散图。
func TestSearchLibraryRanksBeforeTruncating(t *testing.T) {
	root := t.TempDir()
	virtualPath := filepath.Join(root, "旅行", "子目录")
	exactPath := filepath.Join(root, "exact")
	prefixPath := filepath.Join(root, "prefix")
	containsPath := filepath.Join(root, "contains")

	virtual := models.Album{
		Type: "album", Path: virtualPath, Name: "本目录媒体", DisplayName: "本目录媒体",
		SourceRoot: root, Virtual: true, Location: "旅行/子目录",
	}
	exact := models.Album{
		Type: "album", Path: exactPath, Name: "旅行", DisplayName: "旅行",
		SourceRoot: root, ImageCount: 1,
	}
	prefix := models.Album{
		Type: "album", Path: prefixPath, Name: "旅行日记", DisplayName: "旅行日记",
		SourceRoot: root, ImageCount: 1,
	}
	contains := models.Album{
		Type: "album", Path: containsPath, Name: "我的旅行相册", DisplayName: "我的旅行相册",
		SourceRoot: root, ImageCount: 1,
	}

	catalog := NewResourceCatalog()
	catalog.SetContentKindPolicy(NewContentKindPolicy([]RootKind{
		{Path: root, Kind: models.ContentKindComic},
	}))
	catalog.Publish(&models.ScanResult{
		Roots: []string{root}, Albums: []models.Album{virtual, contains, prefix, exact},
		AlbumCount: 4,
	}, []string{root})

	hits := SearchLibrary(catalog.Acquire(), "旅行", LibraryKindComic, 2)
	if len(hits) != 2 {
		t.Fatalf("hits=%+v", hits)
	}
	// 截断到两条也要保住最好的两条：完全匹配与前缀命中。
	if hits[0].Name != "旅行" || hits[1].Name != "旅行日记" {
		t.Fatalf("hits=%+v", hits)
	}
}
