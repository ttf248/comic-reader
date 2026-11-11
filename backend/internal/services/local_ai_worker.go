package services

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

const (
	ChineseCLIPModelVersion = "chinese-clip-vit-b-16@957be8390cef5bab9ddd2dd36ca81a8622f966e7"
	ChineseCLIPModelFile    = "clip_cn_vit-b-16.pt"
	ChineseCLIPSHA256       = "5997ef32c50de18f3ac06eb5d746c324a639053c3bed8f2986f97ebb22b2ecde"
)

var (
	ErrAIWorkerUnavailable  = errors.New("local AI worker is unavailable")
	ErrAIModelUnavailable   = errors.New("local semantic model is missing or invalid")
	ErrAIRuntimeUnavailable = errors.New("local AI runtime is unavailable")
)

type AIWorkerStatus struct {
	PythonAvailable bool              `json:"pythonAvailable"`
	PythonVersion   string            `json:"pythonVersion,omitempty"`
	TorchVersion    string            `json:"torchVersion,omitempty"`
	CUDAAvailable   bool              `json:"cudaAvailable"`
	CUDAVersion     string            `json:"cudaVersion,omitempty"`
	GPUName         string            `json:"gpuName,omitempty"`
	GPUMemoryBytes  int64             `json:"gpuMemoryBytes,omitempty"`
	Device          string            `json:"device"`
	RuntimeReady    bool              `json:"runtimeReady"`
	RuntimeError    string            `json:"runtimeError,omitempty"`
	ModelAvailable  bool              `json:"modelAvailable"`
	ModelValid      bool              `json:"modelValid"`
	ModelLoaded     bool              `json:"modelLoaded"`
	ModelVersion    string            `json:"modelVersion"`
	ModelSHA256     string            `json:"modelSha256,omitempty"`
	Index           VectorIndexStatus `json:"index"`
	Coverage        AIIndexCoverage   `json:"coverage"`
}

type AIIndexCoverage struct {
	Indexed int `json:"indexed"`
	Total   int `json:"total"`
}

type AIWorkerVector struct {
	Vector []float32
	Error  string
}

type AIEmbeddingWorker interface {
	Status(context.Context) (AIWorkerStatus, error)
	EmbedImages(context.Context, []string) ([]AIWorkerVector, error)
	EmbedTexts(context.Context, []string) ([]AIWorkerVector, error)
	Close() error
}

type LocalAIWorkerOptions struct {
	PythonPath string
	PythonArgs []string
	ScriptPath string
	ModelDir   string
}

type workerRequest struct {
	ID     string   `json:"id"`
	Action string   `json:"action"`
	Paths  []string `json:"paths,omitempty"`
	Texts  []string `json:"texts,omitempty"`
}

type workerItemResponse struct {
	Vector []float32 `json:"vector"`
	Error  string    `json:"error"`
}

type workerResponse struct {
	ID     string               `json:"id"`
	Error  string               `json:"error"`
	Items  []workerItemResponse `json:"items"`
	Status AIWorkerStatus       `json:"status"`
}

type workerProcess struct {
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	responses chan workerResponse
	errors    chan error
	done      chan struct{}
	killOnce  sync.Once
}

type localAIWorker struct {
	options LocalAIWorkerOptions
	request chan struct{}
	mu      sync.Mutex
	process *workerProcess
	closed  bool
}

func NewLocalAIWorker(options LocalAIWorkerOptions) (*localAIWorker, error) {
	if options.ScriptPath == "" || options.ModelDir == "" {
		return nil, errors.New("local AI worker requires a worker script and model directory")
	}
	if _, err := os.Stat(options.ScriptPath); err != nil {
		return nil, fmt.Errorf("worker script is unavailable: %w", err)
	}
	if err := os.MkdirAll(options.ModelDir, 0o755); err != nil {
		return nil, fmt.Errorf("create AI model directory: %w", err)
	}
	return &localAIWorker{options: options, request: make(chan struct{}, 1)}, nil
}

