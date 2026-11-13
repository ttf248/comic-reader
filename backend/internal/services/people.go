package services

import (
	"container/heap"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"sync"
	"unicode"
)

const (
	peopleIndexVersion          = 1
	peopleSimilarityThreshold   = 0.363
	peopleEmbeddingDimension    = 128
	peopleMaxClusterComparisons = 2000000
	peopleMaxSplitFaces         = 200
)

var (
	ErrPersonNotFound = errors.New("person not found")
	ErrInvalidPerson  = errors.New("invalid person change")
)

type PersonFace struct {
	Key        string    `json:"key"`
	ResourceID string    `json:"resourceId"`
	FaceIndex  int       `json:"faceIndex"`
	PersonID   string    `json:"personId"`
	Box        []float32 `json:"box"`
	Score      float32   `json:"score"`
	Size       int64     `json:"-"`
	MTimeNs    int64     `json:"-"`
	embedding  []float32
	recordHash string
}

type PersonGroup struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	FaceCount       int    `json:"faceCount"`
	PhotoCount      int    `json:"photoCount"`
	CoverResourceID string `json:"coverResourceId,omitempty"`
	Hidden          bool   `json:"hidden"`
}

// PeopleCorrections contains user-owned labels and assignments, never embeddings.
type PeopleCorrections struct {
	Version     int               `json:"version"`
	Names       map[string]string `json:"names"`
	Hidden      map[string]bool   `json:"hidden"`
	Assignments map[string]string `json:"assignments"`
}

type peopleFaceDisk struct {
	Key        string    `json:"key"`
	ResourceID string    `json:"resourceId"`
	FaceIndex  int       `json:"faceIndex"`
	ClusterID  string    `json:"clusterId"`
	Box        []float32 `json:"box"`
	Score      float32   `json:"score"`
	Size       int64     `json:"size"`
	MTimeNs    int64     `json:"mtimeNs"`
}

type peopleIndexDisk struct {
	Version int              `json:"version"`
	Faces   []peopleFaceDisk `json:"faces"`
}

type peopleManualState = PeopleCorrections

type peopleCluster struct {
	sum      []float64
	centroid []float32
	count    int
	members  map[string]struct{}
}

// PeopleService keeps a rebuildable face grouping index separate from the small
// user-owned names, visibility flags, and corrections stored under state/.
type PeopleService struct {
	mu              sync.RWMutex
	persistMu       sync.Mutex
	statePath       string
	derivedPath     string
	faces           map[string]PersonFace
	clusters        map[string]*peopleCluster
	previousIDs     map[string]string
	manual          peopleManualState
	comparisons     int
	groupingLimited bool
}

func OpenPeopleService(statePath, derivedPath string) (*PeopleService, error) {
	if statePath == "" || derivedPath == "" {
		return nil, os.ErrInvalid
	}
	service := &PeopleService{
		statePath: statePath, derivedPath: derivedPath,
		faces: make(map[string]PersonFace), clusters: make(map[string]*peopleCluster),
		previousIDs: make(map[string]string),
		manual:      emptyPeopleManualState(),
	}
	data, err := os.ReadFile(statePath)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if err == nil {
		var state peopleManualState
		if json.Unmarshal(data, &state) == nil && state.Version == peopleIndexVersion {
			service.manual = normalizePeopleManualState(state)
		}
	}
	data, err = os.ReadFile(derivedPath)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if err == nil {
		var index peopleIndexDisk
		if json.Unmarshal(data, &index) == nil && index.Version == peopleIndexVersion {
			referencedIDs := peopleReferencedIDs(service.manual)
			for _, face := range index.Faces {
				if face.Key != "" && referencedIDs[face.ClusterID] {
					service.previousIDs[face.Key] = face.ClusterID
				}
			}
		}
	}
	return service, nil
}

func emptyPeopleManualState() peopleManualState {
	return peopleManualState{Version: peopleIndexVersion, Names: map[string]string{}, Hidden: map[string]bool{}, Assignments: map[string]string{}}
}

