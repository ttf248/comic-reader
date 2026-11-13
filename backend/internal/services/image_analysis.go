package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	OCRAnalyzerVersion  = "rapidocr-3.10.0-onnxruntime-1.20.2"
	FaceAnalyzerVersion = "yunet-2023mar+sface-2021dec"
)

// OCRAnalyzer stores local text-recognition results in the existing AI metadata batches.
type OCRAnalyzer struct{ worker AIImageAnalysisWorker }

func NewOCRAnalyzer(worker AIImageAnalysisWorker) (*OCRAnalyzer, error) {
	if worker == nil {
		return nil, errors.New("OCR analyzer requires a local image worker")
	}
	return &OCRAnalyzer{worker: worker}, nil
}

func (OCRAnalyzer) Type() string    { return AIJobTypeOCR }
func (OCRAnalyzer) Version() string { return OCRAnalyzerVersion }
func (a *OCRAnalyzer) Available() (bool, string) {
	status := a.worker.ModuleStatus(AIJobTypeOCR)
	return status.Ready, status.Error
}
func (a *OCRAnalyzer) Ready(ctx context.Context) error {
	status, err := a.worker.Status(ctx)
	if err != nil {
		return err
	}
	if !status.Modules[AIJobTypeOCR].Ready {
		return fmt.Errorf("%w: %s", ErrAIAnalyzerUnavailable, status.Modules[AIJobTypeOCR].Error)
	}
	return nil
}
func (a *OCRAnalyzer) ValidateHardware(ctx context.Context, device string) error {
	return validateImageGPU(ctx, a.worker, device)
}
func (a *OCRAnalyzer) Analyze(context.Context, io.ReadSeeker) (AIAnalysisOutput, error) {
	return AIAnalysisOutput{}, errors.New("OCR analyzer requires validated batch inputs")
}
func (a *OCRAnalyzer) AnalyzeBatch(ctx context.Context, inputs []AIAnalysisInput) ([]AIAnalysisOutput, error) {
	return analyzeImageBatch(ctx, inputs, func(ctx context.Context, paths []string, device string) ([]AIWorkerAnalysis, error) {
		return runImageAnalysis(a.worker, "ocr", ctx, paths, device)
	}, AIFieldOCRText, func(data json.RawMessage) bool {
		var result struct {
			Text string `json:"text"`
		}
		return json.Unmarshal(data, &result) == nil && result.Text != ""
	})
}
func (a *OCRAnalyzer) RecordCurrent(record AIAnalysisRecord) bool {
	return record.Type == AIJobTypeOCR && (record.Status == "recognized" || record.Status == "no_text") && record.ModuleVersion == a.Version()
}

// FaceAnalyzer stores YuNet boxes and SFace embeddings for local face similarity search.
type FaceAnalyzer struct{ worker AIImageAnalysisWorker }

func NewFaceAnalyzer(worker AIImageAnalysisWorker) (*FaceAnalyzer, error) {
	if worker == nil {
		return nil, errors.New("face analyzer requires a local image worker")
	}
	return &FaceAnalyzer{worker: worker}, nil
}

func (FaceAnalyzer) Type() string    { return AIJobTypeFace }
func (FaceAnalyzer) Version() string { return FaceAnalyzerVersion }
func (a *FaceAnalyzer) Available() (bool, string) {
	status := a.worker.ModuleStatus(AIJobTypeFace)
	return status.Ready, status.Error
}
func (a *FaceAnalyzer) Ready(ctx context.Context) error {
	status, err := a.worker.Status(ctx)
	if err != nil {
		return err
	}
	if !status.Modules[AIJobTypeFace].Ready {
		return fmt.Errorf("%w: %s", ErrAIAnalyzerUnavailable, status.Modules[AIJobTypeFace].Error)
	}
	return nil
}
func (a *FaceAnalyzer) ValidateHardware(ctx context.Context, device string) error {
	return validateImageGPU(ctx, a.worker, device)
}
func (a *FaceAnalyzer) Analyze(context.Context, io.ReadSeeker) (AIAnalysisOutput, error) {
	return AIAnalysisOutput{}, errors.New("face analyzer requires validated batch inputs")
}
func (a *FaceAnalyzer) AnalyzeBatch(ctx context.Context, inputs []AIAnalysisInput) ([]AIAnalysisOutput, error) {
	return analyzeImageBatch(ctx, inputs, func(ctx context.Context, paths []string, device string) ([]AIWorkerAnalysis, error) {
		return runImageAnalysis(a.worker, "face", ctx, paths, device)
	}, AIFieldFaces, func(data json.RawMessage) bool {
		var result struct {
			Faces []json.RawMessage `json:"faces"`
		}
		return json.Unmarshal(data, &result) == nil && len(result.Faces) > 0
	})
}
func (a *FaceAnalyzer) RecordCurrent(record AIAnalysisRecord) bool {
	return record.Type == AIJobTypeFace && (record.Status == "faces_found" || record.Status == "no_faces") && record.ModuleVersion == a.Version()
}

