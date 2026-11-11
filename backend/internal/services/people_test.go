package services

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func peopleTestRecord(resourceID string, faceVectors ...[]float32) AIAnalysisRecord {
	type face struct {
		Box       []float32 `json:"box"`
		Score     float32   `json:"score"`
		Embedding []float32 `json:"embedding"`
	}
	faces := make([]face, len(faceVectors))
	for index, vector := range faceVectors {
		faces[index] = face{Box: []float32{10, 12, 40, 42}, Score: .95, Embedding: vector}
	}
	data, _ := json.Marshal(struct {
		Faces []face `json:"faces"`
	}{Faces: faces})
	return AIAnalysisRecord{
		Type: AIJobTypeFace, ResourceID: resourceID, Size: 100, MTimeNs: 200,
		ModuleVersion: FaceAnalyzerVersion, Status: "faces_found", Data: data, UpdatedAt: time.Now(),
	}
}

func peopleTestVector(axis int, noise float32) []float32 {
	vector := make([]float32, peopleEmbeddingDimension)
	vector[axis] = 1
	if noise != 0 {
		vector[(axis+1)%peopleEmbeddingDimension] = noise
	}
	return vector
}

func TestPeopleServicePersistsCorrectionsWithoutCopyingEmbeddings(t *testing.T) {
	root := t.TempDir()
	statePath := filepath.Join(root, "state", "people.json")
	indexPath := filepath.Join(root, "derived", "people-index.json")
	records := []AIAnalysisRecord{
		peopleTestRecord("f_a", peopleTestVector(0, 0)),
		peopleTestRecord("f_b", peopleTestVector(0, .05)),
		peopleTestRecord("f_c", peopleTestVector(1, 0)),
	}
	people, err := OpenPeopleService(statePath, indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := people.Sync(records); err != nil {
		t.Fatal(err)
	}
	groups := people.Groups(false)
	if len(groups) != 2 {
		t.Fatalf("groups = %d, want two candidate groups: %+v", len(groups), groups)
	}
	var samePerson PersonGroup
	for _, group := range groups {
		if group.FaceCount == 2 {
			samePerson = group
		}
	}
	if samePerson.ID == "" {
		t.Fatalf("same-vector faces were not grouped: %+v", groups)
	}
	if err := people.Rename(samePerson.ID, "旅行同伴"); err != nil {
		t.Fatal(err)
	}
	faces := people.Faces(samePerson.ID)
	newPersonID, err := people.Split(samePerson.ID, []string{faces[1].Key})
	if err != nil {
		t.Fatal(err)
	}
	if err := people.SetHidden(newPersonID, true); err != nil {
		t.Fatal(err)
	}
	if got := len(people.Groups(false)); got != 2 {
		t.Fatalf("hidden groups visible by default = %d, want 2", got)
	}
	if got := len(people.Groups(true)); got != 3 {
		t.Fatalf("including hidden groups = %d, want 3", got)
	}
	derived, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(derived) == "" || containsPeopleEmbedding(derived) {
		t.Fatal("derived people index is empty or contains embeddings")
	}

	restarted, err := OpenPeopleService(statePath, indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.Sync(records); err != nil {
		t.Fatal(err)
	}
	var named, hidden bool
	for _, group := range restarted.Groups(true) {
		named = named || group.Name == "旅行同伴"
		hidden = hidden || group.ID == newPersonID && group.Hidden
	}
	if !named || !hidden {
		t.Fatalf("manual corrections did not survive rebuild: %+v", restarted.Groups(true))
	}
	if err := restarted.Merge(newPersonID, samePerson.ID); err != nil {
		t.Fatal(err)
	}
	if groups := restarted.Groups(true); len(groups) != 2 {
		t.Fatalf("merge did not combine groups: %+v", groups)
	}
}

func TestPeopleServiceIncrementalReplacesChangedResourceFaces(t *testing.T) {
	root := t.TempDir()
	people, err := OpenPeopleService(filepath.Join(root, "state.json"), filepath.Join(root, "derived.json"))
	if err != nil {
		t.Fatal(err)
	}
	first := peopleTestRecord("f_a", peopleTestVector(0, 0), peopleTestVector(1, 0))
	if err := people.Sync([]AIAnalysisRecord{first}); err != nil {
		t.Fatal(err)
	}
	if len(people.AllFaces()) != 2 {
		t.Fatal("expected two face rows from one image")
	}
	updated := peopleTestRecord("f_a", peopleTestVector(0, .1))
	updated.MTimeNs++
	if err := people.ApplyRecords([]AIAnalysisRecord{updated}); err != nil {
		t.Fatal(err)
	}
	faces := people.AllFaces()
	if len(faces) != 1 || faces[0].FaceIndex != 0 || faces[0].MTimeNs != updated.MTimeNs {
		t.Fatalf("incremental face replacement = %+v", faces)
	}
}

func containsPeopleEmbedding(data []byte) bool {
	var value map[string]any
	if json.Unmarshal(data, &value) != nil {
		return true
	}
	for _, face := range value["faces"].([]any) {
		if _, ok := face.(map[string]any)["embedding"]; ok {
			return true
		}
	}
	return false
}