func normalizePeopleManualState(state peopleManualState) peopleManualState {
	if state.Names == nil {
		state.Names = map[string]string{}
	}
	if state.Hidden == nil {
		state.Hidden = map[string]bool{}
	}
	if state.Assignments == nil {
		state.Assignments = map[string]string{}
	}
	state.Version = peopleIndexVersion
	return state
}

func peopleReferencedIDs(state peopleManualState) map[string]bool {
	result := make(map[string]bool, len(state.Names)+len(state.Hidden)+len(state.Assignments))
	for id := range state.Names {
		result[id] = true
	}
	for id := range state.Hidden {
		result[id] = true
	}
	for _, id := range state.Assignments {
		result[id] = true
	}
	return result
}

// Sync rebuilds clusters from the existing face-analysis records after startup.
func (s *PeopleService) Sync(records []AIAnalysisRecord) error {
	s.persistMu.Lock()
	defer s.persistMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	previousIDs := cloneStringMap(s.previousIDs)
	for key, face := range s.faces {
		previousIDs[key] = face.PersonID
	}
	faces := make(map[string]PersonFace)
	for _, record := range records {
		for _, face := range peopleFacesFromRecord(record) {
			faces[face.Key] = face
		}
	}
	s.rebuildLocked(faces, previousIDs)
	s.cleanAssignmentsLocked()
	return s.persistLocked()
}

// ApplyRecords updates affected resources without replacing the task system's records.
func (s *PeopleService) ApplyRecords(records []AIAnalysisRecord) error {
	s.persistMu.Lock()
	defer s.persistMu.Unlock()
	s.mu.Lock()
	changed := false
	previousIDs := make(map[string]string, len(s.faces))
	lastExisting := PersonFace{}
	for key, face := range s.faces {
		previousIDs[key] = face.PersonID
		if lastExisting.Key == "" || personFaceLess(lastExisting, face) {
			lastExisting = face
		}
	}
	orderedRecords := append([]AIAnalysisRecord(nil), records...)
	sort.Slice(orderedRecords, func(i, j int) bool { return orderedRecords[i].ResourceID < orderedRecords[j].ResourceID })
	appendedFaces := make([]PersonFace, 0)
	appendOnly := true
	for _, record := range orderedRecords {
		if record.Type != AIJobTypeFace {
			continue
		}
		incoming := peopleFacesFromRecord(record)
		current := s.facesForResourceLocked(record.ResourceID)
		if samePeopleFaces(current, incoming) {
			continue
		}
		for _, face := range current {
			delete(s.faces, face.Key)
			appendOnly = false
		}
		for _, face := range incoming {
			if lastExisting.Key != "" && !personFaceLess(lastExisting, face) {
				appendOnly = false
			}
			appendedFaces = append(appendedFaces, face)
		}
		changed = true
	}
	if !changed {
		s.mu.Unlock()
		return nil
	}
	if appendOnly {
		sort.Slice(appendedFaces, func(i, j int) bool { return personFaceLess(appendedFaces[i], appendedFaces[j]) })
		for _, face := range appendedFaces {
			s.addFaceLocked(face)
		}
	} else {
		for _, face := range appendedFaces {
			s.faces[face.Key] = face
		}
		s.rebuildLocked(s.faces, previousIDs)
	}
	s.cleanAssignmentsLocked()
	disk := s.indexSnapshotLocked()
	s.mu.Unlock()
	if err := s.persistIndexSnapshot(disk); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.updatePreviousIDsLocked()
	return s.persistManualLocked()
}

// rebuildLocked makes greedy centroid grouping independent of batch arrival
// order and remaps corrections through the largest face overlap.
func (s *PeopleService) rebuildLocked(faces map[string]PersonFace, previousIDs map[string]string) {
	keys := make([]string, 0, len(faces))
	for key := range faces {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return personFaceLess(faces[keys[i]], faces[keys[j]]) })
	s.faces = make(map[string]PersonFace, len(faces))
	s.clusters = make(map[string]*peopleCluster)
	s.comparisons = 0
	s.groupingLimited = false
	for _, key := range keys {
		s.addFaceLocked(faces[key])
	}
	s.remapCorrectionsLocked(previousIDs)
}

