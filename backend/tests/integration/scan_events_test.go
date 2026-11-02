package integration_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/services"
)

func TestScanEventReplayMatchesCommittedTerminalSnapshot(t *testing.T) {
	for _, failed := range []bool{false, true} {
		name := "complete"
		if failed {
			name = "error"
		}
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			var id string
			if failed {
				var err error
				id, _, err = h.runner.StartOrReuse(services.ScanOptions{Roots: []string{filepath.Join(h.root, "offline")}})
				if err != nil {
					t.Fatal(err)
				}
			} else {
				response, body := h.do(t, http.MethodPost, "/api/scans", nil)
				var start struct {
					ScanID string `json:"scanId"`
				}
				if response.StatusCode != http.StatusOK {
					t.Fatalf("start: %d", response.StatusCode)
				}
				if err := json.Unmarshal(body, &start); err != nil {
					t.Fatal(err)
				}
				id = start.ScanID
			}
			events, release, ok := h.runner.Subscribe(id)
			if !ok {
				t.Fatal("scan subscription unavailable")
			}
			defer release()
			var terminal services.ProgressEvent
			deadline := time.After(5 * time.Second)
			for terminal.Status == "" {
				select {
				case event, open := <-events:
					if !open {
						t.Fatal("subscription closed before terminal event")
					}
					if event.Status == services.ScanStatusComplete || event.Status == services.ScanStatusError {
						terminal = event
					}
				case <-deadline:
					t.Fatal("scan did not finish")
				}
			}
			h.runner.Wait(id)
			response, body := h.do(t, http.MethodGet, "/api/scans/"+id+"/events", nil)
			if response.StatusCode != http.StatusOK {
				t.Fatalf("replay: %d", response.StatusCode)
			}
			if bytes.Contains(body, []byte(h.root)) {
				t.Fatal("replay exposed the absolute source path")
			}
			var replay []services.ProgressEvent
			for _, line := range strings.Split(string(body), "\n") {
				if !strings.HasPrefix(line, "data: ") {
					continue
				}
				var event services.ProgressEvent
				if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
					t.Fatal(err)
				}
				replay = append(replay, event)
			}
			if len(replay) != 1 || replay[0] != terminal {
				t.Fatalf("replay=%+v original=%+v", replay, terminal)
			}
			if string(terminal.Status) != name {
				t.Fatalf("terminal status=%q want %q", terminal.Status, name)
			}
			if failed && terminal.Error != services.ScanErrorCodeRootMissing {
				t.Fatalf("unexpected public error: %q", terminal.Error)
			}
			if !failed && (terminal.AlbumsFound != 2 || terminal.LibraryRevision == 0) {
				t.Fatalf("incomplete final statistics: %+v", terminal)
			}
		})
	}
}

func TestMultiRootScanProgressMatchesPublishedLibrary(t *testing.T) {
	h := newHarness(t)
	second := t.TempDir()
	for _, name := range []string{"one", "two", "three"} {
		writePNG(t, filepath.Join(second, name, "page.png"), 1, 1)
	}
	response, body := h.do(t, http.MethodPut, "/api/config", map[string]any{"mediaRoots": []string{h.root, second}})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("configure roots: %d %s", response.StatusCode, body)
	}
	response, body = h.do(t, http.MethodPost, "/api/scans", nil)
	var start struct {
		ScanID string `json:"scanId"`
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("start: %d %s", response.StatusCode, body)
	}
	if err := json.Unmarshal(body, &start); err != nil {
		t.Fatal(err)
	}
	response, body = h.do(t, http.MethodGet, "/api/scans/"+start.ScanID+"/events", nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("events: %d", response.StatusCode)
	}
	for _, root := range []string{h.root, second} {
		if bytes.Contains(body, []byte(root)) {
			t.Fatal("events exposed an absolute root")
		}
	}
	var terminal services.ProgressEvent
	count, progress := 0, 0
	for _, line := range strings.Split(string(body), "\n") {
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var event services.ProgressEvent
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
			t.Fatal(err)
		}
		if event.AlbumsFound < count || event.Progress < progress {
			t.Fatalf("progress decreased: count %d -> %d, percent %d -> %d", count, event.AlbumsFound, progress, event.Progress)
		}
		if event.Status == services.ScanStatusRunning && event.Progress >= 100 {
			t.Fatal("running scan announced completion")
		}
		count, progress = event.AlbumsFound, event.Progress
		terminal = event
	}
	if terminal.Status != services.ScanStatusComplete || terminal.Progress != 100 || terminal.AlbumsFound != 5 {
		t.Fatalf("final progress: %+v", terminal)
	}
	response, body = h.do(t, http.MethodGet, "/api/library/manifest", nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("manifest: %d", response.StatusCode)
	}
	var published struct {
		Manifest services.LibraryManifest `json:"manifest"`
	}
	if err := json.Unmarshal(body, &published); err != nil {
		t.Fatal(err)
	}
	if published.Manifest.Statistics.RootCount != 2 || published.Manifest.Statistics.AlbumCount != terminal.AlbumsFound || published.Manifest.Revision != terminal.LibraryRevision {
		t.Fatalf("manifest differs from final event: %+v / %+v", published.Manifest, terminal)
	}
}
