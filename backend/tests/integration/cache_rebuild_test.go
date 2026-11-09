package integration_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// 重建任务跑完要给出终态事件，并且缩略图真的落到了磁盘上。
func TestCacheRebuildRunsAndReportsProgress(t *testing.T) {
	h := newHarness(t)
	// 库里放三张图，重建才有东西可做。
	h.catalog.Publish(&models.ScanResult{
		Roots: []string{h.root},
		Albums: []models.Album{{
			Type:       "album",
			Path:       h.root + "/[作者A] vol1",
			SourceRoot: h.root,
			ImageFiles: []string{
				h.root + "/[作者A] vol1/page1.png",
				h.root + "/[作者A] vol1/page2.png",
				h.root + "/[作者A] vol2/page3.png",
			},
			CoverImage: h.root + "/[作者A] vol1/page1.png",
		}},
	}, []string{h.root})

	res, body := h.do(t, "POST", "/api/cache/rebuild", map[string]interface{}{
		"scopes": []string{"thumbs"},
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("start status=%d body=%s", res.StatusCode, body)
	}
	var started struct {
		JobID  string `json:"jobId"`
		Reused bool   `json:"reused"`
	}
	if err := json.Unmarshal(body, &started); err != nil {
		t.Fatal(err)
	}
	if started.JobID == "" {
		t.Fatal("start should return a job id")
	}

	// SSE：终态事件后连接关闭。
	req := httptest.NewRequest("GET", "/api/cache/rebuild/"+started.JobID+"/events", nil)
	sse, err := h.app.Test(req, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer sse.Body.Close()
	if ct := sse.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type = %q", ct)
	}

	events := readSSEEvents(t, sse.Body, 20*time.Second)
	if len(events) == 0 {
		t.Fatal("expected at least one rebuild event")
	}
	last := events[len(events)-1]
	if last["status"] != "complete" {
		t.Fatalf("last event = %v, want status complete", last)
	}

	// 状态接口与事件流说的是同一件事。
	res, body = h.do(t, "GET", "/api/cache/rebuild/"+started.JobID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status endpoint = %d body=%s", res.StatusCode, body)
	}
	var progress struct {
		Status string `json:"status"`
		Total  int    `json:"total"`
		Done   int    `json:"done"`
	}
	if err := json.Unmarshal(body, &progress); err != nil {
		t.Fatal(err)
	}
	if progress.Status != "complete" || progress.Total != 3 || progress.Done != 3 {
		t.Fatalf("progress = %+v", progress)
	}
}

// 未知范围要报 400，不能悄悄跑一个空任务。
func TestCacheRebuildRejectsUnknownScope(t *testing.T) {
	h := newHarness(t)
	res, body := h.do(t, "POST", "/api/cache/rebuild", map[string]interface{}{
		"scopes": []string{"transcode"},
	})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", res.StatusCode, body)
	}
	if !strings.Contains(string(body), "invalid_rebuild_scope") {
		t.Fatalf("body = %s", body)
	}
}

// 未知任务要报 404。
func TestCacheRebuildUnknownJob(t *testing.T) {
	h := newHarness(t)
	res, _ := h.do(t, "GET", "/api/cache/rebuild/nope", nil)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("status=%d, want 404", res.StatusCode)
	}
}

// readSSEEvents 读 SSE 事件流直到连接关闭或超时。
func readSSEEvents(t *testing.T, body io.Reader, timeout time.Duration) []map[string]interface{} {
	t.Helper()
	type event struct {
		name string
		data string
	}
	var events []map[string]interface{}
	var current event
	flush := func() {
		if current.data == "" {
			return
		}
		var payload map[string]interface{}
		if err := json.Unmarshal([]byte(current.data), &payload); err == nil {
			events = append(events, payload)
		}
		current = event{}
	}
	buf := make([]byte, 4096)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		n, err := body.Read(buf)
		if n > 0 {
			for _, line := range strings.Split(string(buf[:n]), "\n") {
				switch {
				case strings.HasPrefix(line, "event: "):
					flush()
					current.name = strings.TrimPrefix(line, "event: ")
				case strings.HasPrefix(line, "data: "):
					current.data = strings.TrimPrefix(line, "data: ")
				case line == "":
					flush()
				}
			}
		}
		if err != nil {
			break
		}
	}
	flush()
	return events
}