func personFaceLess(left, right PersonFace) bool {
	if left.ResourceID != right.ResourceID {
		return left.ResourceID < right.ResourceID
	}
	return left.FaceIndex < right.FaceIndex
}

func (s *PeopleService) remapCorrectionsLocked(previousIDs map[string]string) {
	newIDByKey := make(map[string]string, len(s.faces))
	for key, face := range s.faces {
		newIDByKey[key] = face.PersonID
	}
	type overlap struct {
		oldID string
		newID string
		count int
	}
	overlapsByOldID := make(map[string]map[string]int)
	for key, oldID := range previousIDs {
		newID := newIDByKey[key]
		if oldID == "" || newID == "" {
			continue
		}
		if overlapsByOldID[oldID] == nil {
			overlapsByOldID[oldID] = make(map[string]int)
		}
		overlapsByOldID[oldID][newID]++
	}
	var overlaps []overlap
	for oldID, destinations := range overlapsByOldID {
		for newID, count := range destinations {
			overlaps = append(overlaps, overlap{oldID: oldID, newID: newID, count: count})
		}
	}
	sort.Slice(overlaps, func(i, j int) bool {
		if overlaps[i].count != overlaps[j].count {
			return overlaps[i].count > overlaps[j].count
		}
		if (overlaps[i].oldID == overlaps[i].newID) != (overlaps[j].oldID == overlaps[j].newID) {
			return overlaps[i].oldID == overlaps[i].newID
		}
		if overlaps[i].oldID != overlaps[j].oldID {
			return overlaps[i].oldID < overlaps[j].oldID
		}
		return overlaps[i].newID < overlaps[j].newID
	})
	oldToNew := make(map[string]string, len(overlapsByOldID))
	overlapCount := make(map[string]int, len(overlapsByOldID))
	for _, candidate := range overlaps {
		if _, decided := oldToNew[candidate.oldID]; !decided {
			oldToNew[candidate.oldID] = candidate.newID
			overlapCount[candidate.oldID] = candidate.count
		}
	}
	// If automatic clustering now combines multiple previously corrected
	// people, keep each corrected group distinct until the user merges it.
	// Otherwise two labels would collapse to one ID and one would be lost.
	destinationByOldID := make(map[string]string, len(previousIDs))
	for oldID, newID := range oldToNew {
		destinationByOldID[oldID] = newID
	}
	for key, oldID := range previousIDs {
		if destinationByOldID[oldID] == "" && newIDByKey[key] == oldID {
			destinationByOldID[oldID] = oldID
		}
	}
	oldIDsByDestination := make(map[string][]string)
	for oldID, newID := range destinationByOldID {
		oldIDsByDestination[newID] = append(oldIDsByDestination[newID], oldID)
	}
	referencedIDs := peopleReferencedIDs(s.manual)
	pinnedOldIDs := make(map[string]bool)
	for oldID, destinations := range overlapsByOldID {
		if referencedIDs[oldID] && len(destinations) > 1 {
			// Keep the complete previously corrected group together when new
			// embeddings would otherwise split it across automatic clusters.
			pinnedOldIDs[oldID] = true
		}
	}
	correctedByDestination := make(map[string][]string)
	for newID, oldIDs := range oldIDsByDestination {
		if len(oldIDs) < 2 {
			continue
		}
		for _, oldID := range oldIDs {
			if referencedIDs[oldID] && !pinnedOldIDs[oldID] {
				correctedByDestination[newID] = append(correctedByDestination[newID], oldID)
			}
		}
	}
	for newID, oldIDs := range correctedByDestination {
		destinationWasAnOldID := destinationByOldID[newID] == newID
		if destinationWasAnOldID && !referencedIDs[newID] {
			for _, oldID := range oldIDs {
				pinnedOldIDs[oldID] = true
			}
			continue
		}
		sort.Slice(oldIDs, func(i, j int) bool {
			// Keep an existing cluster whose stable ID is still the destination.
			// Otherwise prefer the corrected group with the most surviving faces.
			if (oldIDs[i] == newID) != (oldIDs[j] == newID) {
				return oldIDs[i] == newID
			}
			if overlapCount[oldIDs[i]] != overlapCount[oldIDs[j]] {
				return overlapCount[oldIDs[i]] > overlapCount[oldIDs[j]]
			}
			return oldIDs[i] < oldIDs[j]
		})
		keeper := oldIDs[0]
		for _, oldID := range oldIDs {
			if oldID != keeper {
				pinnedOldIDs[oldID] = true
			}
		}
	}
	if len(oldToNew) == 0 && len(pinnedOldIDs) == 0 {
		return
	}
	for key, oldID := range previousIDs {
		if pinnedOldIDs[oldID] && s.manual.Assignments[key] == "" {
			s.manual.Assignments[key] = oldID
		}
	}

	names := make(map[string]string, len(s.manual.Names))
	hidden := make(map[string]bool, len(s.manual.Hidden))
	for id, name := range s.manual.Names {
		if _, remapped := oldToNew[id]; !remapped || pinnedOldIDs[id] {
			names[id] = name
		}
	}
	for id, value := range s.manual.Hidden {
		if _, remapped := oldToNew[id]; !remapped || pinnedOldIDs[id] {
			hidden[id] = value
		}
	}
	for _, candidate := range overlaps {
		if oldToNew[candidate.oldID] != candidate.newID || pinnedOldIDs[candidate.oldID] {
			continue
		}
		if name := s.manual.Names[candidate.oldID]; name != "" && names[candidate.newID] == "" {
			names[candidate.newID] = name
		}
		if s.manual.Hidden[candidate.oldID] {
			hidden[candidate.newID] = true
		}
	}
	for key, id := range s.manual.Assignments {
		if newID := oldToNew[id]; newID != "" && !pinnedOldIDs[id] {
			s.manual.Assignments[key] = newID
		}
	}
	s.manual.Names = names
	s.manual.Hidden = hidden
}

