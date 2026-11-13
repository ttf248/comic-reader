package services

import (
	"encoding/json"
	"os"
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

func TestOCRSearchQualityEvaluation(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "ocr_search_eval.json"))
	if err != nil {
		t.Fatal(err)
	}
	var evaluation struct {
		Queries []struct {
			ID        string `json:"id"`
			Query     string `json:"query"`
			Documents []struct {
				ID       string `json:"id"`
				Text     string `json:"text"`
				Relevant bool   `json:"relevant"`
			} `json:"documents"`
		} `json:"queries"`
	}
	if err := json.Unmarshal(data, &evaluation); err != nil {
		t.Fatal(err)
	}
	truePositive, falsePositive, falseNegative := 0, 0, 0
	exactMatches, approximateMatches := 0, 0
	misses := make([]string, 0)
	for _, query := range evaluation.Queries {
		index, err := OpenOCRSearchIndex(filepath.Join(t.TempDir(), query.ID+".json"))
		if err != nil {
			t.Fatal(err)
		}
		records := make([]AIAnalysisRecord, 0, len(query.Documents))
		documentByID := make(map[string]struct {
			text     string
			relevant bool
		}, len(query.Documents))
		for position, document := range query.Documents {
			records = append(records, ocrRecord(document.ID, document.Text, int64(position+1)))
			documentByID[document.ID] = struct {
				text     string
				relevant bool
			}{text: document.Text, relevant: document.Relevant}
		}
		if err := index.Sync(records); err != nil {
			t.Fatal(err)
		}
		candidates := make(map[string]struct{}, len(index.Candidates(query.Query)))
		for _, resourceID := range index.Candidates(query.Query) {
			candidates[resourceID] = struct{}{}
		}
		queryMatched := false
		for resourceID, document := range documentByID {
			_, indexed := candidates[resourceID]
			match := MatchOCRSearchText(query.Query, document.text)
			predicted := indexed && match != ""
			if predicted && document.relevant {
				truePositive++
				queryMatched = true
				if match == OCRSearchMatchExact {
					exactMatches++
				} else {
					approximateMatches++
				}
			} else if predicted {
				falsePositive++
			} else if document.relevant {
				falseNegative++
			}
		}
		if !queryMatched {
			misses = append(misses, query.ID)
		}
	}
	precision := float64(truePositive) / float64(max(1, truePositive+falsePositive))
	recall := float64(truePositive) / float64(max(1, truePositive+falseNegative))
	t.Logf("OCR evaluation: precision=%.3f recall=%.3f exact=%d approximate=%d falsePositive=%d falseNegative=%d missedQueries=%v", precision, recall, exactMatches, approximateMatches, falsePositive, falseNegative, misses)
	if precision != 1 || recall != 1 || falsePositive != 0 || falseNegative != 0 {
		t.Fatalf("OCR evaluation did not preserve precision and recover all labeled queries")
	}
}
