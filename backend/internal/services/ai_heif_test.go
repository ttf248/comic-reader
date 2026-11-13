package services

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type fakeAIImageConverter struct {
	available bool
	output    []byte
	calls     int
	maxDim    int
}

func (f *fakeAIImageConverter) Available() bool { return f.available }

func (f *fakeAIImageConverter) ConvertJPEGBytesContext(_ context.Context, _ string, maxDim int) ([]byte, error) {
	f.calls++
	f.maxDim = maxDim
	return append([]byte(nil), f.output...), nil
}

type fakeFaceBatchAnalyzer struct {
	paths         []string
	analysisPaths []string
	convertedData []byte
}

func (*fakeFaceBatchAnalyzer) Type() string    { return AIJobTypeFace }
func (*fakeFaceBatchAnalyzer) Version() string { return FaceAnalyzerVersion }
func (*fakeFaceBatchAnalyzer) Analyze(context.Context, io.ReadSeeker) (AIAnalysisOutput, error) {
	return AIAnalysisOutput{}, nil
}

func (f *fakeFaceBatchAnalyzer) AnalyzeBatch(_ context.Context, inputs []AIAnalysisInput) ([]AIAnalysisOutput, error) {
	outputs := make([]AIAnalysisOutput, len(inputs))
	for index, input := range inputs {
		f.paths = append(f.paths, input.Path)
		f.analysisPaths = append(f.analysisPaths, input.AnalysisPath)
		if input.AnalysisPath != "" {
			data, err := os.ReadFile(input.AnalysisPath)
			if err != nil {
				return nil, err
			}
			f.convertedData = data
		}
		outputs[index] = AIAnalysisOutput{Status: "faces_found", Data: json.RawMessage(`{"faces":[]}`)}
	}
	return outputs, nil
}

func TestAIJobServiceConvertsHEIFForFaceAnalysisAndCleansTemporaryFiles(t *testing.T) {
	root := t.TempDir()
	heifPath := filepath.Join(root, "portrait.HEIC")
	jpegPath := filepath.Join(root, "portrait.jpg")
	for _, path := range []string{heifPath, jpegPath} {
		if err := os.WriteFile(path, []byte("source"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	heifInfo, err := os.Stat(heifPath)
	if err != nil {
		t.Fatal(err)
	}
	jpegInfo, err := os.Stat(jpegPath)
	if err != nil {
		t.Fatal(err)
	}
	converter := &fakeAIImageConverter{available: true, output: []byte("converted JPEG")}
	analyzer := &fakeFaceBatchAnalyzer{}
	service := &AIJobService{
		validatePath:       func(path string) (string, error) { return path, nil },
		faceImageConverter: converter,
		now:                time.Now,
	}
	results := service.processAnalyzerBatch(context.Background(), analyzer, analyzer, "cpu", []aiJobTarget{
		{resourceID: "f_heif", path: heifPath, position: 0, size: heifInfo.Size(), mtimeNs: heifInfo.ModTime().UnixNano()},
		{resourceID: "f_jpeg", path: jpegPath, position: 1, size: jpegInfo.Size(), mtimeNs: jpegInfo.ModTime().UnixNano()},
	})
	if len(results) != 2 || results[0].Status != "faces_found" || results[1].Status != "faces_found" {
		t.Fatalf("face results = %+v", results)
	}
	if converter.calls != 1 || converter.maxDim != faceAnalysisMaxDimension {
		t.Fatalf("HEIF conversion calls / max dimension = %d / %d", converter.calls, converter.maxDim)
	}
	if len(analyzer.paths) != 2 || analyzer.paths[0] != heifPath || analyzer.paths[1] != jpegPath {
		t.Fatalf("original paths passed to analyzer = %v", analyzer.paths)
	}
	if len(analyzer.analysisPaths) != 2 || analyzer.analysisPaths[0] == "" || analyzer.analysisPaths[1] != "" {
		t.Fatalf("analysis paths = %v; expected one temporary JPEG and one original JPEG", analyzer.analysisPaths)
	}
	if !bytes.Equal(analyzer.convertedData, converter.output) {
		t.Fatalf("converted image data = %q, want %q", analyzer.convertedData, converter.output)
	}
	if _, err := os.Stat(analyzer.analysisPaths[0]); !os.IsNotExist(err) {
		t.Fatalf("temporary converted image still exists after analysis: %v", err)
	}
}