func (s *PeopleService) addFaceLocked(face PersonFace) {
	bestID := ""
	bestScore := peopleSimilarityThreshold
	clusterIDs := make([]string, 0, len(s.clusters))
	for id := range s.clusters {
		clusterIDs = append(clusterIDs, id)
	}
	sort.Strings(clusterIDs)
	for _, id := range clusterIDs {
		if s.comparisons >= peopleMaxClusterComparisons {
			s.groupingLimited = true
			break
		}
		s.comparisons++
		cluster := s.clusters[id]
		score := peopleCosine(face.embedding, cluster.centroid)
		if score > bestScore {
			bestID, bestScore = id, score
		}
	}
	if bestID == "" {
		bestID = stablePersonID(face.Key)
		s.clusters[bestID] = &peopleCluster{
			sum:      make([]float64, peopleEmbeddingDimension),
			centroid: make([]float32, peopleEmbeddingDimension),
			members:  map[string]struct{}{},
		}
	}
	cluster := s.clusters[bestID]
	for index, value := range face.embedding {
		cluster.sum[index] += float64(value)
	}
	cluster.count++
	cluster.members[face.Key] = struct{}{}
	updatePeopleCentroid(cluster)
	face.PersonID = bestID
	s.faces[face.Key] = face
}

func updatePeopleCentroid(cluster *peopleCluster) {
	var norm float64
	for _, value := range cluster.sum {
		rounded := float32(value)
		norm += float64(rounded) * float64(rounded)
	}
	if norm == 0 {
		clear(cluster.centroid)
		return
	}
	length := float32(math.Sqrt(norm))
	for index, value := range cluster.sum {
		cluster.centroid[index] = float32(value) / length
	}
}

