package services

import (
	"testing"
)

// TestLibrarySummaryCarriesParentCollection 验证节点摘要带出直接上级集合的 ID。
//
// 背景：集合页要拼面包屑（存照 / 萍乡中学 / 3班running man）。名字给人看，
// ID 才能让前端继续往上找；两者是同一件事的两种形式。
func TestLibrarySummaryCarriesParentCollection(t *testing.T) {
	fixture := newLibraryPageFixture(t)
	snapshot := fixture.catalog.Acquire()

	children, err := PageLibraryChildren(snapshot, fixture.rootID, LibraryKindComic, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	var collectionID string
	for i := range children.Items {
		if children.Items[i].Kind == string(ResourceCollection) {
			collectionID = children.Items[i].ID
		}
	}
	if collectionID == "" {
		t.Fatal("夹具里没有集合")
	}

	// 顶层集合的直接上级是媒体根，不是集合：没有 parentId。
	summary, ok := snapshot.AlbumSummary(fixture.albumID)
	if !ok {
		t.Fatal("读不到相册摘要")
	}
	if summary.ParentID != "" {
		t.Fatalf("顶层相册 parentId=%q, 应为空", summary.ParentID)
	}
	nodes, err := ResolveLibraryNodes(snapshot, []string{collectionID})
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes.Items) != 1 || nodes.Items[0].ParentID != "" {
		t.Fatalf("顶层集合 parentId=%+v, 应为空", nodes.Items)
	}

	// 集合里的相册：上级就是那个集合。
	nested, err := PageLibraryChildren(snapshot, collectionID, LibraryKindComic, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	var nestedAlbumID string
	for i := range nested.Items {
		if nested.Items[i].Kind == string(ResourceAlbum) {
			nestedAlbumID = nested.Items[i].ID
		}
	}
	if nestedAlbumID == "" {
		t.Fatal("集合里没有相册")
	}
	nestedSummary, ok := snapshot.AlbumSummary(nestedAlbumID)
	if !ok {
		t.Fatal("读不到相册摘要")
	}
	if nestedSummary.ParentID != collectionID {
		t.Fatalf("子相册 parentId=%q, 期望 %q", nestedSummary.ParentID, collectionID)
	}
	if nestedSummary.ParentName != "collection3" {
		t.Fatalf("子相册 parentName=%q", nestedSummary.ParentName)
	}
}
