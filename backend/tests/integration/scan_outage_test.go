package integration_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tianlongxiang/local-gallery/internal/services"
)

func TestOfflineScanPreservesPublishedLibraryAndDiskCache(t *testing.T) {
	h := newHarness(t)
	cachePath := filepath.Join(h.cache, "scan.json")
	cache := services.NewScanResultCache(cachePath)
	h.runner.SetCache(cache)
	_, beforeManifest := h.scanLibrary(t)
	if err := cache.Flush(); err != nil {
		t.Fatal(err)
	}
	beforeCache, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatal(err)
	}
	beforeRevision := h.catalog.Acquire().Revision()
	offline := filepath.Join(filepath.Dir(h.root), filepath.Base(h.root)+"-offline")
	if !filepath.IsAbs(h.root) || !strings.HasPrefix(filepath.Base(h.root), "local-gallery-it-") || filepath.Dir(offline) != filepath.Dir(h.root) {
		t.Fatal("root is outside the integration fixture")
	}
	if err := os.Rename(h.root, offline); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Rename(offline, h.root); err != nil {
			t.Error(err)
		}
	})
	res, body := h.do(t, http.MethodPost, "/api/scans", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("start status=%d body=%s", res.StatusCode, body)
	}
	var started struct {
		ScanID string `json:"scanId"`
	}
	if err := json.Unmarshal(body, &started); err != nil || started.ScanID == "" {
		t.Fatalf("invalid start response: body=%s err=%v", body, err)
	}
	res, stream := h.do(t, http.MethodGet, "/api/scans/"+started.ScanID+"/events", nil)
	if res.StatusCode != http.StatusOK || !bytes.Contains(stream, []byte("event: error")) || bytes.Contains(stream, []byte("event: complete")) {
		t.Fatalf("offline root did not fail scan: status=%d stream=%s", res.StatusCode, stream)
	}
	escapedRoot, err := json.Marshal(h.root)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(stream, []byte(`"error":"root_missing"`)) || bytes.Contains(stream, escapedRoot[1:len(escapedRoot)-1]) || bytes.Contains(stream, []byte(filepath.ToSlash(h.root))) {
		t.Fatalf("scan failure was not sanitized: %s", stream)
	}
	res, afterManifest := h.do(t, http.MethodGet, "/api/library/manifest", nil)
	if res.StatusCode != http.StatusOK || !bytes.Equal(beforeManifest, afterManifest) || h.catalog.Acquire().Revision() != beforeRevision {
		t.Fatalf("offline scan replaced published manifest: status=%d body=%s", res.StatusCode, afterManifest)
	}
	if err := cache.Flush(); err != nil {
		t.Fatal(err)
	}
	afterCache, err := os.ReadFile(cachePath)
	if err != nil || !bytes.Equal(beforeCache, afterCache) {
		t.Fatalf("offline scan replaced disk cache: err=%v", err)
	}
}