func (s *PeopleService) removeFaceLocked(key string) {
	face, exists := s.faces[key]
	if !exists {
		return
	}
	delete(s.faces, key)
	cluster := s.clusters[face.PersonID]
	if cluster == nil {
		return
	}
	delete(cluster.members, key)
	if len(cluster.members) == 0 {
		delete(s.clusters, face.PersonID)
		return
	}
	cluster.sum = make([]float64, peopleEmbeddingDimension)
	cluster.count = 0
	for memberKey := range cluster.members {
		member := s.faces[memberKey]
		for index, value := range member.embedding {
			cluster.sum[index] += float64(value)
		}
		cluster.count++
	}
	updatePeopleCentroid(cluster)
}

func (s *PeopleService) facesForResourceLocked(resourceID string) []PersonFace {
	result := make([]PersonFace, 0)
	for _, face := range s.faces {
		if face.ResourceID == resourceID {
			result = append(result, face)
		}
	}
	return result
}

func peopleFacesFromRecord(record AIAnalysisRecord) []PersonFace {
	if record.Type != AIJobTypeFace || record.ModuleVersion != FaceAnalyzerVersion || record.Status != "faces_found" {
		return nil
	}
	var result struct {
		Faces []struct {
			Box       []float32 `json:"box"`
			Score     float32   `json:"score"`
			Embedding []float32 `json:"embedding"`
		} `json:"faces"`
	}
	if json.Unmarshal(record.Data, &result) != nil || len(result.Faces) > 100 {
		return nil
	}
	hash := sha256.Sum256(record.Data)
	faces := make([]PersonFace, 0, len(result.Faces))
	for index, face := range result.Faces {
		if len(face.Embedding) != peopleEmbeddingDimension || len(face.Box) != 4 || math.IsNaN(float64(face.Score)) || math.IsInf(float64(face.Score), 0) {
			continue
		}
		vector := normalizedVector(face.Embedding)
		if vector == nil {
			continue
		}
		key := PersonFaceKey(record.ResourceID, index)
		faces = append(faces, PersonFace{
			Key: key, ResourceID: record.ResourceID, FaceIndex: index, Box: append([]float32(nil), face.Box...),
			Score: face.Score, Size: record.Size, MTimeNs: record.MTimeNs, embedding: vector,
			recordHash: hex.EncodeToString(hash[:]),
		})
	}
	return faces
}

func PersonFaceKey(resourceID string, faceIndex int) string {
	return fmt.Sprintf("%s#%d", resourceID, faceIndex)
}

func samePeopleFaces(left, right []PersonFace) bool {
	if len(left) != len(right) {
		return false
	}
	byKey := make(map[string]PersonFace, len(left))
	for _, face := range left {
		byKey[face.Key] = face
	}
	for _, face := range right {
		previous, exists := byKey[face.Key]
		if !exists || previous.Size != face.Size || previous.MTimeNs != face.MTimeNs || previous.recordHash != face.recordHash {
			return false
		}
	}
	return true
}

func normalizedVector(values []float32) []float32 {
	if len(values) != peopleEmbeddingDimension {
		return nil
	}
	var norm float64
	for _, value := range values {
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			return nil
		}
		norm += float64(value) * float64(value)
	}
	if norm == 0 {
		return nil
	}
	length := float32(math.Sqrt(norm))
	result := make([]float32, len(values))
	for index, value := range values {
		result[index] = value / length
	}
	return result
}

func normalizedCentroid(sum []float64) []float32 {
	vector := make([]float32, len(sum))
	for index, value := range sum {
		vector[index] = float32(value)
	}
	return normalizedVector(vector)
}

func peopleCosine(left, right []float32) float64 {
	if len(left) != peopleEmbeddingDimension || len(right) != peopleEmbeddingDimension {
		return -1
	}
	var score float64
	for index, value := range left {
		score += float64(value) * float64(right[index])
	}
	return score
}

func stablePersonID(faceKey string) string {
	hash := sha256.Sum256([]byte(faceKey))
	return "p_" + hex.EncodeToString(hash[:8])
}

