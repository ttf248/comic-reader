package services

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLocalAIWorkerRestartsAfterChildCrash(t *testing.T) {
	scriptPath := filepath.Join(t.TempDir(), "crash-once.py")
	script := `import json, os, sys
state = os.path.join(sys.argv[1], "first-process")
if not os.path.exists(state):
    open(state, "w").close()
    raise SystemExit(23)
for line in sys.stdin:
    request = json.loads(line)
    print(json.dumps({"id": request.get("id", ""), "status": {"pythonAvailable": True, "runtimeReady": True, "device": "cpu"}}), flush=True)
`
	worker := newTestLocalAIWorker(t, scriptPath, script)
	first, err := worker.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first.Device != "unavailable" {
		t.Fatalf("status after worker crash = %+v", first)
	}
	second, err := worker.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !second.PythonAvailable || !second.RuntimeReady || second.Device != "cpu" {
		t.Fatalf("status after worker restart = %+v", second)
	}
}

func TestLocalAIWorkerStopsTimedOutProcessAndRestarts(t *testing.T) {
	scriptPath := filepath.Join(t.TempDir(), "timeout-once.py")
	script := `import json, os, sys, time
state = os.path.join(sys.argv[1], "first-process")
if not os.path.exists(state):
    open(state, "w").close()
    sys.stdin.readline()
    time.sleep(10)
for line in sys.stdin:
    request = json.loads(line)
    print(json.dumps({"id": request.get("id", ""), "status": {"pythonAvailable": True, "runtimeReady": True, "device": "cpu"}}), flush=True)
`
	worker := newTestLocalAIWorker(t, scriptPath, script)
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	if _, err := worker.Status(ctx); err != context.DeadlineExceeded {
		t.Fatalf("status timeout error = %v", err)
	}
	status, err := worker.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !status.PythonAvailable || status.Device != "cpu" {
		t.Fatalf("status after timeout recovery = %+v", status)
	}
}

func newTestLocalAIWorker(t *testing.T, scriptPath, script string) *localAIWorker {
	t.Helper()
	modelDir := filepath.Join(t.TempDir(), "models")
	options, err := ResolveLocalAIWorkerOptions(modelDir)
	if err != nil || options.PythonPath == "" {
		t.Skip("Python 3.11 is not installed")
	}
	versionCommand := exec.Command(options.PythonPath, append(options.PythonArgs, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")...)
	version, err := versionCommand.Output()
	if err != nil || strings.TrimSpace(string(version)) != "3.11" {
		t.Skip("Python 3.11 is not available")
	}
	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	options.ScriptPath = scriptPath
	worker, err := NewLocalAIWorker(options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = worker.Close() })
	return worker
}
