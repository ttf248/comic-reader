package services

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

func TestLibraryQueryPayloadBudget(t *testing.T) {
	for _, size := range []int{1000, 10000, 50000} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			root := t.TempDir()
			albums := make([]models.Album, size)
			for i := range albums {
				albums[i] = models.Album{Type: "album", Path: filepath.Join(root, fmt.Sprintf("album-%05d", i)), Name: fmt.Sprintf("album-%05d", i), SourceRoot: root, ImageCount: 10}
			}
			catalog := NewResourceCatalog()
			catalog.SetContentKindPolicy(NewContentKindPolicy([]RootKind{{Path: root, Kind: models.ContentKindPhoto}}))
			catalog.Publish(&models.ScanResult{Roots: []string{root}, Albums: albums, AlbumCount: size}, []string{root})
			snapshot := catalog.Acquire()
			baseline, _ := json.Marshal(snapshot.state.library.children[snapshot.state.roots[0].ID])
			start := time.Now()
			page, err := PageLibraryQuery(snapshot, LibraryQuery{Kind: LibraryKindPhoto}, nil, "", 200)
			cold := time.Since(start)
			if err != nil {
				t.Fatal(err)
			}
			data, _ := json.Marshal(page)
			if size >= 10000 && len(data)*5 > len(baseline) {
				t.Fatalf("payload reduction below 80%%: %d vs %d", len(data), len(baseline))
			}
			times := make([]time.Duration, 100)
			for i := range times {
				start = time.Now()
				if _, err := PageLibraryQuery(snapshot, LibraryQuery{Kind: LibraryKindPhoto}, nil, page.NextCursor, 200); err != nil {
					t.Fatal(err)
				}
				times[i] = time.Since(start)
			}
			sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
			t.Logf("samples=%d baselineBytes=%d firstPageBytes=%d cold=%s warmP95=%s", size, len(baseline), len(data), cold, times[94])
		})
	}
}

func TestLibraryQueryPaginationFiltersAndHistory(t *testing.T) {
	f := newLibraryPageFixture(t)
	snapshot := f.catalog.Acquire()
	q := LibraryQuery{Kind: LibraryKindComic, View: "album", Sort: "name"}
	first, err := PageLibraryQuery(snapshot, q, nil, "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if first.Total != 2 || len(first.Items) != 1 || first.Items[0].Node.Name != "album2" || first.NextCursor == "" {
		t.Fatalf("unexpected first page: %+v", first)
	}
	if first.Counts["all"] != 4 || first.Counts["collection"] != 1 || first.Counts["smart"] != 1 {
		t.Fatalf("counts: %+v", first.Counts)
	}
	second, err := PageLibraryQuery(snapshot, q, nil, first.NextCursor, 1)
	if err != nil || second.Items[0].Node.Name != "album10" {
		t.Fatalf("second: %+v %v", second, err)
	}
	q.Query = "旅行"
	if _, err = PageLibraryQuery(snapshot, q, nil, first.NextCursor, 1); !errors.Is(err, ErrInvalidPageCursor) {
		t.Fatalf("query must bind cursor: %v", err)
	}
	q.Query = ""
	q.MinImageCount = 2
	page, err := PageLibraryQuery(snapshot, q, nil, "", 10)
	if err != nil || page.Total != 1 || page.Counts["smart"] != 1 {
		t.Fatalf("minimum filter: %+v %v", page, err)
	}
	q.MinImageCount = 0
	q.Sort = "viewed"
	history := []models.HistoryEntry{{AlbumID: second.Items[0].Node.ID, OpenedAt: time.Now()}}
	page, err = PageLibraryQuery(snapshot, q, history, "", 1)
	if err != nil || page.Items[0].Node.Name != "album10" {
		t.Fatalf("viewed: %+v %v", page, err)
	}
	history[0].OpenedAt = history[0].OpenedAt.Add(time.Second)
	if _, err = PageLibraryQuery(snapshot, q, history, page.NextCursor, 1); !errors.Is(err, ErrInvalidPageCursor) {
		t.Fatalf("history must bind cursor: %v", err)
	}
	q.Kind = LibraryKindPhoto
	page, err = PageLibraryQuery(snapshot, q, nil, "", 10)
	if err != nil || page.Total != 0 {
		t.Fatalf("mode isolation: %+v %v", page, err)
	}
}