func (s *PeopleService) effectivePersonIDLocked(face PersonFace) string {
	if assigned := s.manual.Assignments[face.Key]; assigned != "" {
		return assigned
	}
	return face.PersonID
}

func (s *PeopleService) Groups(includeHidden bool) []PersonGroup {
	s.mu.RLock()
	defer s.mu.RUnlock()
	groups := make(map[string]*PersonGroup)
	photos := make(map[string]map[string]struct{})
	for _, face := range s.faces {
		id := s.effectivePersonIDLocked(face)
		group := groups[id]
		if group == nil {
			name := s.manual.Names[id]
			if name == "" {
				name = "人物 " + strings.TrimPrefix(id, "p_")[:min(6, len(strings.TrimPrefix(id, "p_")))]
			}
			group = &PersonGroup{ID: id, Name: name, Hidden: s.manual.Hidden[id]}
			groups[id] = group
			photos[id] = map[string]struct{}{}
		}
		group.FaceCount++
		photos[id][face.ResourceID] = struct{}{}
		if group.CoverResourceID == "" || face.ResourceID < group.CoverResourceID {
			group.CoverResourceID = face.ResourceID
		}
	}
	result := make([]PersonGroup, 0, len(groups))
	for id, group := range groups {
		group.PhotoCount = len(photos[id])
		if includeHidden || !group.Hidden {
			result = append(result, *group)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Name == result[j].Name {
			return result[i].ID < result[j].ID
		}
		return strings.ToLower(result[i].Name) < strings.ToLower(result[j].Name)
	})
	return result
}

// TopGroups aggregates current face records and returns the most photographed
// people. A nil resource filter includes every indexed resource; limit <= 0
// returns all matching groups.
func (s *PeopleService) TopGroups(limit int, includeHidden bool, includeResource func(string) bool) ([]PersonGroup, int) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	groups := make(map[string]*PersonGroup)
	photos := make(map[string]map[string]struct{})
	for _, face := range s.faces {
		if includeResource != nil && !includeResource(face.ResourceID) {
			continue
		}
		id := s.effectivePersonIDLocked(face)
		if !includeHidden && s.manual.Hidden[id] {
			continue
		}
		group := groups[id]
		if group == nil {
			name := s.manual.Names[id]
			if name == "" {
				suffix := strings.TrimPrefix(id, "p_")
				name = "人物 " + suffix[:min(6, len(suffix))]
			}
			group = &PersonGroup{ID: id, Name: name, Hidden: s.manual.Hidden[id]}
			groups[id] = group
			photos[id] = make(map[string]struct{})
		}
		group.FaceCount++
		photos[id][face.ResourceID] = struct{}{}
		if group.CoverResourceID == "" || face.ResourceID < group.CoverResourceID {
			group.CoverResourceID = face.ResourceID
		}
	}

	capacity := 0
	if limit > 0 {
		capacity = min(limit, len(s.faces))
	}
	selected := make(peopleGroupHeap, 0, capacity)
	if limit > 0 {
		heap.Init(&selected)
	}
	result := make([]PersonGroup, 0, len(groups))
	total := 0
	for id, group := range groups {
		group.PhotoCount = len(photos[id])
		if !includeHidden && group.Hidden {
			continue
		}
		total++
		if limit <= 0 {
			result = append(result, *group)
			continue
		}
		if len(selected) < limit {
			heap.Push(&selected, *group)
			continue
		}
		if peopleGroupRanksBefore(*group, selected[0]) {
			selected[0] = *group
			heap.Fix(&selected, 0)
		}
	}
	if limit > 0 {
		result = append(result, selected...)
	}
	sort.Slice(result, func(i, j int) bool {
		return peopleGroupRanksBefore(result[i], result[j])
	})
	return result, total
}

func peopleGroupRanksBefore(left, right PersonGroup) bool {
	if left.PhotoCount != right.PhotoCount {
		return left.PhotoCount > right.PhotoCount
	}
	if left.CoverResourceID != right.CoverResourceID {
		return left.CoverResourceID < right.CoverResourceID
	}
	return left.ID < right.ID
}

