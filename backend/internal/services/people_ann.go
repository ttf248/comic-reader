package services

import (
	"container/heap"
	"math"
	"math/rand"
	"sort"
)

const (
	peopleANNConnections    = 16
	peopleANNEfConstruction = 100
	peopleANNEfSearch       = 128
	peopleANNCandidateLimit = 128
)

type peopleANNHit struct {
	id    string
	score float32
}

type peopleANNNode struct {
	id        string
	vector    []float32
	level     int
	neighbors [][]int
}

type peopleANNCandidate struct {
	index int
	score float32
}

type peopleANNQueue struct {
	items []peopleANNCandidate
	max   bool
}

func (q peopleANNQueue) Len() int { return len(q.items) }
func (q peopleANNQueue) Less(i, j int) bool {
	left, right := q.items[i], q.items[j]
	if q.max {
		return peopleANNBetter(left, right)
	}
	return peopleANNBetter(right, left)
}
func (q peopleANNQueue) Swap(i, j int) { q.items[i], q.items[j] = q.items[j], q.items[i] }
func (q *peopleANNQueue) Push(value any) {
	q.items = append(q.items, value.(peopleANNCandidate))
}
func (q *peopleANNQueue) Pop() any {
	last := len(q.items) - 1
	value := q.items[last]
	q.items = q.items[:last]
	return value
}

type peopleANNIndex struct {
	nodes          []peopleANNNode
	nodeByID       map[string]int
	entry          int
	maxLevel       int
	rng            *rand.Rand
	connections    int
	efConstruction int
	efSearch       int
}

func newPeopleANNIndex() *peopleANNIndex {
	return &peopleANNIndex{
		nodeByID:       make(map[string]int),
		entry:          -1,
		maxLevel:       -1,
		rng:            rand.New(rand.NewSource(42)),
		connections:    peopleANNConnections,
		efConstruction: peopleANNEfConstruction,
		efSearch:       peopleANNEfSearch,
	}
}

func (index *peopleANNIndex) Len() int {
	return len(index.nodes)
}

func (index *peopleANNIndex) Add(id string, vector []float32) {
	if existing, exists := index.nodeByID[id]; exists {
		index.nodes[existing].vector = vector
		return
	}

	level := index.randomLevel()
	nodeIndex := len(index.nodes)
	index.nodes = append(index.nodes, peopleANNNode{
		id: id, vector: vector, level: level, neighbors: make([][]int, level+1),
	})
	index.nodeByID[id] = nodeIndex
	if index.entry == -1 {
		index.entry = nodeIndex
		index.maxLevel = level
		return
	}

	entry := index.entry
	for layer := index.maxLevel; layer > level; layer-- {
		entry = index.greedyClosest(vector, entry, layer)
	}
	for layer := min(level, index.maxLevel); layer >= 0; layer-- {
		candidates := index.searchLayer(vector, entry, index.efConstruction, layer)
		neighbors := index.selectNeighbors(vector, candidates, index.maxNeighbors(layer))
		index.nodes[nodeIndex].neighbors[layer] = neighbors
		for _, neighborIndex := range neighbors {
			neighbor := &index.nodes[neighborIndex]
			neighbor.neighbors[layer] = append(neighbor.neighbors[layer], nodeIndex)
			if len(neighbor.neighbors[layer]) > index.maxNeighbors(layer) {
				neighbor.neighbors[layer] = index.pruneNeighbors(neighborIndex, layer)
			}
		}
		if len(candidates) > 0 {
			entry = candidates[0].index
		}
	}
	if level > index.maxLevel {
		index.entry = nodeIndex
		index.maxLevel = level
	}
}

func (index *peopleANNIndex) Search(query []float32, limit int) []peopleANNHit {
	if index.entry < 0 || limit <= 0 || len(query) != peopleEmbeddingDimension {
		return nil
	}
	if len(index.nodes) <= limit {
		hits := make([]peopleANNHit, len(index.nodes))
		for i, node := range index.nodes {
			hits[i] = peopleANNHit{id: node.id, score: peopleANNDot(query, node.vector)}
		}
		sort.Slice(hits, func(i, j int) bool {
			if hits[i].score != hits[j].score {
				return hits[i].score > hits[j].score
			}
			return hits[i].id < hits[j].id
		})
		return hits
	}
	entry := index.entry
	for layer := index.maxLevel; layer > 0; layer-- {
		entry = index.greedyClosest(query, entry, layer)
	}
	candidates := index.searchLayer(query, entry, max(index.efSearch, limit), 0)
	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	hits := make([]peopleANNHit, len(candidates))
	for i, candidate := range candidates {
		hits[i] = peopleANNHit{id: index.nodes[candidate.index].id, score: candidate.score}
	}
	return hits
}