type imageBatchAnalyzer func(context.Context, []string, string) ([]AIWorkerAnalysis, error)

func analyzeImageBatch(
	ctx context.Context,
	inputs []AIAnalysisInput,
	analyze imageBatchAnalyzer,
	field string,
	hasResult func(json.RawMessage) bool,
) ([]AIAnalysisOutput, error) {
	if len(inputs) == 0 {
		return []AIAnalysisOutput{}, nil
	}
	paths := make([]string, len(inputs))
	for index, input := range inputs {
		paths[index] = input.AnalysisPath
		if paths[index] == "" {
			paths[index] = input.Path
		}
	}
	device := inputs[0].ComputeDevice
	results, err := analyze(ctx, paths, device)
	if err != nil {
		return nil, err
	}
	if len(results) != len(inputs) {
		return nil, errors.New("local image worker returned an incomplete batch")
	}
	outputs := make([]AIAnalysisOutput, len(results))
	for index, result := range results {
		if result.Error != "" || !json.Valid(result.Data) {
			code := "image_analysis_failed"
			message := "图片无法读取或分析失败"
			if result.Error == "gpu_unavailable" {
				code = "gpu_unavailable"
				message = "GPU 推理环境不可用；已按 GPU 强制模式停止任务"
			} else if result.Error == "gpu_inference_failed" || result.Error == "gpu_out_of_memory" {
				code = "gpu_inference_failed"
				message = "GPU 推理失败；未切换到 CPU"
			}
			outputs[index] = AIAnalysisOutput{
				Status: "failed", ErrorCode: code, ErrorMessage: message,
			}
			continue
		}
		status := "no_text"
		if field == AIFieldFaces {
			status = "no_faces"
		}
		fields := []string(nil)
		if hasResult(result.Data) {
			status = "recognized"
			if field == AIFieldFaces {
				status = "faces_found"
			}
			fields = []string{field}
		}
		outputs[index] = AIAnalysisOutput{Status: status, Data: result.Data, Fields: fields}
	}
	return outputs, nil
}

func runImageAnalysis(worker AIImageAnalysisWorker, module string, ctx context.Context, paths []string, device string) ([]AIWorkerAnalysis, error) {
	if device == "" {
		switch module {
		case AIJobTypeOCR:
			return worker.AnalyzeOCR(ctx, paths)
		default:
			return worker.AnalyzeFaces(ctx, paths)
		}
	}
	computeWorker, ok := worker.(AIWorkerCompute)
	if !ok {
		if device == "gpu" {
			return nil, ErrAIGPUUnavailable
		}
		return runImageAnalysis(worker, module, ctx, paths, "")
	}
	if module == AIJobTypeOCR {
		return computeWorker.AnalyzeOCROnDevice(ctx, paths, device)
	}
	return computeWorker.AnalyzeFacesOnDevice(ctx, paths, device)
}

func validateImageGPU(ctx context.Context, worker AIImageAnalysisWorker, device string) error {
	if device != "gpu" {
		return nil
	}
	status, err := worker.Status(ctx)
	if err != nil || !status.CUDAAvailable || !status.CUDAExecutionProviderAvailable {
		return ErrAIGPUUnavailable
	}
	return nil
}

var _ AIAnalyzer = (*OCRAnalyzer)(nil)
var _ AIAnalyzerBatch = (*OCRAnalyzer)(nil)
var _ AIAnalyzerReadiness = (*OCRAnalyzer)(nil)
var _ AIAnalyzerAvailability = (*OCRAnalyzer)(nil)
var _ AIAnalyzerRecordValidator = (*OCRAnalyzer)(nil)
var _ AIAnalyzer = (*FaceAnalyzer)(nil)
var _ AIAnalyzerBatch = (*FaceAnalyzer)(nil)
var _ AIAnalyzerReadiness = (*FaceAnalyzer)(nil)
var _ AIAnalyzerAvailability = (*FaceAnalyzer)(nil)
var _ AIAnalyzerRecordValidator = (*FaceAnalyzer)(nil)
var _ AIAnalyzerHardware = (*OCRAnalyzer)(nil)
var _ AIAnalyzerHardware = (*FaceAnalyzer)(nil)