type peopleGroupHeap []PersonGroup

func (groups peopleGroupHeap) Len() int { return len(groups) }

func (groups peopleGroupHeap) Less(i, j int) bool {
	return peopleGroupRanksBefore(groups[j], groups[i])
}

func (groups peopleGroupHeap) Swap(i, j int) { groups[i], groups[j] = groups[j], groups[i] }

func (groups *peopleGroupHeap) Push(value any) {
	*groups = append(*groups, value.(PersonGroup))
}

func (groups *peopleGroupHeap) Pop() any {
	previous := *groups
	last := previous[len(previous)-1]
	*groups = previous[:len(previous)-1]
	return last
}

func (s *PeopleService) Faces(personID string) []PersonFace {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]PersonFace, 0)
	for _, face := range s.faces {
		if s.effectivePersonIDLocked(face) != personID {
			continue
		}
		face.PersonID = personID
		face.embedding = nil
		face.recordHash = ""
		result = append(result, face)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].ResourceID == result[j].ResourceID {
			return result[i].FaceIndex < result[j].FaceIndex
		}
		return result[i].ResourceID < result[j].ResourceID
	})
	return result
}

func (s *PeopleService) AllFaces() []PersonFace {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]PersonFace, 0, len(s.faces))
	for _, face := range s.faces {
		face.PersonID = s.effectivePersonIDLocked(face)
		face.embedding = nil
		face.recordHash = ""
		result = append(result, face)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].PersonID == result[j].PersonID {
			if result[i].ResourceID == result[j].ResourceID {
				return result[i].FaceIndex < result[j].FaceIndex
			}
			return result[i].ResourceID < result[j].ResourceID
		}
		return result[i].PersonID < result[j].PersonID
	})
	return result
}

func (s *PeopleService) Rename(personID, name string) error {
	name = strings.TrimSpace(name)
	if len([]rune(name)) > 60 || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return ErrInvalidPerson
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.hasPersonLocked(personID) {
		return ErrPersonNotFound
	}
	if name == "" {
		delete(s.manual.Names, personID)
	} else {
		s.manual.Names[personID] = name
	}
	return s.persistManualLocked()
}

func (s *PeopleService) SetHidden(personID string, hidden bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.hasPersonLocked(personID) {
		return ErrPersonNotFound
	}
	if hidden {
		s.manual.Hidden[personID] = true
	} else {
		delete(s.manual.Hidden, personID)
	}
	return s.persistManualLocked()
}

