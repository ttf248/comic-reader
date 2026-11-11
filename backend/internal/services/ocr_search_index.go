package services

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"slices"
	"sort"
	"strings"
	"sync"
	"unicode"
)

const ocrSearchIndexVersion = 1

type ocrSearchDocument struct {
	ResourceID    string   `json:"resourceId"`
	Size          int64    `json:"size"`
	MTimeNs       int64    `json:"mtimeNs"`
	ModuleVersion string   `json:"moduleVersion"`
	TextSHA256    string   `json:"textSha256"`
	Terms         []string `json:"terms"`
}

type ocrSearchIndexState struct {
	Version   int                          `json:"version"`
	Documents map[string]ocrSearchDocument `json:"documents"`
}

// OCRSearchIndex is a rebuildable local inverted index over OCR result batches.
// It stores only resource fingerprints and terms; OCR text remains in the
// existing analysis records and is checked again before results are returned.
type OCRSearchIndex struct {
	mu        sync.RWMutex
	path      string
	documents map[string]ocrSearchDocument
	postings  map[string]map[string]struct{}
}

func OpenOCRSearchIndex(path string) (*OCRSearchIndex, error) {
	if path == "" {
		return nil, os.ErrInvalid
	}
	index := &OCRSearchIndex{
		path:      path,
		documents: make(map[string]ocrSearchDocument),
		postings:  make(map[string]map[string]struct{}),
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return index, nil
		}
		return nil, err
	}
	var state ocrSearchIndexState
	if json.Unmarshal(data, &state) != nil || state.Version != ocrSearchIndexVersion {
		return index, nil
	}
	for resourceID, document := range state.Documents {
		if resourceID == "" || document.ResourceID != resourceID || document.Size < 0 || document.ModuleVersion == "" {
			continue
		}
		document.Terms = uniqueSortedStrings(document.Terms)
		index.documents[resourceID] = document
		index.addDocumentLocked(document)
	}
	return index, nil
}

// Sync replaces the indexed OCR documents with the current module records.
// It is used on startup to repair a stale or missing derived index.
func (s *OCRSearchIndex) Sync(records []AIAnalysisRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	seen := make(map[string]struct{}, len(records))
	for _, record := range records {
		if record.Type != AIJobTypeOCR {
			continue
		}
		seen[record.ResourceID] = struct{}{}
		document, indexed := makeOCRSearchDocument(record)
		if !indexed {
			changed = s.removeDocumentLocked(record.ResourceID) || changed
			continue
		}
		changed = s.upsertDocumentLocked(document) || changed
	}
	for resourceID := range s.documents {
		if _, exists := seen[resourceID]; !exists {
			changed = s.removeDocumentLocked(resourceID) || changed
		}
	}
	if !changed {
		return nil
	}
	return s.persistLocked()
}

// ApplyRecords incrementally updates records committed by the existing OCR job.
func (s *OCRSearchIndex) ApplyRecords(records []AIAnalysisRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	for _, record := range records {
		if record.Type != AIJobTypeOCR {
			continue
		}
		document, indexed := makeOCRSearchDocument(record)
		if !indexed {
			changed = s.removeDocumentLocked(record.ResourceID) || changed
			continue
		}
		changed = s.upsertDocumentLocked(document) || changed
	}
	if !changed {
		return nil
	}
	return s.persistLocked()
}