// ResolveLocalAIWorkerOptions 先找项目独立虚拟环境，再回退到 Python 3.11 启动器。
func ResolveLocalAIWorkerOptions(modelDir string) (LocalAIWorkerOptions, error) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		return LocalAIWorkerOptions{}, errors.New("cannot locate local AI worker")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "..", "..", ".."))
	candidates := []string{
		filepath.Join(repoRoot, "backend", "aiworker"),
		filepath.Join("backend", "aiworker"),
		filepath.Join("aiworker"),
	}
	for _, candidate := range candidates {
		script := filepath.Join(candidate, "worker.py")
		if _, err := os.Stat(script); err != nil {
			continue
		}
		for _, python := range []string{
			filepath.Join(candidate, ".venv", "Scripts", "python.exe"),
			filepath.Join(candidate, ".venv", "bin", "python"),
		} {
			if _, err := os.Stat(python); err == nil {
				return LocalAIWorkerOptions{PythonPath: python, ScriptPath: script, ModelDir: modelDir}, nil
			}
		}
		if launcher, err := exec.LookPath("py"); err == nil {
			return LocalAIWorkerOptions{PythonPath: launcher, PythonArgs: []string{"-3.11"}, ScriptPath: script, ModelDir: modelDir}, nil
		}
		if python, err := exec.LookPath("python3.11"); err == nil {
			return LocalAIWorkerOptions{PythonPath: python, ScriptPath: script, ModelDir: modelDir}, nil
		}
		if python, err := exec.LookPath("python"); err == nil {
			return LocalAIWorkerOptions{PythonPath: python, ScriptPath: script, ModelDir: modelDir}, nil
		}
		return LocalAIWorkerOptions{ScriptPath: script, ModelDir: modelDir}, nil
	}
	return LocalAIWorkerOptions{}, errors.New("local AI worker script is unavailable")
}

func (w *localAIWorker) Status(ctx context.Context) (AIWorkerStatus, error) {
	response, err := w.send(ctx, workerRequest{Action: "status"})
	if err != nil {
		if errors.Is(err, ErrAIWorkerUnavailable) {
			return AIWorkerStatus{ModelVersion: ChineseCLIPModelVersion, Device: "unavailable", RuntimeError: "python_runtime_unavailable"}, nil
		}
		return AIWorkerStatus{}, err
	}
	return response.Status, nil
}

func (w *localAIWorker) EmbedImages(ctx context.Context, paths []string) ([]AIWorkerVector, error) {
	response, err := w.send(ctx, workerRequest{Action: "embed_images", Paths: paths})
	if err != nil {
		return nil, err
	}
	return workerVectors(response)
}

func (w *localAIWorker) EmbedTexts(ctx context.Context, texts []string) ([]AIWorkerVector, error) {
	response, err := w.send(ctx, workerRequest{Action: "embed_texts", Texts: texts})
	if err != nil {
		return nil, err
	}
	return workerVectors(response)
}

func workerVectors(response workerResponse) ([]AIWorkerVector, error) {
	if response.Error != "" {
		code := safeWorkerError(response.Error)
		if code == "model_missing_or_checksum_invalid" {
			return nil, fmt.Errorf("%w: %s", ErrAIModelUnavailable, code)
		}
		if code == "python_dependencies_missing" {
			return nil, fmt.Errorf("%w: %s", ErrAIRuntimeUnavailable, code)
		}
		return nil, fmt.Errorf("%w: %s", ErrAIWorkerUnavailable, code)
	}
	result := make([]AIWorkerVector, len(response.Items))
	for index, item := range response.Items {
		result[index] = AIWorkerVector{Vector: item.Vector, Error: item.Error}
	}
	return result, nil
}

func safeWorkerError(code string) string {
	switch code {
	case "model_missing_or_checksum_invalid":
		return "model_missing_or_checksum_invalid"
	case "python_dependencies_missing":
		return "python_dependencies_missing"
	case "model_load_failed":
		return "model_load_failed"
	case "invalid_image_batch", "invalid_text_batch", "unknown_action":
		return code
	default:
		return "worker_request_failed"
	}
}