func (s *PeopleService) Merge(sourceID, targetID string) error {
	if sourceID == targetID || !validPersonID(sourceID) || !validPersonID(targetID) {
		return ErrInvalidPerson
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.hasPersonLocked(sourceID) || !s.hasPersonLocked(targetID) {
		return ErrPersonNotFound
	}
	for key, face := range s.faces {
		if s.effectivePersonIDLocked(face) == sourceID {
			s.manual.Assignments[key] = targetID
		}
	}
	delete(s.manual.Names, sourceID)
	delete(s.manual.Hidden, sourceID)
	return s.persistManualLocked()
}

func (s *PeopleService) Split(personID string, faceKeys []string) (string, error) {
	if !validPersonID(personID) || len(faceKeys) == 0 || len(faceKeys) > peopleMaxSplitFaces {
		return "", ErrInvalidPerson
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.hasPersonLocked(personID) {
		return "", ErrPersonNotFound
	}
	selected := make(map[string]struct{}, len(faceKeys))
	for _, key := range faceKeys {
		face, exists := s.faces[key]
		if !exists || s.effectivePersonIDLocked(face) != personID {
			return "", ErrInvalidPerson
		}
		selected[key] = struct{}{}
	}
	if len(selected) >= s.FacesLocked(personID) {
		return "", ErrInvalidPerson
	}
	newID, err := newManualPersonID()
	if err != nil {
		return "", err
	}
	for key := range selected {
		s.manual.Assignments[key] = newID
	}
	s.manual.Names[newID] = "新人物"
	if err := s.persistManualLocked(); err != nil {
		return "", err
	}
	return newID, nil
}

func (s *PeopleService) FacesLocked(personID string) int {
	count := 0
	for _, face := range s.faces {
		if s.effectivePersonIDLocked(face) == personID {
			count++
		}
	}
	return count
}

func newManualPersonID() (string, error) {
	bytes := make([]byte, 12)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return "p_m" + hex.EncodeToString(bytes), nil
}

func validPersonID(id string) bool {
	if !strings.HasPrefix(id, "p_") || len(id) < 6 || len(id) > 40 {
		return false
	}
	for _, char := range id[2:] {
		if !((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9')) {
			return false
		}
	}
	return true
}

func (s *PeopleService) hasPersonLocked(personID string) bool {
	for _, face := range s.faces {
		if s.effectivePersonIDLocked(face) == personID {
			return true
		}
	}
	return false
}

func (s *PeopleService) cleanAssignmentsLocked() {
	for key := range s.manual.Assignments {
		if _, exists := s.faces[key]; !exists {
			delete(s.manual.Assignments, key)
		}
	}
}

func (s *PeopleService) GroupingLimited() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.groupingLimited
}

func (s *PeopleService) Corrections() PeopleCorrections {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return PeopleCorrections{
		Version: peopleIndexVersion,
		Names:   cloneStringMap(s.manual.Names), Hidden: cloneBoolMap(s.manual.Hidden),
		Assignments: cloneStringMap(s.manual.Assignments),
	}
}

func (s *PeopleService) ReplaceCorrections(corrections PeopleCorrections) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.manual = normalizePeopleManualState(corrections)
	return s.persistManualLocked()
}

func cloneStringMap(source map[string]string) map[string]string {
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func cloneBoolMap(source map[string]bool) map[string]bool {
	result := make(map[string]bool, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func (s *PeopleService) Clear() error {
	s.persistMu.Lock()
	defer s.persistMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.faces = make(map[string]PersonFace)
	s.clusters = make(map[string]*peopleCluster)
	s.previousIDs = make(map[string]string)
	s.comparisons = 0
	s.groupingLimited = false
	s.manual = emptyPeopleManualState()
	if err := s.persistManualLocked(); err != nil {
		return err
	}
	if err := os.Remove(s.derivedPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (s *PeopleService) persistManualLocked() error {
	return writeAIJSONAtomic(s.statePath, s.manual)
}

func (s *PeopleService) persistLocked() error {
	if err := s.persistIndexSnapshot(s.indexSnapshotLocked()); err != nil {
		return err
	}
	s.updatePreviousIDsLocked()
	return s.persistManualLocked()
}

func (s *PeopleService) indexSnapshotLocked() peopleIndexDisk {
	disk := peopleIndexDisk{Version: peopleIndexVersion, Faces: make([]peopleFaceDisk, 0, len(s.faces))}
	for _, face := range s.faces {
		disk.Faces = append(disk.Faces, peopleFaceDisk{
			Key: face.Key, ResourceID: face.ResourceID, FaceIndex: face.FaceIndex,
			ClusterID: face.PersonID, Box: face.Box, Score: face.Score, Size: face.Size, MTimeNs: face.MTimeNs,
		})
	}
	return disk
}

func (s *PeopleService) persistIndexSnapshot(disk peopleIndexDisk) error {
	sort.Slice(disk.Faces, func(i, j int) bool { return disk.Faces[i].Key < disk.Faces[j].Key })
	return writeAIJSONAtomic(s.derivedPath, disk)
}

func (s *PeopleService) updatePreviousIDsLocked() {
	referencedIDs := peopleReferencedIDs(s.manual)
	s.previousIDs = make(map[string]string)
	for key, face := range s.faces {
		if referencedIDs[face.PersonID] {
			s.previousIDs[key] = face.PersonID
		}
	}
}
