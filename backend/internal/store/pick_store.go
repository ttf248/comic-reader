package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

// MaxPicks 是精选条目的上限。
//
// 精选是照片级数据：一次「把这一屏全选加入精选」就能塞进几百张，
// 因此上限比收藏宽松；但仍要有硬边界 —— 精选集合会被整份写进状态文件。
const MaxPicks = 5000

// ErrPickLimit 表示精选超过上限。
var ErrPickLimit = errors.New("pick limit exceeded")

// pickFileVersion 是 state/picks.json 的格式版本。
const pickFileVersion = 1

// pickFile 是 state/picks.json 的磁盘格式。
//
// Picks 的顺序有意义：最近加入的排在最前面，照片墙的「精选」页
// 直接按这个顺序展示，不用另存一个加入时间。
type pickFile struct {
	Version int      `json:"version"`
	Picks   []string `json:"picks"`
}

// PickStore 持久化照片级精选。
//
// 精选与相册级收藏是两份数据、两种语义：收藏标记「这一本值得留着」，
// 精选标记「这一张值得留着」。两者互不覆盖，也不会互相清理 ——
// 清掉一个失效的收藏不该动精选，反之亦然。
//
// 内存里同时保存有序列表与集合：列表给展示顺序用，集合给 O(1) 的
// 「这张照片在不在精选里」用 —— 照片墙每一格都要问一次。
type PickStore struct {
	path string

	mu     sync.RWMutex
	order  []string
	set    map[string]struct{}
	loaded bool
	// revision 在每次成功写入后递增。精选页的翻页游标把它编进作用域：
	// 精选一变，旧的游标立刻失效，不会把已经翻过的页顶走一格。
	revision uint64
}

// NewPickStore 创建存储（不立即读盘）。
func NewPickStore(path string) *PickStore {
	return &PickStore{path: path}
}

// load 读取并解析文件到内存缓存。
// 文件不存在 → 空精选；解析失败 → 备份坏文件并按空精选继续，
// 保证坏状态不会让整个服务起不来。
func (s *PickStore) load() error {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			s.order = []string{}
			s.set = map[string]struct{}{}
			s.loaded = true
			return nil
		}
		return err
	}
	var file pickFile
	if err := json.Unmarshal(data, &file); err != nil {
		stamp := time.Now().Format("20060102150405") + "-" + fmt.Sprintf("%d", time.Now().UnixNano()%1_000_000)
		_ = os.Rename(s.path, s.path+".corrupt."+stamp)
		s.order = []string{}
		s.set = map[string]struct{}{}
		s.loaded = true
		return nil
	}
	order, set := normalizePicks(file.Picks)
	s.order = order
	s.set = set
	s.loaded = true
	return nil
}

// normalizePicks 去掉非法与重复的文件 ID，并保持原有顺序。
func normalizePicks(ids []string) ([]string, map[string]struct{}) {
	order := make([]string, 0, len(ids))
	set := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if !models.IsFileID(id) {
			continue
		}
		if _, exists := set[id]; exists {
			continue
		}
		set[id] = struct{}{}
		order = append(order, id)
	}
	return order, set
}

// ensureLoaded 必须在已持锁时调用。
func (s *PickStore) ensureLoaded() error {
	if s.loaded {
		return nil
	}
	return s.load()
}

// Get 返回精选的文件 ID 列表（最近加入在前）。
func (s *PickStore) Get() []string {
	s.mu.RLock()
	if s.loaded {
		out := make([]string, len(s.order))
		copy(out, s.order)
		s.mu.RUnlock()
		return out
	}
	s.mu.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return []string{}
	}
	out := make([]string, len(s.order))
	copy(out, s.order)
	return out
}

// Count 返回精选条数。
func (s *PickStore) Count() int {
	s.mu.RLock()
	if s.loaded {
		count := len(s.order)
		s.mu.RUnlock()
		return count
	}
	s.mu.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return 0
	}
	return len(s.order)
}

// Revision 返回精选的版本号。它在每次成功写入后递增。
func (s *PickStore) Revision() uint64 {
	s.mu.RLock()
	if s.loaded {
		revision := s.revision
		s.mu.RUnlock()
		return revision
	}
	s.mu.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return 0
	}
	return s.revision
}

// Contains 一次锁定回答这批 ID 各自是否在精选中。
//
// 照片墙要为一页里的每一格问同一个问题，逐个调用会反复抢锁；
// 这个入口在一次读锁内算完整批，调用方按下标对齐即可。
func (s *PickStore) Contains(ids []string) []bool {
	flags := make([]bool, len(ids))
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return flags
	}
	for i, id := range ids {
		_, ok := s.set[id]
		flags[i] = ok
	}
	return flags
}

// Batch 一次锁内处理整批精选的加入或移出。
//
// 加入是幂等的；移出对不存在的条目没有影响。changed 是实际变化的条数，
// 没有变化时不落盘。
func (s *PickStore) Batch(ids []string, add bool) (int, error) {
	for _, id := range ids {
		if !models.IsFileID(id) {
			return 0, errors.New("invalid pick identity")
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return 0, err
	}
	next := make([]string, len(s.order))
	copy(next, s.order)
	nextSet := make(map[string]struct{}, len(s.set))
	for id := range s.set {
		nextSet[id] = struct{}{}
	}
	changed := 0
	if add {
		added := make([]string, 0, len(ids))
		for _, id := range ids {
			if _, exists := nextSet[id]; exists {
				continue
			}
			nextSet[id] = struct{}{}
			added = append(added, id)
			changed++
		}
		if len(nextSet) > MaxPicks {
			return 0, ErrPickLimit
		}
		// 新加入的排在最前面；同一批内部保持传入顺序。
		next = append(added, next...)
	} else {
		remove := make(map[string]struct{}, len(ids))
		for _, id := range ids {
			remove[id] = struct{}{}
		}
		kept := make([]string, 0, len(next))
		for _, id := range next {
			if _, drop := remove[id]; drop {
				delete(nextSet, id)
				changed++
				continue
			}
			kept = append(kept, id)
		}
		next = kept
	}
	if changed > 0 {
		if err := s.commitLocked(next); err != nil {
			return 0, err
		}
	}
	return changed, nil
}

// Replace 用给定集合整体替换精选（状态恢复用）。
func (s *PickStore) Replace(ids []string) error {
	for _, id := range ids {
		if !models.IsFileID(id) {
			return errors.New("invalid pick identity")
		}
	}
	order, _ := normalizePicks(ids)
	if len(order) > MaxPicks {
		return ErrPickLimit
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureLoaded(); err != nil {
		return err
	}
	return s.commitLocked(order)
}

// Snapshot 返回精选的当前内容与集合视图，供状态备份比对与恢复。
func (s *PickStore) Snapshot() []string {
	return s.Get()
}

// commitLocked 必须在已持锁时调用。磁盘替换成功后才发布新的内存快照。
func (s *PickStore) commitLocked(order []string) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	data, err := json.Marshal(pickFile{Version: pickFileVersion, Picks: order})
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename %s -> %s: %w", tmp, s.path, err)
	}
	s.order = order
	s.set = make(map[string]struct{}, len(order))
	for _, id := range order {
		s.set[id] = struct{}{}
	}
	s.revision++
	return nil
}
