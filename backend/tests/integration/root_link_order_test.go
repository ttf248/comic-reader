package integration_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/config"
	"github.com/tianlongxiang/local-gallery/internal/handlers"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func TestExplicitLinkedRootMediaDoesNotDependOnConfigurationOrder(t *testing.T) {
	h := newHarness(t)
	target := t.TempDir()
	writePNG(t, filepath.Join(target, "page.png"), 12, 12)
	link := filepath.Join(h.root, "shortcut")
	createFsDirectoryLink(t, link, target)
	_, validator := middleware.PathSafetyMiddleware([]string{h.root, link})
	resourceApp := fiber.New(fiber.Config{DisableStartupMessage: true})
	resourceApp.Get("/api/images/:id/info", middleware.ResourceParam(h.catalog, validator), handlers.ImageInfoHandler(h.catalog))
	getImage := func(id string) (*http.Response, []byte) {
		t.Helper()
		response, err := resourceApp.Test(httptest.NewRequest(http.MethodGet, "/api/images/"+id+"/info", nil))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return response, body
	}
	var fileID string
	for _, roots := range [][]string{{h.root, link}, {link, h.root}} {
		entries := make([]config.MediaRoot, 0, len(roots))
		for _, root := range roots {
			entries = append(entries, config.MediaRoot{Path: root, Kind: config.DefaultMediaRootKind})
		}
		if _, err := h.mgr.Update(config.ConfigPatch{MediaRoots: entries, MediaRootsSet: true}); err != nil {
			t.Fatal(err)
		}
		validator.SetRoots(roots)
		res, body := h.do(t, http.MethodPost, "/api/scans", nil)
		var started struct {
			ScanID string `json:"scanId"`
		}
		if res.StatusCode != http.StatusOK || json.Unmarshal(body, &started) != nil || started.ScanID == "" {
			t.Fatalf("scan start status=%d body=%s", res.StatusCode, body)
		}
		res, body = h.do(t, http.MethodGet, "/api/scans/"+started.ScanID+"/events", nil)
		if res.StatusCode != http.StatusOK || !bytes.Contains(body, []byte("event: complete")) {
			t.Fatalf("linked root scan failed: status=%d body=%s", res.StatusCode, body)
		}
		result := h.catalog.Acquire().Result()
		if result.AlbumCount != 3 {
			t.Errorf("linked root album count=%d want 3", result.AlbumCount)
		}
		if len(result.Warnings) != 0 {
			t.Errorf("explicit linked root was reported skipped: %+v", result.Warnings)
		}
		id := h.catalog.ExternalID(filepath.Join(link, "page.png"), services.ResourceFile)
		if id == "" || (fileID != "" && id != fileID) {
			t.Fatalf("linked root ID changed with root order: %q -> %q", fileID, id)
		}
		fileID = id
		res, image := getImage(fileID)
		if res.StatusCode != http.StatusOK || len(image) == 0 {
			t.Errorf("configured linked-root image inaccessible with parent-first=%t: status=%d", roots[0] == h.root, res.StatusCode)
		}
	}
	// 显式链接根内部的其他链接仍不属于已授权边界。
	outside := t.TempDir()
	writePNG(t, filepath.Join(outside, "outside.png"), 12, 12)
	createFsDirectoryLink(t, filepath.Join(target, "nested-link"), outside)
	if _, err := validator.Validate(filepath.Join(link, "nested-link", "outside.png")); err == nil {
		t.Fatal("explicit root allowed an unconfigured nested link")
	}
	// 去掉链接根后，父根的白名单不能继续授予链接目标的访问权限。
	validator.SetRoots([]string{h.root})
	res, _ := getImage(fileID)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("removed linked root remained accessible: status=%d", res.StatusCode)
	}
}

func TestUnconfiguredDirectoryLinkIsSkippedDuringScan(t *testing.T) {
	h := newHarness(t)
	target := t.TempDir()
	writePNG(t, filepath.Join(target, "outside.png"), 12, 12)
	createFsDirectoryLink(t, filepath.Join(h.root, "shortcut.png"), target)
	result, err := services.NewScanner().Scan(services.ScanOptions{Roots: []string{h.root}})
	if err != nil {
		t.Fatal(err)
	}
	if result.AlbumCount != 2 || len(result.Warnings) != 1 || result.Warnings[0].Code != "symlink_skipped" {
		t.Fatalf("unconfigured link was scanned: albums=%d warnings=%+v", result.AlbumCount, result.Warnings)
	}
}
