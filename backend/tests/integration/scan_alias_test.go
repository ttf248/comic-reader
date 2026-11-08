package integration_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/tianlongxiang/local-gallery/internal/config"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func TestEquivalentRootConfigurationKeepsRevisionAndUniqueChildren(t *testing.T) {
	h := newHarness(t)
	t.Chdir(filepath.Dir(h.root))
	scan := func() []byte {
		t.Helper()
		res, body := h.do(t, http.MethodPost, "/api/scans", nil)
		var started struct {
			ScanID string `json:"scanId"`
		}
		if res.StatusCode != http.StatusOK || json.Unmarshal(body, &started) != nil || started.ScanID == "" {
			t.Fatalf("scan start status=%d body=%s", res.StatusCode, body)
		}
		res, stream := h.do(t, http.MethodGet, "/api/scans/"+started.ScanID+"/events", nil)
		if res.StatusCode != http.StatusOK || !bytes.Contains(stream, []byte("event: complete")) {
			t.Fatalf("scan did not publish: status=%d stream=%s", res.StatusCode, stream)
		}
		res, body = h.do(t, http.MethodGet, "/api/library/manifest", nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("manifest status=%d body=%s", res.StatusCode, body)
		}
		return body
	}
	before := scan()
	roots := []string{filepath.Base(h.root), h.root}
	if runtime.GOOS == "windows" {
		roots = append(roots, strings.ToUpper(h.root))
	}
	configuredRoots := mediaRootsOf(roots)
	for i := range configuredRoots {
		configuredRoots[i].Kind = "comic"
	}
	res, body := h.do(t, http.MethodPut, "/api/config", map[string]any{"mediaRoots": configuredRoots})
	var updated struct {
		MediaRootsChanged bool `json:"mediaRootsChanged"`
		Config            struct {
			MediaRoots []config.MediaRoot `json:"mediaRoots"`
		} `json:"config"`
	}
	if res.StatusCode != http.StatusOK || json.Unmarshal(body, &updated) != nil {
		t.Fatalf("config status=%d body=%s", res.StatusCode, body)
	}
	if updated.MediaRootsChanged || len(updated.Config.MediaRoots) != 1 || updated.Config.MediaRoots[0].Path != h.root {
		t.Fatalf("equivalent roots reported a configuration change: %s", body)
	}
	_, after := h.do(t, http.MethodGet, "/api/library/manifest", nil)
	if !bytes.Equal(before, after) {
		t.Fatalf("alias-only save changed published manifest: %s", after)
	}
	rescanned := scan()
	var manifest struct {
		Manifest services.LibraryManifest `json:"manifest"`
	}
	if err := json.Unmarshal(rescanned, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Manifest.Statistics.AlbumCount != 2 || manifest.Manifest.Statistics.RootCount != 1 {
		t.Fatalf("root aliases duplicated scan: %+v", manifest.Manifest.Statistics)
	}
	res, body = h.do(t, http.MethodGet, "/api/library/"+manifest.Manifest.Roots[0].ID+"/children?limit=1&kind=comic", nil)
	var page struct {
		Page services.LibraryPage[services.LibraryNodeSummary] `json:"page"`
	}
	if res.StatusCode != http.StatusOK || json.Unmarshal(body, &page) != nil || page.Page.Total != 2 || len(page.Page.Items) != 1 || page.Page.NextCursor == "" {
		t.Fatalf("invalid children page: status=%d body=%s", res.StatusCode, body)
	}
	firstID := page.Page.Items[0].ID
	res, body = h.do(t, http.MethodGet, "/api/library/"+manifest.Manifest.Roots[0].ID+"/children?limit=1&kind=comic&cursor="+page.Page.NextCursor, nil)
	page.Page = services.LibraryPage[services.LibraryNodeSummary]{}
	if res.StatusCode != http.StatusOK || json.Unmarshal(body, &page) != nil || len(page.Page.Items) != 1 || page.Page.Items[0].ID == firstID || page.Page.NextCursor != "" {
		t.Fatalf("aliases duplicated paginated child IDs: status=%d body=%s", res.StatusCode, body)
	}
}
