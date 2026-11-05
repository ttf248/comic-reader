package services

import (
	"path/filepath"
	"runtime"
	"testing"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// 属性策略的路径归一化必须与「这个文件属于哪个根」共用同一套规则，
// 否则同一个目录会得到两个不同的属性。

func TestNewContentKindPolicyNormalizesRootPaths(t *testing.T) {
	root := filepath.Join(t.TempDir(), "photos")
	policy := NewContentKindPolicy([]RootKind{
		{Path: root, Kind: models.ContentKindComic},
		// 同一目录的其它写法：相对路径、冗余分隔符、尾斜杠、大小写。
		{Path: root + string(filepath.Separator), Kind: models.ContentKindPhoto},
	})

	// 尾斜杠那条后写入，覆盖前一条：同一根只有一条记录。
	if got := len(policy.Roots); got != 1 {
		t.Fatalf("roots=%d want 1", got)
	}
	if got := policy.KindFor(root); got != models.ContentKindPhoto {
		t.Fatalf("kind=%q want photo", got)
	}
	// 冗余分隔符与尾斜杠是同一个根。
	noisy := root + string(filepath.Separator) + "." + string(filepath.Separator)
	if got := policy.KindFor(noisy); got != models.ContentKindPhoto {
		t.Fatalf("noisy kind=%q want photo", got)
	}
}

func TestContentKindPolicyFoldsCasePerPlatform(t *testing.T) {
	root := filepath.Join(t.TempDir(), "photos")
	policy := NewContentKindPolicy([]RootKind{
		{Path: root, Kind: models.ContentKindComic},
	})
	upper := filepath.Join(filepath.Dir(root), "PHOTOS")
	got := policy.KindFor(upper)
	if runtime.GOOS == "windows" {
		if got != models.ContentKindComic {
			t.Fatalf("kind=%q want comic on windows", got)
		}
		return
	}
	if got != models.DefaultContentKind {
		t.Fatalf("kind=%q want default on %s", got, runtime.GOOS)
	}
}

func TestContentKindPolicyKindForUnknownRootFallsBackToDefault(t *testing.T) {
	policy := NewContentKindPolicy([]RootKind{
		{Path: filepath.Join(t.TempDir(), "photos"), Kind: models.ContentKindComic},
	})
	unknown := filepath.Join(t.TempDir(), "elsewhere")
	if got := policy.KindFor(unknown); got != models.DefaultContentKind {
		t.Fatalf("kind=%q want default", got)
	}
	if got := policy.KindFor(""); got != models.DefaultContentKind {
		t.Fatalf("empty kind=%q want default", got)
	}
	// 零值策略（空 map）等同于「默认按照片处理」。
	var zero ContentKindPolicy
	if got := zero.KindFor("anything"); got != models.DefaultContentKind {
		t.Fatalf("zero policy kind=%q want default", got)
	}
}

// 空路径条目不登记：它不指向任何媒体根。
func TestNewContentKindPolicySkipsEmptyPaths(t *testing.T) {
	policy := NewContentKindPolicy([]RootKind{
		{Path: "  ", Kind: models.ContentKindComic},
	})
	if got := len(policy.Roots); got != 0 {
		t.Fatalf("roots=%d want 0", got)
	}
}

// ApplyContentKinds 必须写回相册、集合与智能合集里的相册三处：
// 同一本相册在根列表、集合视图与智能合集里各有一份拷贝，
// 漏写一处就会让同一本相册在不同视图里显示不同属性。
func TestApplyContentKindsWritesEveryCopy(t *testing.T) {
	photoRoot := filepath.Join(t.TempDir(), "photos")
	comicRoot := filepath.Join(t.TempDir(), "comics")

	album := func(path, name, root string) models.Album {
		return models.Album{Type: "album", Path: path, Name: name, SourceRoot: root}
	}
	photoAlbum := album(filepath.Join(photoRoot, "p"), "p", photoRoot)
	comicAlbum := album(filepath.Join(comicRoot, "c"), "c", comicRoot)

	result := &models.ScanResult{
		Roots:   []string{photoRoot, comicRoot},
		Albums:  []models.Album{photoAlbum, comicAlbum},
		Collections: []models.Collection{{
			Type: "collection", Path: filepath.Join(comicRoot, "shelf"), Name: "shelf",
			SourceRoot: comicRoot,
			Albums:     []models.Album{comicAlbum},
			Collections: []models.Collection{{
				Type: "collection", Path: filepath.Join(comicRoot, "shelf", "sub"), Name: "sub",
				SourceRoot: comicRoot,
				Albums:     []models.Album{comicAlbum},
			}},
		}},
		SmartCollections: []models.SmartCollection{{
			Type: "smartCollection", Tag: "共同",
			Albums: []models.Album{photoAlbum, comicAlbum},
		}},
	}

	ApplyContentKinds(result, NewContentKindPolicy([]RootKind{
		{Path: photoRoot, Kind: models.ContentKindPhoto},
		{Path: comicRoot, Kind: models.ContentKindComic},
	}))

	if got := result.Albums[0].ContentKind; got != string(models.ContentKindPhoto) {
		t.Fatalf("album kind=%q want photo", got)
	}
	if got := result.Albums[1].ContentKind; got != string(models.ContentKindComic) {
		t.Fatalf("album kind=%q want comic", got)
	}
	collection := result.Collections[0]
	if got := collection.ContentKind; got != string(models.ContentKindComic) {
		t.Fatalf("collection kind=%q want comic", got)
	}
	if got := collection.Albums[0].ContentKind; got != string(models.ContentKindComic) {
		t.Fatalf("collection album kind=%q want comic", got)
	}
	nested := collection.Collections[0]
	if got := nested.ContentKind; got != string(models.ContentKindComic) {
		t.Fatalf("nested collection kind=%q want comic", got)
	}
	if got := nested.Albums[0].ContentKind; got != string(models.ContentKindComic) {
		t.Fatalf("nested album kind=%q want comic", got)
	}
	smart := result.SmartCollections[0]
	if got := smart.Albums[0].ContentKind; got != string(models.ContentKindPhoto) {
		t.Fatalf("smart album[0] kind=%q want photo", got)
	}
	if got := smart.Albums[1].ContentKind; got != string(models.ContentKindComic) {
		t.Fatalf("smart album[1] kind=%q want comic", got)
	}
}

// nil 结果不应 panic：扫描还没产出任何东西时也会走到这里。
func TestApplyContentKindsIgnoresNilResult(t *testing.T) {
	ApplyContentKinds(nil, NewContentKindPolicy(nil))
}