// Candidates returns the intersection of postings for all query n-grams.
// Callers must verify the full normalized phrase against the source OCR text.
func (s *OCRSearchIndex) Candidates(query string) []string {
	terms := ocrSearchTerms(query)
	if len(terms) == 0 {
		return []string{}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	var smallest map[string]struct{}
	for _, term := range terms {
		posting := s.postings[term]
		if len(posting) == 0 {
			return []string{}
		}
		if smallest == nil || len(posting) < len(smallest) {
			smallest = posting
		}
	}
	candidates := make([]string, 0, len(smallest))
	for resourceID := range smallest {
		matched := true
		for _, term := range terms {
			if _, exists := s.postings[term][resourceID]; !exists {
				matched = false
				break
			}
		}
		if matched {
			candidates = append(candidates, resourceID)
		}
	}
	sort.Strings(candidates)
	return candidates
}

func makeOCRSearchDocument(record AIAnalysisRecord) (ocrSearchDocument, bool) {
	if record.ResourceID == "" || record.Status != "recognized" || record.ModuleVersion == "" {
		return ocrSearchDocument{}, false
	}
	var result struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(record.Data, &result) != nil {
		return ocrSearchDocument{}, false
	}
	text := normalizeOCRSearchText(result.Text)
	terms := ocrSearchTerms(text)
	if text == "" || len(terms) == 0 {
		return ocrSearchDocument{}, false
	}
	digest := sha256.Sum256([]byte(text))
	return ocrSearchDocument{
		ResourceID: record.ResourceID, Size: record.Size, MTimeNs: record.MTimeNs,
		ModuleVersion: record.ModuleVersion, TextSHA256: hex.EncodeToString(digest[:]), Terms: terms,
	}, true
}

func (s *OCRSearchIndex) upsertDocumentLocked(document ocrSearchDocument) bool {
	previous, exists := s.documents[document.ResourceID]
	if exists && previous.Size == document.Size && previous.MTimeNs == document.MTimeNs &&
		previous.ModuleVersion == document.ModuleVersion && previous.TextSHA256 == document.TextSHA256 &&
		slices.Equal(previous.Terms, document.Terms) {
		return false
	}
	if exists {
		s.removeDocumentTermsLocked(previous)
	}
	document.Terms = append([]string(nil), document.Terms...)
	s.documents[document.ResourceID] = document
	s.addDocumentLocked(document)
	return true
}

func (s *OCRSearchIndex) removeDocumentLocked(resourceID string) bool {
	previous, exists := s.documents[resourceID]
	if !exists {
		return false
	}
	s.removeDocumentTermsLocked(previous)
	delete(s.documents, resourceID)
	return true
}

func (s *OCRSearchIndex) addDocumentLocked(document ocrSearchDocument) {
	for _, term := range document.Terms {
		posting := s.postings[term]
		if posting == nil {
			posting = make(map[string]struct{})
			s.postings[term] = posting
		}
		posting[document.ResourceID] = struct{}{}
	}
}

func (s *OCRSearchIndex) removeDocumentTermsLocked(document ocrSearchDocument) {
	for _, term := range document.Terms {
		posting := s.postings[term]
		delete(posting, document.ResourceID)
		if len(posting) == 0 {
			delete(s.postings, term)
		}
	}
}

func (s *OCRSearchIndex) persistLocked() error {
	state := ocrSearchIndexState{Version: ocrSearchIndexVersion, Documents: s.documents}
	return writeAIJSONAtomic(s.path, state)
}

func ocrSearchTerms(text string) []string {
	text = normalizeOCRSearchText(text)
	terms := make(map[string]struct{})
	word := make([]rune, 0, 32)
	flush := func() {
		for index, value := range word {
			terms["u:"+string(value)] = struct{}{}
			if index > 0 {
				terms["b:"+string(word[index-1:index+1])] = struct{}{}
			}
		}
		word = word[:0]
	}
	for _, value := range text {
		if unicode.IsLetter(value) || unicode.IsNumber(value) {
			word = append(word, value)
		} else {
			flush()
		}
	}
	flush()
	result := make([]string, 0, len(terms))
	for term := range terms {
		result = append(result, term)
	}
	sort.Strings(result)
	return result
}

func normalizeOCRSearchText(text string) string {
	text = strings.ToLower(text)
	return strings.Join(strings.Fields(text), " ")
}

func uniqueSortedStrings(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	sort.Strings(values)
	result := values[:1]
	for _, value := range values[1:] {
		if value != result[len(result)-1] {
			result = append(result, value)
		}
	}
	return result
}
