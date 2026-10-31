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
			if failed && terminal.Error != "scan failed" {
				t.Fatalf("unexpected public error: %q", terminal.Error)
			}
			if !failed && (terminal.AlbumsFound != 2 || terminal.LibraryRevision == 0) {
				t.Fatalf("incomplete final statistics: %+v", terminal)
			}
		})
	}
}