func TestLibraryQueryCollectionTagAndValidation(t *testing.T) {
	f := newLibraryPageFixture(t)
	for _, q := range []LibraryQuery{{Kind: LibraryKindComic, Parent: f.collectionID}, {Kind: LibraryKindComic, Tag: "旅行"}} {
		page, err := PageLibraryQuery(f.catalog.Acquire(), q, nil, "", 1)
		if err != nil || len(page.Items) != 1 {
			t.Fatalf("query %+v: %+v %v", q, page, err)
		}
	}
	for _, q := range []LibraryQuery{{Kind: LibraryKindComic, Sort: "unknown"}, {Kind: LibraryKindComic, Year: "NaN"}, {Kind: LibraryKindComic, MinImageCount: -1}, {Kind: LibraryKindComic, Parent: "a", Tag: "b"}} {
		if _, err := PageLibraryQuery(f.catalog.Acquire(), q, nil, "", 10); !errors.Is(err, ErrInvalidLibraryQuery) {
			t.Fatalf("invalid query %+v: %v", q, err)
		}
	}
}

func TestLibraryQueryCachedPagesAreIndependent(t *testing.T) {
	f := newLibraryPageFixture(t)
	q := LibraryQuery{Kind: LibraryKindComic, Tag: "旅行"}
	page, err := PageLibraryQuery(f.catalog.Acquire(), q, nil, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	id := page.Items[0].Node.ID
	if count := QueryCompletedCount(f.catalog.Acquire(), q, []models.Activity{{AlbumID: id, MediaKind: models.MediaKindImage, Status: models.ActivityCompleted}}); count != 1 {
		t.Fatalf("completed=%d", count)
	}
	page.Items[0].Node.Name = "changed"
	page.Counts["all"] = 100
	page.ScopeCounts["album"] = 100
	next, err := PageLibraryQuery(f.catalog.Acquire(), q, nil, "", 10)
	if err != nil || next.Items[0].Node.Name == "changed" || next.Counts["all"] != 2 || next.ScopeCounts["album"] != 2 {
		t.Fatalf("cached result mutated: %+v %v", next, err)
	}
}

func BenchmarkLibraryQueryPayload(b *testing.B) {
	root := b.TempDir()
	albums := make([]models.Album, 10000)
	for i := range albums {
		albums[i] = models.Album{Type: "album", Path: filepath.Join(root, fmt.Sprintf("item-%05d", i)), Name: fmt.Sprintf("item-%05d", i), SourceRoot: root, ImageCount: 10}
	}
	catalog := NewResourceCatalog()
	catalog.SetContentKindPolicy(NewContentKindPolicy([]RootKind{{Path: root, Kind: models.ContentKindPhoto}}))
	catalog.Publish(&models.ScanResult{Roots: []string{root}, Albums: albums, AlbumCount: len(albums)}, []string{root})
	snapshot := catalog.Acquire()
	q := LibraryQuery{Kind: LibraryKindPhoto}
	_, _ = PageLibraryQuery(snapshot, q, nil, "", 200)
	for _, full := range []bool{true, false} {
		b.Run(fmt.Sprintf("full=%t", full), func(b *testing.B) {
			b.ReportAllocs()
			durations := make([]time.Duration, 0, b.N)
			for i := 0; i < b.N; i++ {
				start := time.Now()
				if full {
					_, _ = json.Marshal(snapshot.state.library.children[snapshot.state.roots[0].ID])
				} else {
					page, err := PageLibraryQuery(snapshot, q, nil, "", 200)
					if err != nil {
						b.Fatal(err)
					}
					_, _ = json.Marshal(page)
				}
				durations = append(durations, time.Since(start))
			}
			sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
			b.ReportMetric(float64(durations[(len(durations)-1)*95/100].Nanoseconds()), "p95-ns")
		})
	}
}
