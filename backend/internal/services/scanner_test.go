package services

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// mkdirAll / touchAll 是测试辅助：创建多层级目录结构与空图片占位文件。
func mkdirAll(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func touchAll(t *testing.T, paths ...string) {
	t.Helper()
	for _, p := range paths {
		if err := os.WriteFile(p, []byte("fake"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestScan_MissingRoot(t *testing.T) {
	s := NewScanner()
	_, err := s.Scan(ScanOptions{Roots: []string{filepath.Join(t.TempDir(), "nope")}})
	if err == nil {
		t.Fatal("expected error for missing root")
	}
	se, ok := err.(*ScanError)
	if !ok {
		t.Fatalf("expected *ScanError, got %T", err)
	}
	if se.Kind != ScanRootMissing {
		t.Errorf("expected ScanRootMissing, got %v", se.Kind)
	}
}

func TestScan_FileNotDir(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "f.txt")
	os.WriteFile(file, []byte("x"), 0o644)

	s := NewScanner()
	_, err := s.Scan(ScanOptions{Roots: []string{file}})
	se, ok := err.(*ScanError)
	if !ok || se.Kind != ScanRootNotDir {
		t.Fatalf("expected ScanRootNotDir, got %v", err)
	}
}

// 构造：
//
//	root/
//	  single/                 <- album
//	    1.jpg
//	  [作者A] vol1/           <- album
//	    p1.png
//	  [作者A] vol2/           <- album
//	    p2.jpg
//	  [作者B] single/         <- album
//	    p3.gif
//	  coll/                   <- collection
//	    albumX/
//	      a.jpg
//	    albumY/               <- 子目录但无图片 → 应忽略
//	  empty/
func TestScan_TopLevelAlbumsAndCollections(t *testing.T) {
	root := t.TempDir()
	mkdirAll(t, filepath.Join(root, "single"))
	touchAll(t, filepath.Join(root, "single", "1.jpg"))

	mkdirAll(t, filepath.Join(root, "[作者A] vol1"))
	touchAll(t, filepath.Join(root, "[作者A] vol1", "p1.png"))

	mkdirAll(t, filepath.Join(root, "[作者A] vol2"))
	touchAll(t, filepath.Join(root, "[作者A] vol2", "p2.jpg"))

	mkdirAll(t, filepath.Join(root, "[作者B] single"))
	touchAll(t, filepath.Join(root, "[作者B] single", "p3.gif"))

	mkdirAll(t, filepath.Join(root, "coll"))
	mkdirAll(t, filepath.Join(root, "coll", "albumX"))
	touchAll(t, filepath.Join(root, "coll", "albumX", "a.jpg"))
	mkdirAll(t, filepath.Join(root, "coll", "albumY")) // 空

	mkdirAll(t, filepath.Join(root, "empty")) // 完全空

	s := NewScanner()
	res, err := s.Scan(ScanOptions{Roots: []string{root}, MaxDepth: 2})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}

	// 顶层应有 4 个相册 + 1 个集合
	if len(res.Albums) != 4 {
		t.Errorf("expected 4 top-level albums, got %d: %v", len(res.Albums), namesOf(res.Albums))
	}
	if len(res.Collections) != 1 {
		t.Errorf("expected 1 collection, got %d", len(res.Collections))
	}
	if res.Collections[0].AlbumCount != 1 {
		t.Errorf("collection album count: got %d", res.Collections[0].AlbumCount)
	}
	if len(res.Collections[0].Albums) != 1 || res.Collections[0].Albums[0].Name != "albumX" {
		t.Errorf("collection should contain albumX only, got %+v", res.Collections[0].Albums)
	}

	// smartCollection：[作者A] 有 2 个相册，[作者B] 仅 1 个
	if len(res.SmartCollections) != 1 {
		t.Fatalf("expected 1 smartCollection, got %d", len(res.SmartCollections))
	}
	if res.SmartCollections[0].Tag != "作者A" {
		t.Errorf("smart tag: got %q", res.SmartCollections[0].Tag)
	}
	if res.SmartCollections[0].AlbumCount != 2 {
		t.Errorf("smart album count: got %d", res.SmartCollections[0].AlbumCount)
	}

	// 总相册数：4 顶层 + 1 集合内 = 5
	if res.AlbumCount != 5 {
		t.Errorf("total albums: got %d, want 5", res.AlbumCount)
	}
}

// 构造深度超过 maxDepth 的目录树 → 越界后的整条链都应被丢。
// MaxDepth=1 + 3 层(L0/L1/L2, L2 有图):
//   - L0 (curDepth=0) 试图递归到 L1: curDepth+1=1 <= maxDepth=1,OK
//   - L1 (curDepth=1) 试图递归到 L2: curDepth+1=2 > maxDepth=1,NO
//   - L1 没图 → 返回 nil; L0 的子集合是 [] → L0 也返回 nil
//   - 顶层 0 albums 0 collections
func TestScan_DepthLimit(t *testing.T) {
	root := t.TempDir()
	mkdirAll(t, filepath.Join(root, "L0"))
	mkdirAll(t, filepath.Join(root, "L0", "L1"))
	mkdirAll(t, filepath.Join(root, "L0", "L1", "L2"))
	touchAll(t, filepath.Join(root, "L0", "L1", "L2", "x.jpg"))

	s := NewScanner()
	res, err := s.Scan(ScanOptions{Roots: []string{root}, MaxDepth: 1})
	if err != nil {
		t.Fatal(err)
	}

	if len(res.Albums) != 0 {
		t.Errorf("expected 0 albums at top, got %d", len(res.Albums))
	}
	if len(res.Collections) != 0 {
		t.Errorf("expected 0 collections at top (L2 unreachable → 整条链丢), got %d: %+v",
			len(res.Collections), namesOfCols(res.Collections))
	}
}

func TestScan_CoverSelection(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "album")
	mkdirAll(t, dir)
	// 故意打乱命名顺序，确保 CoverImage 是按排序后的首张
	touchAll(t,
		filepath.Join(dir, "z.jpg"),
		filepath.Join(dir, "a.jpg"),
		filepath.Join(dir, "m.jpg"),
	)

	s := NewScanner()
	res, err := s.Scan(ScanOptions{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Albums) != 1 {
		t.Fatalf("expected 1 album, got %d", len(res.Albums))
	}
	want := filepath.Join(dir, "a.jpg")
	if res.Albums[0].CoverImage != want {
		t.Errorf("cover: got %q, want %q", res.Albums[0].CoverImage, want)
	}
	if res.Albums[0].ImageCount != 3 {
		t.Errorf("image count: got %d", res.Albums[0].ImageCount)
	}
}

func TestScan_IgnoresNonImages(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "album")
	mkdirAll(t, dir)
	touchAll(t,
		filepath.Join(dir, "1.jpg"),
		filepath.Join(dir, "notes.txt"),
		filepath.Join(dir, "sub.srt"),
	)

	s := NewScanner()
	res, _ := s.Scan(ScanOptions{Roots: []string{root}})
	if res.Albums[0].ImageCount != 1 {
		t.Errorf("expected 1 image, got %d", res.Albums[0].ImageCount)
	}
}

// 集合内的相册也应进入 smart grouping。
func TestGroupByTag_AcrossCollections(t *testing.T) {
	albums := []models.Album{
		{Name: "[A] 1", Tags: []string{"A"}, ImageCount: 5},
		{Name: "[A] 2", Tags: []string{"A"}, ImageCount: 3},
		{Name: "[A] 3", Tags: []string{"A"}, ImageCount: 1},
		{Name: "[B] 1", Tags: []string{"B"}, ImageCount: 2},
		{Name: "无标签", ImageCount: 1},
	}
	smart := GroupByTag(albums)
	if len(smart) != 1 || smart[0].Tag != "A" {
		t.Fatalf("expected 1 smart collection for A, got %+v", smart)
	}
	if smart[0].AlbumCount != 3 {
		t.Errorf("smart album count: got %d", smart[0].AlbumCount)
	}
	// CoverImage 应该是图片数最多的相册的封面（这里就是第一项）
	if smart[0].CoverImage != albums[0].CoverImage {
		t.Errorf("smart cover should be from largest album")
	}
}

func TestGroupByTag_BelowThreshold(t *testing.T) {
	albums := []models.Album{
		{Name: "[A] 1", Tags: []string{"A"}, ImageCount: 1},
	}
	if got := GroupByTag(albums); len(got) != 0 {
		t.Errorf("expected no smart collection with 1 album, got %d", len(got))
	}
}

// 一本相册带多标签时应同时进入多个合集。
func TestGroupByTag_MultiTagAlbum(t *testing.T) {
	albums := []models.Album{
		{Name: "[A][B] 1", Tags: []string{"A", "B"}, ImageCount: 5},
		{Name: "[A] 2", Tags: []string{"A"}, ImageCount: 3},
		{Name: "[B] 3", Tags: []string{"B"}, ImageCount: 1},
	}
	smart := GroupByTag(albums)
	if len(smart) != 2 {
		t.Fatalf("expected 2 smart collections (A and B), got %d: %+v", len(smart), smart)
	}
	var aCount, bCount int
	for _, s := range smart {
		switch s.Tag {
		case "A":
			aCount = s.AlbumCount
		case "B":
			bCount = s.AlbumCount
		}
	}
	if aCount != 2 {
		t.Errorf("tag A should have 2 albums, got %d", aCount)
	}
	if bCount != 2 {
		t.Errorf("tag B should have 2 albums (第一本同时打 A+B 标签), got %d", bCount)
	}
}

// ExtractTags 行为：返回所有 [tag] 内容，按出现顺序，去空去重 trim。
func TestExtractTags(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"no brackets", "我的图集", nil},
		{"single", "[A] 我的图集", []string{"A"}},
		{"multi", "[A][B] 名字", []string{"A", "B"}},
		{"trimmed", "[ A ] 名字", []string{"A"}},
		{"skip empty", "[] [A] []", []string{"A"}},
		{"unclosed", "[A 名字", nil},
		{"带括号的标签", "[作者 (A)] 标题", []string{"作者 (A)"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ExtractTags(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("ExtractTags(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

// helper: 提取所有 album 的 Name。
func namesOf(albums []models.Album) []string {
	out := make([]string, 0, len(albums))
	for _, a := range albums {
		out = append(out, a.Name)
	}
	sort.Strings(out)
	return out
}

// helper: 提取所有 collection 的 Name。
func namesOfCols(cols []models.Collection) []string {
	out := make([]string, 0, len(cols))
	for _, c := range cols {
		out = append(out, c.Name)
	}
	sort.Strings(out)
	return out
}

// 多根扫描：两个独立根，扫描结果应合并到一起，Album.SourceRoot 正确填充。
func TestScan_MultiRoots(t *testing.T) {
	root1 := t.TempDir()
	root2 := t.TempDir()

	mkdirAll(t, filepath.Join(root1, "r1-album"))
	touchAll(t, filepath.Join(root1, "r1-album", "1.jpg"))

	mkdirAll(t, filepath.Join(root2, "r2-album"))
	touchAll(t, filepath.Join(root2, "r2-album", "1.png"))

	s := NewScanner()
	res, err := s.Scan(ScanOptions{Roots: []string{root1, root2}, MaxDepth: 2})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(res.Albums) != 2 {
		t.Fatalf("expected 2 albums, got %d: %v", len(res.Albums), namesOf(res.Albums))
	}
	if len(res.Roots) != 2 {
		t.Errorf("expected 2 roots in result, got %d", len(res.Roots))
	}
	// 检查每个 album 都有 SourceRoot / SourceName
	for _, a := range res.Albums {
		if a.SourceRoot == "" {
			t.Errorf("album %s missing SourceRoot", a.Name)
		}
		if a.SourceName == "" {
			t.Errorf("album %s missing SourceName", a.Name)
		}
		if a.DisplayName == "" {
			t.Errorf("album %s missing DisplayName", a.Name)
		}
	}
}

// 跨根同名冲突：两个根下都有 "Collection A"，DisplayName 加来源前缀。
func TestScan_MultiRoots_NameConflict(t *testing.T) {
	root1 := t.TempDir()
	root2 := t.TempDir()

	// 两个根都有同名 album "common"
	mkdirAll(t, filepath.Join(root1, "common"))
	touchAll(t, filepath.Join(root1, "common", "1.jpg"))
	mkdirAll(t, filepath.Join(root2, "common"))
	touchAll(t, filepath.Join(root2, "common", "1.png"))

	s := NewScanner()
	res, err := s.Scan(ScanOptions{Roots: []string{root1, root2}})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(res.Albums) != 2 {
		t.Fatalf("expected 2 albums, got %d", len(res.Albums))
	}
	// 两个 DisplayName 应不同（带来源前缀）
	if res.Albums[0].DisplayName == res.Albums[1].DisplayName {
		t.Errorf("expected different DisplayNames, both = %q", res.Albums[0].DisplayName)
	}
	// 但 Name 都是 "common"
	for _, a := range res.Albums {
		if a.Name != "common" {
			t.Errorf("expected Name=common, got %q", a.Name)
		}
	}
}

// 根为 nil/空时返回 error。
func TestScan_MultiRoots_Empty(t *testing.T) {
	s := NewScanner()
	if _, err := s.Scan(ScanOptions{Roots: nil}); err == nil {
		t.Error("expected error for empty roots")
	}
}

// 根不存在时返回 ScanError。
func TestScan_MultiRoots_OneMissing(t *testing.T) {
	root1 := t.TempDir()
	missing := filepath.Join(t.TempDir(), "nope")
	s := NewScanner()
	_, err := s.Scan(ScanOptions{Roots: []string{root1, missing}})
	if err == nil {
		t.Fatal("expected error")
	}
	se, ok := err.(*ScanError)
	if !ok || se.Kind != ScanRootMissing {
		t.Errorf("expected ScanRootMissing, got %v", err)
	}
}

// 目录同时含顶层图片 + 嵌套子目录时,**不**合并到单一相册,而是返回
// Collection:含「散图」虚拟相册(只有顶层文件) + 各子目录原样作为子相册。
// 用户反馈「我需要保留子相册导航」—— 旧版会把 1227 顶层 + 6 子目录
// 2322 张合并成单个 album,用户没法从 2024年 继续下钻到 10.1国庆。
//
// 同时: 顶层没图只有子目录 → 仍是 collection(子目录直接挂为 Albums)。
func TestScan_KeepsSubAlbumNavigation(t *testing.T) {
	root := t.TempDir()

	// 场景 A: 顶层有图 + 有子目录(子目录也有图) → Collection(含散图)
	yearDir := filepath.Join(root, "2024年")
	mkdirAll(t, yearDir)
	// 顶层 2 张
	touchAll(t,
		filepath.Join(yearDir, "top1.jpg"),
		filepath.Join(yearDir, "top2.jpg"),
	)
	// 子目录里再各放几张
	mkdirAll(t, filepath.Join(yearDir, "10.1国庆"))
	touchAll(t,
		filepath.Join(yearDir, "10.1国庆", "a1.jpg"),
		filepath.Join(yearDir, "10.1国庆", "a2.jpg"),
	)
	mkdirAll(t, filepath.Join(yearDir, "12.13"))
	touchAll(t,
		filepath.Join(yearDir, "12.13", "b1.jpg"),
	)

	// 场景 B: 顶层没图 + 有子目录(子目录有图) → Collection(子目录直接挂为 Albums)
	emptyYearDir := filepath.Join(root, "2025年")
	mkdirAll(t, emptyYearDir)
	mkdirAll(t, filepath.Join(emptyYearDir, "sub"))
	touchAll(t, filepath.Join(emptyYearDir, "sub", "c1.jpg"))

	s := NewScanner()
	res, err := s.Scan(ScanOptions{Roots: []string{root}, MaxDepth: 8})
	if err != nil {
		t.Fatal(err)
	}

	// 顶层应 0 个相册 + 2 个集合(2024年 顶层有图+子目录 / 2025年 顶层空+子目录)
	if len(res.Albums) != 0 {
		t.Errorf("expected 0 top-level albums (both years have subdirs), got %d: %v",
			len(res.Albums), namesOf(res.Albums))
	}
	if len(res.Collections) != 2 {
		t.Fatalf("expected 2 collections, got %d: %v", len(res.Collections),
			namesOfCols(res.Collections))
	}

	// 2024年: 散图 2 张 + 10.1国庆 2 张 + 12.13 1 张 = 5 张(分到 3 个子相册)
	var y2024, y2025 *models.Collection
	for i := range res.Collections {
		switch res.Collections[i].Name {
		case "2024年":
			y2024 = &res.Collections[i]
		case "2025年":
			y2025 = &res.Collections[i]
		}
	}
	if y2024 == nil || y2025 == nil {
		t.Fatalf("missing 2024年 or 2025年 collection: %+v", res.Collections)
	}
	if y2024.AlbumCount != 3 {
		t.Errorf("2024年 direct album count: got %d, want 3 (散图+10.1国庆+12.13)",
			y2024.AlbumCount)
	}
	// 第一个子相册是“本目录媒体”，与集合共享真实目录并靠资源 kind 区分。
	if y2024.Albums[0].Name != "本目录媒体" {
		t.Errorf("first sub-album name: got %q, want %q", y2024.Albums[0].Name, "本目录媒体")
	}
	if y2024.Albums[0].ImageCount != 2 {
		t.Errorf("散图 image count: got %d, want 2 (top-level only)", y2024.Albums[0].ImageCount)
	}
	if y2024.Albums[0].Path != y2024.Path || !y2024.Albums[0].Virtual {
		t.Errorf("本目录媒体 should share the collection path and be virtual, got %+v", y2024.Albums[0])
	}
	// 散图必须带上归属目录（相对媒体根），否则扁平列表里几十张散图同名。
	if got := y2024.Albums[0].Location; got != "2024年" {
		t.Errorf("散图 location: got %q, want %q", got, "2024年")
	}
	// 10.1国庆: 2 张
	sub10 := y2024.Albums[1]
	if sub10.Name != "10.1国庆" || sub10.ImageCount != 2 {
		t.Errorf("10.1国庆 album: got %q (%d 张), want 10.1国庆 (2 张)",
			sub10.Name, sub10.ImageCount)
	}
	// 12.13: 1 张
	sub12 := y2024.Albums[2]
	if sub12.Name != "12.13" || sub12.ImageCount != 1 {
		t.Errorf("12.13 album: got %q (%d 张), want 12.13 (1 张)",
			sub12.Name, sub12.ImageCount)
	}

	// 2025年: 顶层 0 张,只一个 sub → 当 collection,挂 1 个子相册
	if y2025.AlbumCount != 1 {
		t.Errorf("2025年 album count: got %d, want 1", y2025.AlbumCount)
	}
	if y2025.Albums[0].Name != "sub" {
		t.Errorf("2025年 sub-album name: got %q, want %q", y2025.Albums[0].Name, "sub")
	}
	if y2025.Albums[0].ImageCount != 1 {
		t.Errorf("2025年 sub-album image count: got %d, want 1", y2025.Albums[0].ImageCount)
	}

	// 总相册数: 2024年含散图+10.1国庆+12.13 = 3,2025年含 sub = 1 → 共 4
	if res.AlbumCount != 4 {
		t.Errorf("total albums count (smart-grouping 用): got %d, want 4", res.AlbumCount)
	}
}

// 多层嵌套 (5 层) 的 collection 树应被完整保留,不被拍平。
// 旧版 merge 路径下,5 层数据靠 merge 强行保留;新版不再 merge,改成
// 通过 Collection.Collections 嵌套保留层级,需要 maxDepth 足够大。
func TestScan_PreservesDeepNestedCollections(t *testing.T) {
	root := t.TempDir()
	// root/2024年/夏威夷-度假/相册/作品/甜片/x.jpg
	// root/2024年/夏威夷-度假/相册/作品/y.jpg
	// root/2024年/夏威夷-度假/相册/作品/甜片 是「作品」下的子目录,含图
	deep := filepath.Join(root, "2024年", "夏威夷-度假", "相册", "作品", "甜片")
	mkdirAll(t, deep)
	touchAll(t, filepath.Join(deep, "x.jpg"))
	// 相册/作品/y.jpg (顶层"作品"目录里 1 张)
	touchAll(t, filepath.Join(root, "2024年", "夏威夷-度假", "相册", "作品", "y.jpg"))
	// 2024年顶层 0 张;夏威夷-度假顶层 0 张;相册顶层 0 张;作品顶层 1 张 + 1 子目录
	s := NewScanner()
	res, err := s.Scan(ScanOptions{Roots: []string{root}, MaxDepth: 8})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Collections) != 1 {
		t.Fatalf("expected 1 top collection, got %d", len(res.Collections))
	}
	c := res.Collections[0]
	if c.Name != "2024年" {
		t.Fatalf("top collection name: %q", c.Name)
	}
	// 2024年 → 夏威夷-度假 (Collection) - 顶层 0 张 + 1 子目录
	if len(c.Collections) != 1 || c.Collections[0].Name != "夏威夷-度假" {
		t.Fatalf("2024年 nested: %+v", c.Collections)
	}
	// 夏威夷-度假 → 相册 (Collection) - 顶层 0 张 + 1 子目录
	haw := c.Collections[0]
	if len(haw.Collections) != 1 || haw.Collections[0].Name != "相册" {
		t.Fatalf("夏威夷-度假 nested: %+v", haw.Collections)
	}
	// 相册 → 作品 (Collection) - 顶层 0 张 + 1 子目录
	gal := haw.Collections[0]
	if len(gal.Collections) != 1 || gal.Collections[0].Name != "作品" {
		t.Fatalf("相册 nested: %+v", gal.Collections)
	}
	// 作品 → 含 y.jpg(顶层 1 张)+ 甜片(子目录,有 1 张)
	// 顶层 1 张 + 有子目录 → Collection:散图(作品) + 甜片(子相册)
	works := gal.Collections[0]
	if len(works.Albums) != 2 {
		t.Fatalf("作品 albums: %+v (want 2: 散图 + 甜片)", works.Albums)
	}
	if works.Albums[0].Name != "本目录媒体" || works.Albums[0].ImageCount != 1 {
		t.Errorf("作品 散图: got %q (%d 张)", works.Albums[0].Name, works.Albums[0].ImageCount)
	}
	if works.Albums[1].Name != "甜片" || works.Albums[1].ImageCount != 1 {
		t.Errorf("作品 甜片: got %q (%d 张)", works.Albums[1].Name, works.Albums[1].ImageCount)
	}
}

// 仅含视频的目录应被识别为 Album，CoverImage 指向首个视频，
// CoverKind="video"，且 FolderSize 含视频体积。
func TestScan_VideoOnlyAlbum(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "vids")
	mkdirAll(t, dir)
	touchAll(t,
		filepath.Join(dir, "a.mp4"),
		filepath.Join(dir, "b.mkv"),
		filepath.Join(dir, "c.webm"),
		filepath.Join(dir, "notes.txt"), // 非媒体应忽略
	)

	s := NewScanner()
	res, err := s.Scan(ScanOptions{Roots: []string{root}})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(res.Albums) != 1 {
		t.Fatalf("expected 1 video album, got %d", len(res.Albums))
	}
	a := res.Albums[0]
	if a.ImageCount != 0 {
		t.Errorf("ImageCount 应为 0, got %d", a.ImageCount)
	}
	if a.VideoCount != 3 {
		t.Errorf("VideoCount 应为 3, got %d", a.VideoCount)
	}
	if a.CoverKind != "video" {
		t.Errorf("CoverKind 应为 video, got %q", a.CoverKind)
	}
	if a.CoverImage != filepath.Join(dir, "a.mp4") {
		t.Errorf("CoverImage 应为排序后的首条视频 %q, got %q", filepath.Join(dir, "a.mp4"), a.CoverImage)
	}
	if len(a.VideoFiles) != 3 {
		t.Errorf("VideoFiles 应有 3 项, got %v", a.VideoFiles)
	}
	if a.FolderSize == 0 {
		t.Errorf("FolderSize 应含视频体积")
	}
}

// 图 + 视频混合相册：CoverImage 仍是首张图，CoverKind=image；
// VideoFiles 单独列出所有视频。
func TestScan_MixedAlbum(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "mix")
	mkdirAll(t, dir)
	touchAll(t,
		filepath.Join(dir, "a.jpg"),
		filepath.Join(dir, "b.jpg"),
		filepath.Join(dir, "clip.mp4"),
	)

	s := NewScanner()
	res, err := s.Scan(ScanOptions{Roots: []string{root}})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(res.Albums) != 1 {
		t.Fatalf("expected 1 album, got %d", len(res.Albums))
	}
	a := res.Albums[0]
	if a.ImageCount != 2 {
		t.Errorf("ImageCount = %d, want 2", a.ImageCount)
	}
	if a.VideoCount != 1 {
		t.Errorf("VideoCount = %d, want 1", a.VideoCount)
	}
	if a.CoverKind != "image" {
		t.Errorf("CoverKind = %q, want image (image wins over video)", a.CoverKind)
	}
	if a.CoverImage != filepath.Join(dir, "a.jpg") {
		t.Errorf("CoverImage 应为 a.jpg, got %q", a.CoverImage)
	}
	if len(a.VideoFiles) != 1 || a.VideoFiles[0] != filepath.Join(dir, "clip.mp4") {
		t.Errorf("VideoFiles 内容错：%v", a.VideoFiles)
	}
}

// 视频扩展名应不与图片冲突；扩展名归一化大小写。
func TestScan_VideoExtsCaseInsensitive(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "x")
	mkdirAll(t, dir)
	touchAll(t,
		filepath.Join(dir, "a.MP4"),
		filepath.Join(dir, "b.WebM"),
	)
	s := NewScanner()
	res, err := s.Scan(ScanOptions{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Albums) != 1 || res.Albums[0].VideoCount != 2 {
		t.Fatalf("expected 1 album w/ 2 videos, got %+v", res.Albums)
	}
}

// ---- Exclude 规则集成测试 ----
//
// 构造一个混合目录：
//
//	root/
//	  real/                <- 应保留
//	    1.jpg
//	  .git/                <- 隐藏目录,默认跳
//	    config
//	  .cache/              <- 隐藏目录
//	    real2/             <- 即使有真图也不进
//	      x.jpg
//	  node_modules/        <- 用户 pattern 跳
//	    dep/
//	      y.jpg
//	  with_thumbsdb/       <- 文件层 Thumbs.db 命中
//	    2.jpg
//	    Thumbs.db          <- 永远被白名单命中
//	    .DS_Store          <- 永远被白名单命中
func TestScan_ExcludeRules_Default(t *testing.T) {
	root := t.TempDir()

	mkdirAll(t, filepath.Join(root, "real"))
	touchAll(t, filepath.Join(root, "real", "1.jpg"))

	// .git(隐藏)里有任意文件,都不应该被扫到
	mkdirAll(t, filepath.Join(root, ".git"))
	touchAll(t, filepath.Join(root, ".git", "config"))

	mkdirAll(t, filepath.Join(root, ".cache", "real2"))
	touchAll(t, filepath.Join(root, ".cache", "real2", "x.jpg"))

	mkdirAll(t, filepath.Join(root, "node_modules", "dep"))
	touchAll(t, filepath.Join(root, "node_modules", "dep", "y.jpg"))

	mkdirAll(t, filepath.Join(root, "with_thumbsdb"))
	touchAll(t,
		filepath.Join(root, "with_thumbsdb", "2.jpg"),
		filepath.Join(root, "with_thumbsdb", "Thumbs.db"),
		filepath.Join(root, "with_thumbsdb", ".DS_Store"),
	)

	s := NewScanner()
	// 不传 Exclude → 走 handler 层 normalize 后的等价 default
	res, err := s.Scan(ScanOptions{
		Roots:    []string{root},
		MaxDepth: 4,
		Exclude:  NormalizeExcludeConfig(true, nil, nil),
	})
	if err != nil {
		t.Fatal(err)
	}

	// 只剩 real + with_thumbsdb 两个顶层 album;
	// 内部仍各 1 张图(Thumbs.db / .DS_Store 不计)
	if len(res.Albums) != 2 {
		names := namesOf(res.Albums)
		t.Fatalf("expected 2 albums, got %d: %v", len(res.Albums), names)
	}
	for _, a := range res.Albums {
		if a.ImageCount != 1 {
			t.Errorf("album %s: expected 1 image, got %d (Thumbs.db / .DS_Store should not count)",
				a.Name, a.ImageCount)
		}
	}

	// 关键:既无 .git 也无 .cache 也无 node_modules
	for _, n := range namesOf(res.Albums) {
		switch n {
		case ".git", ".cache", "node_modules":
			t.Errorf("excluded dir leaked into result: %q", n)
		}
	}
}

// 用户 pattern 应能跳过自定义目录;SkipHidden 关闭时不再默认跳隐藏目录。
func TestScan_ExcludeRules_UserPattern(t *testing.T) {
	root := t.TempDir()

	mkdirAll(t, filepath.Join(root, "real"))
	touchAll(t, filepath.Join(root, "real", "1.jpg"))
	mkdirAll(t, filepath.Join(root, "node_modules"))
	touchAll(t, filepath.Join(root, "node_modules", "x.jpg"))
	mkdirAll(t, filepath.Join(root, "Backup2024"))
	touchAll(t, filepath.Join(root, "Backup2024", "y.jpg"))
	// 隐藏目录,SkipHidden=false 时应被扫到
	mkdirAll(t, filepath.Join(root, ".secret"))
	touchAll(t, filepath.Join(root, ".secret", "z.jpg"))

	s := NewScanner()
	res, err := s.Scan(ScanOptions{
		Roots:    []string{root},
		MaxDepth: 4,
		Exclude:  NormalizeExcludeConfig(false, nil, []string{"node_modules", "Backup*"}),
	})
	if err != nil {
		t.Fatal(err)
	}

	// 应有 real + .secret 两个 album,node_modules / Backup2024 都不见
	if len(res.Albums) != 2 {
		names := namesOf(res.Albums)
		t.Fatalf("expected 2 albums (real + .secret), got %d: %v", len(res.Albums), names)
	}
	for _, n := range namesOf(res.Albums) {
		switch n {
		case "node_modules":
			t.Errorf("user pattern 'node_modules' should have been applied")
		}
		if strings.HasPrefix(n, "Backup") {
			t.Errorf("glob 'Backup*' should have skipped %q", n)
		}
	}
}

// 排除规则在嵌套目录树里也生效:子目录被 skip,不会进 album / collection。
func TestScan_ExcludeRules_Nested(t *testing.T) {
	root := t.TempDir()
	mkdirAll(t, filepath.Join(root, "year-2024"))
	mkdirAll(t, filepath.Join(root, "year-2024", ".git"))
	touchAll(t, filepath.Join(root, "year-2024", ".git", "config"))
	mkdirAll(t, filepath.Join(root, "year-2024", "march"))
	touchAll(t, filepath.Join(root, "year-2024", "march", "1.jpg"))

	s := NewScanner()
	res, err := s.Scan(ScanOptions{
		Roots:    []string{root},
		MaxDepth: 4,
		Exclude:  NormalizeExcludeConfig(true, nil, nil),
	})
	if err != nil {
		t.Fatal(err)
	}

	// year-2024 应当是 collection(因为 march 里有图);.git 不该出现
	if len(res.Collections) != 1 || res.Collections[0].Name != "year-2024" {
		t.Fatalf("expected 1 collection 'year-2024', got %+v", namesOfCols(res.Collections))
	}
	coll := res.Collections[0]
	for _, a := range coll.Albums {
		if a.Name == ".git" {
			t.Error(".git nested under year-2024 should have been skipped")
		}
	}
}

// TestScan_FolderSizeAccurate 验证 buildAlbum 在 N+1 stat 优化后
// FolderSize 仍正确(等于相册内图片+视频字节数之和)。
//
// 旧实现对每张图/视频都 os.Stat 一次,本测试用未对齐大小的文件做
// sanity check:如果哪天有人把 size 累加写错(忘了加 videos / 重复
// 加 images),这条会立即失败。
func TestScan_FolderSizeAccurate(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "mixed")
	mkdirAll(t, dir)
	touchAll(t,
		filepath.Join(dir, "a.jpg"),
		filepath.Join(dir, "b.png"),
		filepath.Join(dir, "c.mp4"),
	)
	// 写入确定大小的内容,避免 touchAll 用同一个 "fake" 字节
	sizes := map[string]int{
		"a.jpg": 100,
		"b.png": 250,
		"c.mp4": 1000,
	}
	for name, n := range sizes {
		buf := make([]byte, n)
		if err := os.WriteFile(filepath.Join(dir, name), buf, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	s := NewScanner()
	res, err := s.Scan(ScanOptions{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Albums) != 1 {
		t.Fatalf("expected 1 album, got %d", len(res.Albums))
	}
	want := int64(100 + 250 + 1000)
	if res.Albums[0].FolderSize != want {
		t.Errorf("FolderSize: got %d, want %d", res.Albums[0].FolderSize, want)
	}
}

// TestScanner_BranchedDeepTreeCompletes 回归旧递归信号量死锁：多个父目录
// 同时占满令牌并等待子层时，子任务永远无法开始。
func TestScanner_BranchedDeepTreeCompletes(t *testing.T) {
	root := t.TempDir()
	var create func(parent string, depth int)
	create = func(parent string, depth int) {
		if depth == 0 {
			touchAll(t, filepath.Join(parent, "page.jpg"))
			return
		}
		for i := 1; i <= 3; i++ {
			child := filepath.Join(parent, fmt.Sprintf("level-%d", i))
			mkdirAll(t, child)
			create(child, depth-1)
		}
	}
	create(root, 5)

	type outcome struct {
		result *models.ScanResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		result, err := NewScanner().Scan(ScanOptions{Roots: []string{root}})
		done <- outcome{result: result, err: err}
	}()
	select {
	case got := <-done:
		if got.err != nil {
			t.Fatal(got.err)
		}
		if got.result.AlbumCount != 243 {
			t.Fatalf("AlbumCount=%d, want 243", got.result.AlbumCount)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("branched deep scan timed out; worker pool may be deadlocked")
	}
}

func TestScan_RootMixedContentKeepsLooseMedia(t *testing.T) {
	root := t.TempDir()
	touchAll(t, filepath.Join(root, "root-page.jpg"))
	mkdirAll(t, filepath.Join(root, "child"))
	touchAll(t, filepath.Join(root, "child", "page.jpg"))

	result, err := NewScanner().Scan(ScanOptions{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Albums) != 2 {
		t.Fatalf("top albums=%d, want loose root + child", len(result.Albums))
	}
	if !result.Albums[0].Virtual || result.Albums[0].Name != "本目录媒体" {
		t.Fatalf("root loose album=%+v", result.Albums[0])
	}
	if result.Albums[0].Path != root {
		t.Fatalf("virtual album must resolve to physical root: %q", result.Albums[0].Path)
	}
	// 根目录自身的散图用根目录名做归属标识（相对路径是 "."，没有意义）。
	if got := result.Albums[0].Location; got != filepath.Base(root) {
		t.Fatalf("root loose album location=%q, want %q", got, filepath.Base(root))
	}
}

// TestScan_VirtualAlbumLocationIsRelativePath 验证多层嵌套下散图的
// Location 是「相对媒体根的目录路径」，而不是只有 basename：
// 不同父目录下可能存在同名目录，只有完整相对路径能唯一标识。
func TestScan_VirtualAlbumLocationIsRelativePath(t *testing.T) {
	root := t.TempDir()
	// <root>/2020年/子目录 同时有散图和子目录 → 集合 + 散图
	nested := filepath.Join(root, "2020年", "子目录")
	mkdirAll(t, nested)
	touchAll(t, filepath.Join(nested, "a.jpg"))
	mkdirAll(t, filepath.Join(nested, "更深"))
	touchAll(t, filepath.Join(nested, "更深", "b.jpg"))

	result, err := NewScanner().Scan(ScanOptions{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	var found string
	var walk func(cols []models.Collection)
	walk = func(cols []models.Collection) {
		for _, c := range cols {
			for _, a := range c.Albums {
				if a.Virtual {
					found = a.Location
				}
			}
			walk(c.Collections)
		}
	}
	walk(result.Collections)
	if found != "2020年/子目录" {
		t.Fatalf("散图 location=%q, want %q", found, "2020年/子目录")
	}
}

func TestScan_NaturalMediaOrder(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "album")
	mkdirAll(t, dir)
	touchAll(t,
		filepath.Join(dir, "page10.jpg"),
		filepath.Join(dir, "page2.jpg"),
		filepath.Join(dir, "page1.jpg"),
	)
	result, err := NewScanner().Scan(ScanOptions{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"page1.jpg", "page2.jpg", "page10.jpg"}
	for i, path := range result.Albums[0].ImageFiles {
		if filepath.Base(path) != want[i] {
			t.Fatalf("natural order[%d]=%q, want %q", i, filepath.Base(path), want[i])
		}
	}
}
