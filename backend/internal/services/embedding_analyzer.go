package services

import (
	"context"
	"encoding/json"
	"errors"
	"io"
)

type EmbeddingAnalyzer struct {
	worker AIEmbeddingWorker
	index  *VectorIndexStore
}

func NewEmbeddingAnalyzer(worker AIEmbeddingWorker, index *VectorIndexStore) (*EmbeddingAnalyzer, error) {
	if worker == nil || index == nil {
		return nil, errors.New("embedding analyzer requires a local worker and vector index")
	}
	return &EmbeddingAnalyzer{worker: worker, index: index}, nil
}

func (EmbeddingAnalyzer) Type() string    { return AIJobTypeEmbedding }
func (EmbeddingAnalyzer) Version() string { return ChineseCLIPModelVersion }
func (EmbeddingAnalyzer) MaxWorkers() int { return 1 }

// Analyze is unused by AIJobService because this analyzer implements AnalyzeBatch.
func (EmbeddingAnalyzer) Analyze(context.Context, io.ReadSeeker) (AIAnalysisOutput, error) {
	return AIAnalysisOutput{}, errors.New("embedding analyzer requires validated batch inputs")
}

func (a *EmbeddingAnalyzer) Ready(ctx context.Context) error {
	status, err := a.worker.Status(ctx)
	if err != nil || !status.PythonAvailable || !status.RuntimeReady {
		return ErrAIRuntimeUnavailable
	}
	if !status.ModelAvailable || !status.ModelValid {
		return ErrAIModelUnavailable
	}
	return nil
}

func (a *EmbeddingAnalyzer) ValidateHardware(ctx context.Context, device string) error {
	if device != "gpu" {
		return nil
	}
	status, err := a.worker.Status(ctx)
	if err != nil || !status.CUDAAvailable || !status.RuntimeReady {
		return ErrAIGPUUnavailable
	}
	return nil
}

func (a *EmbeddingAnalyzer) AnalyzeBatch(ctx context.Context, inputs []AIAnalysisInput) ([]AIAnalysisOutput, error) {
	if len(inputs) == 0 {
		return []AIAnalysisOutput{}, nil
	}
	paths := make([]string, len(inputs))
	for index, input := range inputs {
		paths[index] = input.Path
	}
	var embeddings []AIWorkerVector
	var err error
	device := inputs[0].ComputeDevice
	if device != "" {
		if computeWorker, ok := a.worker.(AIWorkerCompute); ok {
			embeddings, err = computeWorker.EmbedImagesOnDevice(ctx, paths, device)
		} else if device == "gpu" {
			return nil, ErrAIGPUUnavailable
		} else {
			embeddings, err = a.worker.EmbedImages(ctx, paths)
		}
	} else {
		embeddings, err = a.worker.EmbedImages(ctx, paths)
	}
	if err != nil {
		return nil, err
	}
	if len(embeddings) != len(inputs) {
		return nil, errors.New("local AI worker returned an incomplete batch")
	}
	outputs := make([]AIAnalysisOutput, len(inputs))
	vectorInputs := make([]VectorInput, 0, len(inputs))
	vectorPositions := make([]int, 0, len(inputs))
	for index, embedding := range embeddings {
		if embedding.Error != "" || len(embedding.Vector) != AIEmbeddingDimension {
			code := "image_embedding_failed"
			message := "图片无法读取或向量生成失败"
			if embedding.Error == "gpu_unavailable" {
				code = "gpu_unavailable"
				message = "GPU 推理环境不可用；已按 GPU 强制模式停止任务"
			} else if embedding.Error == "gpu_inference_failed" || embedding.Error == "gpu_out_of_memory" {
				code = "gpu_inference_failed"
				message = "GPU 推理失败；未切换到 CPU"
			}
			outputs[index] = AIAnalysisOutput{
				Status: "failed", ErrorCode: code, ErrorMessage: message,
			}
			continue
		}
		input := inputs[index]
		vectorInputs = append(vectorInputs, VectorInput{
			ResourceID: input.ResourceID, Size: input.Size, MTimeNs: input.MTimeNs, Vector: embedding.Vector,
		})
		vectorPositions = append(vectorPositions, index)
	}
	if err := a.index.Commit(ctx, vectorInputs); err != nil {
		return nil, err
	}
	data, _ := json.Marshal(map[string]int{"dimension": AIEmbeddingDimension})
	for _, index := range vectorPositions {
		outputs[index] = AIAnalysisOutput{Status: "indexed", Data: data, Fields: []string{AIFieldEmbedding}}
	}
	return outputs, nil
}

func (a *EmbeddingAnalyzer) RecordCurrent(record AIAnalysisRecord) bool {
	return record.Type == AIJobTypeEmbedding && record.Status == "indexed" && record.ModuleVersion == a.Version() && a.index.Current(record.ResourceID, record.Size, record.MTimeNs)
}

func (a *EmbeddingAnalyzer) Status(ctx context.Context) (AIWorkerStatus, error) {
	status, err := a.worker.Status(ctx)
	if err != nil {
		return AIWorkerStatus{}, err
	}
	status.Index = a.index.Status()
	return status, nil
}

func (a *EmbeddingAnalyzer) Index() *VectorIndexStore {
	return a.index
}

func (a *EmbeddingAnalyzer) SearchText(ctx context.Context, text string) ([]float32, error) {
	results, err := a.worker.EmbedTexts(ctx, []string{text})
	if err != nil {
		return nil, err
	}
	if len(results) != 1 || results[0].Error != "" || len(results[0].Vector) != AIEmbeddingDimension {
		return nil, errors.New("text embedding failed")
	}
	return results[0].Vector, nil
}

func (a *EmbeddingAnalyzer) SearchImage(ctx context.Context, path string) ([]float32, error) {
	results, err := a.worker.EmbedImages(ctx, []string{path})
	if err != nil {
		return nil, err
	}
	if len(results) != 1 || results[0].Error != "" || len(results[0].Vector) != AIEmbeddingDimension {
		return nil, errors.New("image embedding failed")
	}
	return results[0].Vector, nil
}

func (a *EmbeddingAnalyzer) Close() error {
	workerErr := a.worker.Close()
	a.index.Close()
	return workerErr
}
