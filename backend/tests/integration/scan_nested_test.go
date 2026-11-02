package integration_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/tianlongxiang/local-gallery/internal/config"
	"github.com/tianlongxiang/local-gallery/internal/handlers"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func TestNestedRootsPublishUniqueOwnedAlbumsAndReadableMedia(t *testing.T) {
	h := newHarness(t)
	child := filepath.Join(h.root, "[作者A] vol1")
	roots := []string{h.root, child}
	_, validator := middleware.PathSafetyMiddleware(roots)
	h.app.Get("/api/media/:id", middleware.ResourceParam(h.catalog, validator), handlers.MediaHandler(nil, nil, nil))
	if _, err := h.mgr.Update(config.ConfigPatch{MediaRoots: roots, MediaRootsSet: true}); err != nil {
		t.Fatal(err)
	}
	cachePath := filepath.Join(h.cache, "nested-scan.json")
	cache := services.NewScanResultCache(cachePath)
	h.runner.SetCache(cache)
	res, body := h.do(t, http.MethodPost, "/api/scans", nil)
	var started struct {
		ScanID string `json:"scanId"`
	}
	if res.StatusCode != http.StatusOK || json.Unmarshal(body, &started) != nil || started.ScanID == "" {
		t.Fatalf("scan start status=%d body=%s", res.StatusCode, body)
	}
	res, stream := h.do(t, http.MethodGet, "/api/scans/"+started.ScanID+"/events", nil)
	if res.StatusCode != http.StatusOK || !bytes.Contains(stream, []byte("event: complete")) || !bytes.Contains(stream, []byte(`"albumsFound":2`)) {
		t.Fatalf("nested scan did not complete with unique count: status=%d stream=%s", res.StatusCode, stream)
	}
	res, body = h.do(t, http.MethodGet, "/api/library/manifest", nil)
	var manifest struct {
		Manifest services.LibraryManifest `json:"manifest"`
	}
	if res.StatusCode != http.StatusOK || json.Unmarshal(body, &manifest) != nil || manifest.Manifest.Statistics.AlbumCount != 2 || manifest.Manifest.Statistics.RootCount != 2 {
		t.Fatalf("nested manifest inconsistent: status=%d body=%s", res.StatusCode, body)
	}
	seen := make(map[string]bool)
	for _, root := range manifest.Manifest.Roots {
		res, body = h.do(t, http.MethodGet, "/api/library/"+root.ID+"/children", nil)
		var nodes struct {
			Page services.LibraryPage[services.LibraryNodeSummary] `json:"page"`
		}
		if res.StatusCode != http.StatusOK || json.Unmarshal(body, &nodes) != nil || nodes.Page.Total != 1 || len(nodes.Page.Items) != 1 {
			t.Fatalf("nested root children duplicated: status=%d body=%s", res.StatusCode, body)
		}
		album := nodes.Page.Items[0]
		if album.Kind != "album" || album.SourceRoot != root.ID || seen[album.ID] {
			t.Fatalf("nested album ownership inconsistent: %+v", album)
		}
		seen[album.ID] = true
		res, body = h.do(t, http.MethodGet, "/api/albums/"+album.ID+"/media", nil)
		var media struct {
			Page services.LibraryPage[services.LibraryMediaItem] `json:"page"`
		}
		if res.StatusCode != http.StatusOK || json.Unmarshal(body, &media) != nil || len(media.Page.Items) == 0 {
			t.Fatalf("nested album media missing: status=%d body=%s", res.StatusCode, body)
		}
		res, image := h.do(t, http.MethodGet, "/api/media/"+media.Page.Items[0].ID, nil)
		if res.StatusCode != http.StatusOK || len(image) == 0 {
			t.Fatalf("nested source image unreadable: status=%d", res.StatusCode)
		}
	}
	if err := cache.Flush(); err != nil {
		t.Fatal(err)
	}
	loaded := services.NewScanResultCache(cachePath)
	mismatch, err := loaded.LoadWithRoots(roots)
	if err != nil || mismatch || loaded.Get() == nil || loaded.Get().AlbumCount != len(seen) {
		t.Fatalf("valid nested scan failed cache recovery: mismatch=%t err=%v", mismatch, err)
	}
}