func (index *peopleANNIndex) randomLevel() int {
	value := index.rng.Float64()
	if value == 0 {
		value = 1e-12
	}
	return int(math.Floor(-math.Log(value) / math.Log(float64(index.connections))))
}

func (index *peopleANNIndex) maxNeighbors(layer int) int {
	if layer == 0 {
		return 2 * index.connections
	}
	return index.connections
}

func (index *peopleANNIndex) greedyClosest(query []float32, entry, layer int) int {
	best := peopleANNCandidate{index: entry, score: peopleANNDot(query, index.nodes[entry].vector)}
	for {
		changed := false
		for _, neighbor := range index.nodes[best.index].neighbors[layer] {
			candidate := peopleANNCandidate{index: neighbor, score: peopleANNDot(query, index.nodes[neighbor].vector)}
			if peopleANNBetter(candidate, best) {
				best = candidate
				changed = true
			}
		}
		if !changed {
			return best.index
		}
	}
}

func (index *peopleANNIndex) searchLayer(query []float32, entry, limit, layer int) []peopleANNCandidate {
	if limit < 1 {
		limit = 1
	}
	first := peopleANNCandidate{index: entry, score: peopleANNDot(query, index.nodes[entry].vector)}
	candidates := &peopleANNQueue{items: []peopleANNCandidate{first}, max: true}
	results := &peopleANNQueue{items: []peopleANNCandidate{first}}
	heap.Init(candidates)
	heap.Init(results)
	visited := map[int]struct{}{entry: {}}
	for candidates.Len() > 0 {
		current := heap.Pop(candidates).(peopleANNCandidate)
		worst := results.items[0]
		if results.Len() >= limit && !peopleANNBetter(current, worst) {
			break
		}
		for _, neighbor := range index.nodes[current.index].neighbors[layer] {
			if _, exists := visited[neighbor]; exists {
				continue
			}
			visited[neighbor] = struct{}{}
			candidate := peopleANNCandidate{index: neighbor, score: peopleANNDot(query, index.nodes[neighbor].vector)}
			if results.Len() < limit || peopleANNBetter(candidate, results.items[0]) {
				heap.Push(candidates, candidate)
				heap.Push(results, candidate)
				if results.Len() > limit {
					heap.Pop(results)
				}
			}
		}
	}
	ordered := append([]peopleANNCandidate(nil), results.items...)
	sort.Slice(ordered, func(i, j int) bool {
		return peopleANNBetter(ordered[i], ordered[j])
	})
	return ordered
}

func (index *peopleANNIndex) selectNeighbors(query []float32, candidates []peopleANNCandidate, limit int) []int {
	selected := make([]int, 0, min(limit, len(candidates)))
	pruned := make([]int, 0, len(candidates))
	for _, candidate := range candidates {
		if len(selected) >= limit {
			break
		}
		dominated := false
		for _, selectedIndex := range selected {
			if peopleANNDot(index.nodes[candidate.index].vector, index.nodes[selectedIndex].vector) > candidate.score {
				dominated = true
				break
			}
		}
		if dominated {
			pruned = append(pruned, candidate.index)
		} else {
			selected = append(selected, candidate.index)
		}
	}
	for _, candidateIndex := range pruned {
		if len(selected) >= limit {
			break
		}
		selected = append(selected, candidateIndex)
	}
	return selected
}

func (index *peopleANNIndex) pruneNeighbors(nodeIndex, layer int) []int {
	query := index.nodes[nodeIndex].vector
	neighbors := index.nodes[nodeIndex].neighbors[layer]
	candidates := make([]peopleANNCandidate, len(neighbors))
	for i, neighbor := range neighbors {
		candidates[i] = peopleANNCandidate{index: neighbor, score: peopleANNDot(query, index.nodes[neighbor].vector)}
	}
	sort.Slice(candidates, func(i, j int) bool {
		return peopleANNBetter(candidates[i], candidates[j])
	})
	return index.selectNeighbors(query, candidates, index.maxNeighbors(layer))
}

func peopleANNBetter(left, right peopleANNCandidate) bool {
	if left.score != right.score {
		return left.score > right.score
	}
	return left.index < right.index
}

func peopleANNDot(left, right []float32) float32 {
	var score float32
	for i, value := range left {
		score += value * right[i]
	}
	return score
}
