package handlers

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

type controlledScanEvents struct {
	events   chan services.ProgressEvent
	released chan struct{}
}

func (source *controlledScanEvents) Subscribe(string) (<-chan services.ProgressEvent, func(), bool) {
	return source.events, func() { close(source.released) }, true
}

func readScanEvents(t *testing.T, source *controlledScanEvents) []services.ProgressEvent {
	t.Helper()
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Get("/api/scans/:id/events", AsyncScanEventsHandler(source))
	response, err := app.Test(httptest.NewRequest("GET", "/api/scans/scan-1/events", nil), 2000)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || response.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("unexpected response: %d %v", response.StatusCode, response.Header)
	}
	var events []services.ProgressEvent
	for _, line := range strings.Split(string(body), "\n") {
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var event services.ProgressEvent
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	return events
}

func TestScanEventsPendingKeepsStreamUntilTerminal(t *testing.T) {
	source := &controlledScanEvents{events: make(chan services.ProgressEvent, 3), released: make(chan struct{})}
	for _, status := range []services.ScanStatus{services.ScanStatusPending, services.ScanStatusRunning, services.ScanStatusComplete} {
		source.events <- services.ProgressEvent{ScanID: "scan-1", Status: status}
	}
	close(source.events)
	events := readScanEvents(t, source)
	if len(events) != 3 || events[2].Status != services.ScanStatusComplete {
		t.Fatalf("pending ended subscription early: %+v", events)
	}
	select {
	case <-source.released:
	default:
		t.Fatal("stream did not release its subscription")
	}
}

func TestScanEventsReconnectPreservesTerminalSnapshot(t *testing.T) {
	for _, status := range []services.ScanStatus{services.ScanStatusComplete, services.ScanStatusCancelled, services.ScanStatusError} {
		t.Run(string(status), func(t *testing.T) {
			source := &controlledScanEvents{events: make(chan services.ProgressEvent, 1), released: make(chan struct{})}
			want := services.ProgressEvent{ScanID: "scan-1", Status: status, Progress: 37, Phase: "scanning", AlbumsFound: 12, ElapsedMs: 321, LibraryRevision: 7}
			if status == services.ScanStatusError {
				want.Error = services.ScanErrorCodeFailed
			}
			source.events <- want
			close(source.events)
			events := readScanEvents(t, source)
			if len(events) != 1 || events[0] != want {
				t.Fatalf("terminal snapshot changed: got %+v want %+v", events, want)
			}
			select {
			case <-source.released:
			default:
				t.Fatal("terminal subscription was not released")
			}
		})
	}
}

func TestScanEventsUnknownIDReturnsJSONError(t *testing.T) {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Get("/api/scans/:id/events", AsyncScanEventsHandler(services.NewAsyncScanRunner()))
	response, err := app.Test(httptest.NewRequest("GET", "/api/scans/missing/events", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 404 || !strings.Contains(string(body), `"code":"scan_not_found"`) {
		t.Fatalf("unknown scan: %d %s", response.StatusCode, body)
	}
}

type closedScanWriter struct{ writes chan []byte }

func (writer closedScanWriter) Write(data []byte) (int, error) {
	writer.writes <- bytes.Clone(data)
	return 0, io.ErrClosedPipe
}

func TestScanEventsWriteFailureStopsWithoutWaitingForNextEvent(t *testing.T) {
	events := make(chan services.ProgressEvent, 1)
	events <- services.ProgressEvent{ScanID: "scan-1", Status: services.ScanStatusRunning}
	defer close(events)
	writes := make(chan []byte, 1)
	done := make(chan struct{})
	go func() { streamScanEvents(bufio.NewWriter(closedScanWriter{writes}), events, time.Hour); close(done) }()
	select {
	case <-writes:
	case <-time.After(time.Second):
		t.Fatal("event was not flushed")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("disconnected stream still waits for scan progress")
	}
}

func TestScanEventsHeartbeatDetectsIdleDisconnect(t *testing.T) {
	events := make(chan services.ProgressEvent)
	defer close(events)
	writes := make(chan []byte, 1)
	done := make(chan struct{})
	go func() {
		streamScanEvents(bufio.NewWriter(closedScanWriter{writes}), events, time.Millisecond)
		close(done)
	}()
	select {
	case data := <-writes:
		if string(data) != ": keep-alive\n\n" {
			t.Fatalf("unexpected heartbeat: %q", data)
		}
	case <-time.After(time.Second):
		t.Fatal("idle connection received no heartbeat")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("idle disconnected stream was not released")
	}
}

func TestScanEventsClientDisconnectReleasesSubscription(t *testing.T) {
	source := &controlledScanEvents{events: make(chan services.ProgressEvent, 4), released: make(chan struct{})}
	source.events <- services.ProgressEvent{ScanID: "scan-1", Status: services.ScanStatusRunning}
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Get("/api/scans/:id/events", AsyncScanEventsHandler(source))
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = app.Listener(listener); close(done) }()
	t.Cleanup(func() {
		close(source.events)
		_ = app.ShutdownWithTimeout(time.Second)
		_ = listener.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("HTTP server did not stop")
		}
	})
	client := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	response, err := client.Get("http://" + listener.Addr().String() + "/api/scans/scan-1/events")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if line, err := bufio.NewReader(response.Body).ReadString('\n'); err != nil || line != "event: running\n" {
		t.Fatalf("first event=%q err=%v", line, err)
	}
	_ = response.Body.Close()
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	pulse := time.NewTicker(5 * time.Millisecond)
	defer pulse.Stop()
	for {
		select {
		case <-source.released:
			return
		case <-pulse.C:
			select {
			case source.events <- services.ProgressEvent{ScanID: "scan-1", Status: services.ScanStatusRunning}:
			case <-source.released:
				return
			default:
			}
		case <-deadline.C:
			t.Fatal("client closed but subscription still receives scan progress")
		}
	}
}