func (w *localAIWorker) send(ctx context.Context, request workerRequest) (workerResponse, error) {
	select {
	case w.request <- struct{}{}:
	case <-ctx.Done():
		return workerResponse{}, ctx.Err()
	}
	defer func() { <-w.request }()
	if err := ctx.Err(); err != nil {
		return workerResponse{}, err
	}
	process, err := w.ensureProcess()
	if err != nil {
		return workerResponse{}, fmt.Errorf("%w: %v", ErrAIWorkerUnavailable, err)
	}
	request.ID = newWorkerRequestID()
	data, err := json.Marshal(request)
	if err != nil {
		return workerResponse{}, err
	}
	data = append(data, '\n')
	if _, err := process.stdin.Write(data); err != nil {
		w.stopProcess(process)
		return workerResponse{}, fmt.Errorf("%w: worker input closed", ErrAIWorkerUnavailable)
	}
	select {
	case response := <-process.responses:
		if response.ID != request.ID {
			w.stopProcess(process)
			return workerResponse{}, fmt.Errorf("%w: mismatched worker response", ErrAIWorkerUnavailable)
		}
		return response, nil
	case err := <-process.errors:
		w.stopProcess(process)
		if err == nil {
			err = errors.New("worker stopped")
		}
		return workerResponse{}, fmt.Errorf("%w: %v", ErrAIWorkerUnavailable, err)
	case <-ctx.Done():
		w.stopProcess(process)
		return workerResponse{}, ctx.Err()
	}
}

func (w *localAIWorker) ensureProcess() (*workerProcess, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil, errors.New("local AI worker is closed")
	}
	if w.process != nil {
		return w.process, nil
	}
	if w.options.PythonPath == "" {
		return nil, errors.New("Python runtime is not installed")
	}
	arguments := append(append([]string(nil), w.options.PythonArgs...), "-u", w.options.ScriptPath, w.options.ModelDir)
	command := exec.Command(w.options.PythonPath, arguments...)
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	command.Stderr = log.Writer()
	if err := command.Start(); err != nil {
		_ = stdin.Close()
		return nil, err
	}
	process := &workerProcess{cmd: command, stdin: stdin, responses: make(chan workerResponse, 1), errors: make(chan error, 1), done: make(chan struct{})}
	w.process = process
	go process.read(stdout)
	go func() {
		err := command.Wait()
		if err != nil {
			select {
			case process.errors <- err:
			default:
			}
		}
		close(process.done)
	}()
	return process, nil
}

func (p *workerProcess) read(stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 16*1024), 8*1024*1024)
	for scanner.Scan() {
		var response workerResponse
		if err := json.Unmarshal(scanner.Bytes(), &response); err != nil {
			select {
			case p.errors <- errors.New("worker emitted invalid JSON"):
			default:
			}
			return
		}
		select {
		case p.responses <- response:
		case <-p.done:
			return
		}
	}
	if err := scanner.Err(); err != nil {
		select {
		case p.errors <- err:
		default:
		}
	}
}

func (w *localAIWorker) stopProcess(process *workerProcess) {
	w.mu.Lock()
	if w.process == process {
		w.process = nil
	}
	w.mu.Unlock()
	process.killOnce.Do(func() {
		_ = process.stdin.Close()
		if process.cmd.Process != nil {
			_ = process.cmd.Process.Kill()
		}
	})
	select {
	case <-process.done:
	case <-time.After(2 * time.Second):
	}
}

func (w *localAIWorker) Close() error {
	w.mu.Lock()
	w.closed = true
	process := w.process
	w.process = nil
	w.mu.Unlock()
	if process != nil {
		w.stopProcess(process)
	}
	return nil
}

func newWorkerRequestID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(value[:])
}

var _ AIEmbeddingWorker = (*localAIWorker)(nil)
