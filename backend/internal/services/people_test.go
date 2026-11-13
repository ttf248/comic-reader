package services

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
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

func peopleTestRandomVector(rng *rand.Rand) []float32 {
	vector := make([]float32, peopleEmbeddingDimension)
	var norm float64
	for index := range vector {
		vector[index] = float32(rng.NormFloat64())
		norm += float64(vector[index] * vector[index])
	}
	length := float32(math.Sqrt(norm))
	for index := range vector {
		vector[index] /= length
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

func TestPeopleServiceRequiresCentroidAndExemplarThresholds(t *testing.T) {
	root := t.TempDir()
	people, err := OpenPeopleService(filepath.Join(root, "state.json"), filepath.Join(root, "index.json"))
	if err != nil {
		t.Fatal(err)
	}

	belowAnchor := make([]float32, peopleEmbeddingDimension)
	belowAnchor[0] = 1
	belowNeighbor := make([]float32, peopleEmbeddingDimension)
	belowNeighbor[0] = 0.58
	belowNeighbor[1] = float32(math.Sqrt(1 - 0.58*0.58))
	aboveAnchor := make([]float32, peopleEmbeddingDimension)
	aboveAnchor[2] = 1
	aboveNeighbor := make([]float32, peopleEmbeddingDimension)
	aboveNeighbor[2] = 0.72
	aboveNeighbor[3] = float32(math.Sqrt(1 - 0.72*0.72))

	records := []AIAnalysisRecord{
		peopleTestRecord("a_below_anchor", belowAnchor),
		peopleTestRecord("b_below_neighbor", belowNeighbor),
		peopleTestRecord("c_above_anchor", aboveAnchor),
		peopleTestRecord("d_above_neighbor", aboveNeighbor),
	}
	if err := people.Sync(records); err != nil {
		t.Fatal(err)
	}
	ids := make(map[string]string)
	for _, face := range people.AllFaces() {
		ids[face.ResourceID] = face.PersonID
	}
	if ids["a_below_anchor"] == ids["b_below_neighbor"] {
		t.Fatal("0.58 similarity unexpectedly merged below the centroid threshold")
	}
	if ids["c_above_anchor"] != ids["d_above_neighbor"] {
		t.Fatal("0.72 similarity did not merge above the centroid and exemplar thresholds")
	}
}

func TestPeopleServiceRejectsCentroidDriftWithoutExemplarMatch(t *testing.T) {
	addFaceToCluster := func(exemplarSimilarity float32) string {
		centroid := make([]float32, peopleEmbeddingDimension)
		centroid[0] = 1
		exemplar := make([]float32, peopleEmbeddingDimension)
		exemplar[0] = exemplarSimilarity
		exemplar[1] = float32(math.Sqrt(float64(1 - exemplarSimilarity*exemplarSimilarity)))
		clusterID := "p_existing"
		cluster := &peopleCluster{
			sum:      make([]float64, peopleEmbeddingDimension),
			centroid: centroid,
			count:    1,
			members:  map[string]struct{}{"seed#0": {}},
			exemplars: []peopleClusterExemplar{{
				key: "seed#0", score: 0.9, embedding: exemplar,
			}},
		}
		cluster.sum[0] = 1
		people := &PeopleService{
			faces:    map[string]PersonFace{},
			clusters: map[string]*peopleCluster{clusterID: cluster},
			ann:      newPeopleANNIndex(),
		}
		people.ann.Add(clusterID, cluster.centroid)
		candidate := make([]float32, peopleEmbeddingDimension)
		candidate[0] = 1
		people.addFaceLocked(PersonFace{Key: "new#0", ResourceID: "new", Score: 0.9, embedding: candidate})
		return people.faces["new#0"].PersonID
	}

	if got := addFaceToCluster(0.669); got == "p_existing" {
		t.Fatal("face matching only the moving centroid joined without a strong exemplar match")
	}
	if got := addFaceToCluster(0.7136); got != "p_existing" {
		t.Fatalf("face with a strong exemplar match joined %q, want p_existing", got)
	}
}

func TestPeopleServiceRestoresCachedAssignmentsWithoutReclustering(t *testing.T) {
	root := t.TempDir()
	statePath := filepath.Join(root, "state.json")
	indexPath := filepath.Join(root, "index.json")
	records := []AIAnalysisRecord{
		peopleTestRecord("cache_a", peopleTestVector(0, 0)),
		peopleTestRecord("cache_b", peopleTestVector(0, .05)),
		peopleTestRecord("cache_c", peopleTestVector(1, 0)),
	}
	first, err := OpenPeopleService(statePath, indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Sync(records); err != nil {
		t.Fatal(err)
	}
	want := peopleFaceGroups(first.AllFaces())

	restarted, err := OpenPeopleService(statePath, indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(restarted.cachedIDs) != len(records) {
		t.Fatalf("cached face assignments = %d, want %d", len(restarted.cachedIDs), len(records))
	}
	if err := restarted.Sync(records); err != nil {
		t.Fatal(err)
	}
	if restarted.ann != nil {
		t.Fatal("cached assignments eagerly rebuilt the ANN index during startup")
	}
	if restarted.comparisons != 0 {
		t.Fatalf("unchanged face records triggered %d clustering comparisons", restarted.comparisons)
	}
	if got := peopleFaceGroups(restarted.AllFaces()); !reflect.DeepEqual(got, want) {
		t.Fatalf("cached assignments = %v, want %v", got, want)
	}
}

func TestPeopleServiceBuildsANNWhenIncrementalFaceArrivesAfterCachedRestore(t *testing.T) {
	root := t.TempDir()
	statePath := filepath.Join(root, "state.json")
	indexPath := filepath.Join(root, "index.json")
	records := []AIAnalysisRecord{
		peopleTestRecord("cache_a", peopleTestVector(0, 0)),
		peopleTestRecord("cache_b", peopleTestVector(1, 0)),
	}
	first, err := OpenPeopleService(statePath, indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Sync(records); err != nil {
		t.Fatal(err)
	}
	restarted, err := OpenPeopleService(statePath, indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.Sync(records); err != nil {
		t.Fatal(err)
	}
	if restarted.ann != nil {
		t.Fatal("cached restore unexpectedly created an ANN index")
	}

	newRecord := peopleTestRecord("zz_cache_new", peopleTestVector(1, 0.05))
	if err := restarted.ApplyRecords([]AIAnalysisRecord{newRecord}); err != nil {
		t.Fatal(err)
	}
	if restarted.ann == nil || restarted.ann.Len() != len(restarted.clusters) {
		t.Fatalf("incremental ANN length = %v; want %d cluster entries", restarted.ann, len(restarted.clusters))
	}
	groups := peopleFaceGroups(restarted.AllFaces())
	if groups["cache_b"] != groups["zz_cache_new"] {
		t.Fatalf("incremental face group = %q, want existing group %q", groups["zz_cache_new"], groups["cache_b"])
	}
}

func TestPeopleServiceReclustersWhenCachedFaceRecordChanges(t *testing.T) {
	root := t.TempDir()
	statePath := filepath.Join(root, "state.json")
	indexPath := filepath.Join(root, "index.json")
	records := []AIAnalysisRecord{
		peopleTestRecord("cache_a", peopleTestVector(0, 0)),
		peopleTestRecord("cache_b", peopleTestVector(0, .05)),
		peopleTestRecord("cache_c", peopleTestVector(1, 0)),
	}
	first, err := OpenPeopleService(statePath, indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Sync(records); err != nil {
		t.Fatal(err)
	}

	restarted, err := OpenPeopleService(statePath, indexPath)
	if err != nil {
		t.Fatal(err)
	}
	changed := peopleTestRecord("cache_b", peopleTestVector(2, 0))
	changed.MTimeNs++
	if err := restarted.Sync([]AIAnalysisRecord{records[0], changed, records[2]}); err != nil {
		t.Fatal(err)
	}
	if restarted.comparisons == 0 {
		t.Fatal("changed face record reused cached grouping without reclustering")
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
	if people.comparisons != faceCount-1 {
		t.Fatalf("single-cluster comparison count = %d, want %d", people.comparisons, faceCount-1)
	}
}

func TestPeopleServiceGroupsEveryFaceWithoutFullClusterScans(t *testing.T) {
	const faceCount = 2200
	rng := rand.New(rand.NewSource(42))
	records := make([]AIAnalysisRecord, 0, faceCount/100+1)
	for start := 0; start < faceCount; start += 100 {
		count := min(100, faceCount-start)
		vectors := make([][]float32, count)
		for index := range vectors {
			vectors[index] = peopleTestRandomVector(rng)
		}
		records = append(records, peopleTestRecord(fmt.Sprintf("random_%05d", start), vectors...))
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
	if people.comparisons >= 2_000_000 {
		t.Fatalf("exact cluster comparisons = %d, want a bounded candidate set", people.comparisons)
	}
	if people.ann.Len() != len(people.clusters) {
		t.Fatalf("candidate index contains %d clusters, want %d", people.ann.Len(), len(people.clusters))
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

func TestPeopleServiceSearchGroupsIsBoundedAndFindsIDsOutsideTopFifty(t *testing.T) {
	root := t.TempDir()
	records := []AIAnalysisRecord{
		peopleTestRecord("photo_first", peopleTestVector(0, 0)),
		peopleTestRecord("photo_second", peopleTestVector(1, 0)),
		peopleTestRecord("photo_third", peopleTestVector(2, 0)),
	}
	people, err := OpenPeopleService(filepath.Join(root, "state.json"), filepath.Join(root, "index.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := people.Sync(records); err != nil {
		t.Fatal(err)
	}
	all := people.Groups(true)
	if len(all) != 3 {
		t.Fatalf("people groups = %d, want 3", len(all))
	}
	target := all[0]
	if err := people.Rename(target.ID, "家人同伴"); err != nil {
		t.Fatal(err)
	}
	byName, total := people.SearchGroups("家人", 2, false, nil)
	if total != 1 || len(byName) != 1 || byName[0].ID != target.ID {
		t.Fatalf("name search = %+v, total %d", byName, total)
	}
	byID, total := people.SearchGroups(target.ID[len(target.ID)-6:], 2, false, nil)
	if total != 1 || len(byID) != 1 || byID[0].ID != target.ID {
		t.Fatalf("ID search = %+v, total %d", byID, total)
	}
	initial, total := people.SearchGroups("", 2, false, nil)
	if len(initial) != 2 || total != 3 {
		t.Fatalf("empty search = %d groups, total %d; want top 2 of 3", len(initial), total)
	}
	missing, total := people.SearchGroups("不存在", 20, false, nil)
	if missing == nil || len(missing) != 0 || total != 0 {
		t.Fatalf("missing search = %#v, total %d; want an empty non-nil result", missing, total)
	}
}

func TestPeopleServiceGroupAndFacesReturnsOneGroupWithoutEmbeddings(t *testing.T) {
	root := t.TempDir()
	people, err := OpenPeopleService(filepath.Join(root, "state.json"), filepath.Join(root, "index.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := people.Sync([]AIAnalysisRecord{
		peopleTestRecord("photo_a", peopleTestVector(0, 0)),
		peopleTestRecord("photo_b", peopleTestVector(0, .05)),
		peopleTestRecord("photo_other", peopleTestVector(1, 0)),
	}); err != nil {
		t.Fatal(err)
	}
	var groupID string
	for _, group := range people.Groups(true) {
		if group.FaceCount == 2 {
			groupID = group.ID
		}
	}
	group, faces, exists := people.GroupAndFaces(groupID)
	if !exists || group.FaceCount != 2 || group.PhotoCount != 2 || len(faces) != 2 {
		t.Fatalf("group summary = %+v, faces %d, exists %v", group, len(faces), exists)
	}
	for _, face := range faces {
		if face.embedding != nil || face.recordHash != "" {
			t.Fatal("group face response retained private embedding data")
		}
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
