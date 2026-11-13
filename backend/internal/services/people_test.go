package services

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
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

func TestPeopleServiceSyncIsIndependentOfRecordOrder(t *testing.T) {
	records := []AIAnalysisRecord{
		peopleTestRecord("a_first", peopleTestAngle(0)),
		peopleTestRecord("b_middle", peopleTestAngle(60)),
		peopleTestRecord("c_last", peopleTestAngle(120)),
	}
	ordered, err := OpenPeopleService(filepath.Join(t.TempDir(), "ordered-state.json"), filepath.Join(t.TempDir(), "ordered-index.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := ordered.Sync(records); err != nil {
		t.Fatal(err)
	}
	shuffled, err := OpenPeopleService(filepath.Join(t.TempDir(), "shuffled-state.json"), filepath.Join(t.TempDir(), "shuffled-index.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := shuffled.Sync([]AIAnalysisRecord{records[2], records[0], records[1]}); err != nil {
		t.Fatal(err)
	}
	if got, want := peopleFaceGroups(shuffled.AllFaces()), peopleFaceGroups(ordered.AllFaces()); !reflect.DeepEqual(got, want) {
		t.Fatalf("record order changed person groups: got %v, want %v", got, want)
	}
}

func TestPeopleServiceEarlierIncrementalFacePreservesNameAcrossRebuild(t *testing.T) {
	root := t.TempDir()
	statePath := filepath.Join(root, "state", "people.json")
	indexPath := filepath.Join(root, "derived", "people-index.json")
	initial := peopleTestRecord("z_existing", peopleTestVector(0, 0))
	people, err := OpenPeopleService(statePath, indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := people.Sync([]AIAnalysisRecord{initial}); err != nil {
		t.Fatal(err)
	}
	oldID := people.AllFaces()[0].PersonID
	if err := people.Rename(oldID, "已命名的人物"); err != nil {
		t.Fatal(err)
	}
	if err := people.SetHidden(oldID, true); err != nil {
		t.Fatal(err)
	}
	inserted := peopleTestRecord("a_inserted", peopleTestVector(0, .02))
	if err := people.ApplyRecords([]AIAnalysisRecord{inserted}); err != nil {
		t.Fatal(err)
	}
	groups := people.Groups(true)
	if len(groups) != 1 || groups[0].Name != "已命名的人物" || !groups[0].Hidden {
		t.Fatalf("corrections were lost when an earlier face changed the cluster anchor: %+v", groups)
	}
	if groups[0].ID == oldID {
		t.Fatalf("test did not exercise an automatic ID change: old=%q new=%q", oldID, groups[0].ID)
	}

	restarted, err := OpenPeopleService(statePath, indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.Sync([]AIAnalysisRecord{initial, inserted}); err != nil {
		t.Fatal(err)
	}
	if got := restarted.Groups(true); !reflect.DeepEqual(got, groups) {
		t.Fatalf("restart changed person group or its corrections: got %+v, want %+v", got, groups)
	}
}

func TestPeopleServiceKeepsCorrectedGroupsSeparateWhenAutomaticClustersMerge(t *testing.T) {
	root := t.TempDir()
	statePath := filepath.Join(root, "state", "people.json")
	indexPath := filepath.Join(root, "derived", "people-index.json")
	first := peopleTestRecord("a_first", peopleTestVector(0, 0))
	second := peopleTestRecord("z_second", peopleTestVector(1, 0))
	people, err := OpenPeopleService(statePath, indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := people.Sync([]AIAnalysisRecord{first, second}); err != nil {
		t.Fatal(err)
	}
	ids := make(map[string]string)
	for _, face := range people.AllFaces() {
		ids[face.ResourceID] = face.PersonID
	}
	if ids[first.ResourceID] == ids[second.ResourceID] {
		t.Fatal("test setup did not create separate automatic groups")
	}
	if err := people.Rename(ids[first.ResourceID], "第一人"); err != nil {
		t.Fatal(err)
	}
	if err := people.Rename(ids[second.ResourceID], "第二人"); err != nil {
		t.Fatal(err)
	}
	if err := people.SetHidden(ids[second.ResourceID], true); err != nil {
		t.Fatal(err)
	}

	updatedSecond := peopleTestRecord(second.ResourceID, peopleTestVector(0, 0))
	updatedSecond.MTimeNs++
	if err := people.ApplyRecords([]AIAnalysisRecord{updatedSecond}); err != nil {
		t.Fatal(err)
	}
	groups := people.Groups(true)
	if len(groups) != 2 {
		t.Fatalf("automatic rebuild merged corrected groups: %+v", groups)
	}
	byName := make(map[string]PersonGroup, len(groups))
	for _, group := range groups {
		byName[group.Name] = group
	}
	if byName["第一人"].FaceCount != 1 || byName["第二人"].FaceCount != 1 || !byName["第二人"].Hidden {
		t.Fatalf("person corrections were lost after automatic merge: %+v", groups)
	}

	restarted, err := OpenPeopleService(statePath, indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.Sync([]AIAnalysisRecord{first, updatedSecond}); err != nil {
		t.Fatal(err)
	}
	if got := restarted.Groups(true); !reflect.DeepEqual(got, groups) {
		t.Fatalf("restart changed corrected groups: got %+v, want %+v", got, groups)
	}
}

func TestPeopleServiceKeepsCorrectedGroupTogetherWhenAutomaticClustersSplit(t *testing.T) {
	root := t.TempDir()
	statePath := filepath.Join(root, "state", "people.json")
	indexPath := filepath.Join(root, "derived", "people-index.json")
	first := peopleTestRecord("a_first", peopleTestVector(0, 0))
	second := peopleTestRecord("z_second", peopleTestVector(0, 0))
	people, err := OpenPeopleService(statePath, indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := people.Sync([]AIAnalysisRecord{first, second}); err != nil {
		t.Fatal(err)
	}
	group := people.Groups(true)[0]
	if err := people.Rename(group.ID, "确认的人物"); err != nil {
		t.Fatal(err)
	}
	if err := people.SetHidden(group.ID, true); err != nil {
		t.Fatal(err)
	}

	updatedSecond := peopleTestRecord(second.ResourceID, peopleTestVector(1, 0))
	updatedSecond.MTimeNs++
	if err := people.ApplyRecords([]AIAnalysisRecord{updatedSecond}); err != nil {
		t.Fatal(err)
	}
	groups := people.Groups(true)
	if len(groups) != 1 || groups[0].Name != "确认的人物" || groups[0].FaceCount != 2 || !groups[0].Hidden {
		t.Fatalf("automatic rebuild split a corrected group: %+v", groups)
	}

	restarted, err := OpenPeopleService(statePath, indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.Sync([]AIAnalysisRecord{first, updatedSecond}); err != nil {
		t.Fatal(err)
	}
	if got := restarted.Groups(true); !reflect.DeepEqual(got, groups) {
		t.Fatalf("restart changed corrected group: got %+v, want %+v", got, groups)
	}
}

func TestPeopleServiceRetainsFacesAboveFormerLimit(t *testing.T) {
	const faceCount = 30025
	records := make([]AIAnalysisRecord, 0, faceCount/100+1)
	for start := 0; start < faceCount; start += 100 {
		count := min(100, faceCount-start)
		vectors := make([][]float32, count)
		for index := range vectors {
			vectors[index] = peopleTestVector(0, 0)
		}
		records = append(records, peopleTestRecord(fmt.Sprintf("f_%05d", start), vectors...))
	}
	root := t.TempDir()
	people, err := OpenPeopleService(filepath.Join(root, "state.json"), filepath.Join(root, "index.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := people.Sync(records); err != nil {
		t.Fatal(err)
	}
	if got := len(people.AllFaces()); got != faceCount {
		t.Fatalf("indexed face count = %d, want %d", got, faceCount)
	}
	if people.GroupingLimited() {
		t.Fatal("single-cluster evaluation unexpectedly hit the comparison limit")
	}
}

func TestPeopleServiceTopGroupsRanksPhotoCountsAndLimitsResults(t *testing.T) {
	const groupCount = 55
	records := make([]AIAnalysisRecord, 0)
	for groupIndex := 0; groupIndex < groupCount; groupIndex++ {
		for photoIndex := 0; photoIndex <= groupIndex; photoIndex++ {
			vector := make([]float32, peopleEmbeddingDimension)
			vector[groupIndex] = 1
			records = append(records, peopleTestRecord(fmt.Sprintf("photo_%02d_%03d", groupIndex, photoIndex), vector))
		}
	}

	root := t.TempDir()
	people, err := OpenPeopleService(filepath.Join(root, "state.json"), filepath.Join(root, "index.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := people.Sync(records); err != nil {
		t.Fatal(err)
	}
	for _, group := range people.Groups(true) {
		if group.PhotoCount == groupCount {
			if err := people.SetHidden(group.ID, true); err != nil {
				t.Fatal(err)
			}
			break
		}
	}

	visible, totalVisible := people.TopGroups(50, false, nil)
	if len(visible) != 50 || totalVisible != groupCount-1 {
		t.Fatalf("visible top groups = %d, total = %d; want 50 of %d", len(visible), totalVisible, groupCount-1)
	}
	if visible[0].PhotoCount != groupCount-1 || visible[len(visible)-1].PhotoCount != 5 {
		t.Fatalf("visible photo-count range = %d..%d, want 54..5", visible[0].PhotoCount, visible[len(visible)-1].PhotoCount)
	}
	for index := 1; index < len(visible); index++ {
		if peopleGroupRanksBefore(visible[index], visible[index-1]) {
			t.Fatalf("groups are not ordered by descending photo count at %d: %+v before %+v", index, visible[index-1], visible[index])
		}
	}

	all, totalAll := people.TopGroups(0, true, nil)
	if len(all) != groupCount || totalAll != groupCount || all[0].PhotoCount != groupCount {
		t.Fatalf("all top groups = %d, total = %d, highest count = %d", len(all), totalAll, all[0].PhotoCount)
	}
}

func peopleTestAngle(degrees float64) []float32 {
	vector := make([]float32, peopleEmbeddingDimension)
	vector[0] = float32(math.Cos(degrees * math.Pi / 180))
	vector[1] = float32(math.Sin(degrees * math.Pi / 180))
	return vector
}

func peopleFaceGroups(faces []PersonFace) map[string]string {
	groups := make(map[string]string, len(faces))
	for _, face := range faces {
		groups[face.Key] = face.PersonID
	}
	return groups
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
