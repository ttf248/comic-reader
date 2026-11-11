package services

import (
	"encoding/json"
	"path/filepath"
	"reflect"
	"testing"
)

func ocrRecord(resourceID, text string, size int64) AIAnalysisRecord {
	data, _ := json.Marshal(map[string]string{"text": text})
	return AIAnalysisRecord{
		Type: AIJobTypeOCR, ResourceID: resourceID, Size: size, MTimeNs: 10,
		ModuleVersion: OCRAnalyzerVersion, Status: "recognized", Data: data,
	}
}

func TestOCRSearchIndexFindsChineseEnglishAndNumbers(t *testing.T) {
	index, err := OpenOCRSearchIndex(filepath.Join(t.TempDir(), "ocr-index.json"))
	if err != nil {
		t.Fatal(err)
	}
	records := []AIAnalysisRecord{
		ocrRecord("f_first", "Hello World 海边散步 2024", 10),
		ocrRecord("f_second", "山间小路 2023", 12),
	}
	if err := index.Sync(records); err != nil {
		t.Fatal(err)
	}
	for query, expected := range map[string][]string{
		"HELLO": {"f_first"}, "海边": {"f_first"}, "2024": {"f_first"},
		"小路": {"f_second"}, "不存在": {},
	} {
		if actual := index.Candidates(query); !reflect.DeepEqual(actual, expected) {
			t.Errorf("Candidates(%q) = %v, want %v", query, actual, expected)
		}
	}
}

func TestOCRSearchIndexIncrementalUpdateAndReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ocr-index.json")
	index, err := OpenOCRSearchIndex(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := index.Sync([]AIAnalysisRecord{ocrRecord("f_one", "海边散步", 10)}); err != nil {
		t.Fatal(err)
	}
	if err := index.ApplyRecords([]AIAnalysisRecord{ocrRecord("f_one", "城市夜景", 11)}); err != nil {
		t.Fatal(err)
	}
	reloaded, err := OpenOCRSearchIndex(path)
	if err != nil {
		t.Fatal(err)
	}
	if actual := reloaded.Candidates("海边"); len(actual) != 0 {
		t.Fatalf("stale OCR terms remain: %v", actual)
	}
	if actual := reloaded.Candidates("夜景"); !reflect.DeepEqual(actual, []string{"f_one"}) {
		t.Fatalf("updated OCR terms = %v", actual)
	}
}

func TestOCRSearchIndexSkipsEmptyAndFailedRecords(t *testing.T) {
	index, err := OpenOCRSearchIndex(filepath.Join(t.TempDir(), "ocr-index.json"))
	if err != nil {
		t.Fatal(err)
	}
	noText := ocrRecord("f_empty", "", 1)
	failed := ocrRecord("f_failed", "不应被检索", 1)
	failed.Status = "failed"
	if err := index.Sync([]AIAnalysisRecord{noText, failed}); err != nil {
		t.Fatal(err)
	}
	if actual := index.Candidates("不应"); len(actual) != 0 {
		t.Fatalf("non-recognized OCR records were indexed: %v", actual)
	}
}
