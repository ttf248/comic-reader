package services

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/pathutil"
)

// ResourceKind 是业务 API 可引用的媒体资源类型。
type ResourceKind string

const (
	ResourceRoot       ResourceKind = "root"
	ResourceAlbum      ResourceKind = "album"
	ResourceCollection ResourceKind = "collection"
	ResourceFile       ResourceKind = "file"
)

// ResourceRef 是绝对路径在业务边界上的脱敏表示。
type ResourceRef struct {
	ID           string
	Kind         ResourceKind
	RootID       string
	RelativePath string
	AbsolutePath string
}

type resourceCatalogState struct {
	revision      uint64
	byID          map[string]ResourceRef
	byPathKind    map[string]string
	roots         []ResourceRef
	result        *models.ScanResult
	albums        map[string]models.Album
	collections   map[string]models.Collection
	customCovers  map[string]bool
	contentPolicy ContentKindPolicy
	library       *libraryPageIndex
}

// CatalogSnapshot 是一次请求期间固定的资源视图。它把扫描结果、
// 对外 DTO 和 ID 解析表绑在同一个不可变状态上，避免一次响应混用
// 重扫前后两个版本。
type CatalogSnapshot struct {
	state *resourceCatalogState
}

// ResourceCatalog 保存不可变的资源索引；重扫时原子替换整份快照。
// handler 只能通过 ID 解析路径，业务响应不再暴露绝对路径。
type ResourceCatalog struct {
	state     atomic.Pointer[resourceCatalogState]
	revision  atomic.Uint64
	publishMu sync.Mutex
	// contentKinds 是内容用途的默认策略与相册级覆盖。
	// 只在 publishMu 保护下读写，随每次发布一起进入快照。
	contentPolicy   ContentKindPolicy
	contentOverrides map[string]models.ContentKind
}

func NewResourceCatalog() *ResourceCatalog {
	c := &ResourceCatalog{}
	c.state.Store(emptyCatalogState(0))
	return c
}

func emptyCatalogState(revision uint64) *resourceCatalogState {
	return &resourceCatalogState{
		revision:     revision,
		byID:         map[string]ResourceRef{},
		byPathKind:   map[string]string{},
		albums:       map[string]models.Album{},
		collections:  map[string]models.Collection{},
		customCovers: map[string]bool{},
	}
}

// Publish 先在私有内存中构建完整结果与 ID 索引，最后只用一次
// atomic.Store 对请求发布。发布后的状态严格只读。
func (c *ResourceCatalog) Publish(result *models.ScanResult, roots []string) uint64 {
	c.publishMu.Lock()
	defer c.publishMu.Unlock()
	return c.publish(result, roots, nil)
}

// CommitScan 把封面覆盖、资源视图与磁盘恢复快照置于同一提交锁下。
// HTTP 读路径只观察 catalog 的单次原子发布；cache 仅作为重启恢复副本。
func (c *ResourceCatalog) CommitScan(
	result *models.ScanResult,
	roots []string,
	cache *ScanResultCache,
	covers *CoverOverrideStore,
) (*models.ScanResult, uint64) {
	c.publishMu.Lock()
	defer c.publishMu.Unlock()
	published := result
	overrides := map[string]CoverOverride{}
	if covers != nil {
		overrides = covers.Snapshot()
		published, _ = ApplyCoverOverridesToResult(result, overrides)
	}
	revision := c.publish(published, roots, activeCustomCoverPaths(published, overrides))
	if cache != nil {
		cache.Set(published)
	}
	return published, revision
}

// RefreshCovers 基于当前最新库快照重建封面视图，避免设置封面与同时
// 完成的扫描互相覆盖。
func (c *ResourceCatalog) RefreshCovers(cache *ScanResultCache, covers *CoverOverrideStore) (*models.ScanResult, uint64, bool) {
	c.publishMu.Lock()
	defer c.publishMu.Unlock()
	current := c.state.Load()
	if current == nil || current.result == nil {
		return nil, 0, false
	}
	overrides := map[string]CoverOverride{}
	if covers != nil {
		overrides = covers.Snapshot()
	}
	next, _ := RebuildCoverView(current.result, overrides)
	roots := make([]string, 0, len(current.roots))
	for _, root := range current.roots {
		roots = append(roots, root.AbsolutePath)
	}
	revision := c.publish(next, roots, activeCustomCoverPaths(next, overrides))
	if cache != nil {
		cache.Set(next)
	}
	return next, revision, true
}

// SetContentKindPolicy 更新内容用途的默认策略并重新发布快照。
//
// 媒体根默认值或全局默认值变化时调用：用途不影响扫描结果，
// 因此只需重算相册元数据，不必重新扫描磁盘。
func (c *ResourceCatalog) SetContentKindPolicy(policy ContentKindPolicy) uint64 {
	c.publishMu.Lock()
	defer c.publishMu.Unlock()
	c.contentPolicy = policy
	return c.republishLocked()
}

// SetContentKindOverrides 替换相册级内容用途覆盖并重新发布快照。
func (c *ResourceCatalog) SetContentKindOverrides(overrides map[string]models.ContentKind) uint64 {
	c.publishMu.Lock()
	defer c.publishMu.Unlock()
	c.contentOverrides = overrides
	return c.republishLocked()
}

// ContentKindPolicySnapshot 返回当前生效的默认策略（副本）。
func (c *ResourceCatalog) ContentKindPolicySnapshot() ContentKindPolicy {
	c.publishMu.Lock()
	defer c.publishMu.Unlock()
	return c.contentPolicy
}

// republishLocked 用当前已发布的结果重新构造快照。
// 调用方必须已持有 publishMu。
func (c *ResourceCatalog) republishLocked() uint64 {
	current := c.state.Load()
	if current == nil || current.result == nil {
		return current.revision
	}
	roots := make([]string, 0, len(current.roots))
	for _, root := range current.roots {
		roots = append(roots, root.AbsolutePath)
	}
	return c.publish(current.result, roots, current.customCovers)
}

// ClearWithCache 在同一提交锁下清空请求快照与重启恢复副本。
func (c *ResourceCatalog) ClearWithCache(cache *ScanResultCache) error {
	c.publishMu.Lock()
	defer c.publishMu.Unlock()
	if cache != nil {
		if err := cache.Clear(); err != nil {
			return err
		}
	}
	revision := c.revision.Add(1)
	c.state.Store(emptyCatalogState(revision))
	return nil
}

func (c *ResourceCatalog) publish(result *models.ScanResult, roots []string, customCovers map[string]bool) uint64 {
	revision := c.revision.Add(1)
	state := &resourceCatalogState{
		revision:      revision,
		byID:          make(map[string]ResourceRef),
		byPathKind:    make(map[string]string),
		albums:        make(map[string]models.Album),
		collections:   make(map[string]models.Collection),
		customCovers:  cloneCustomCoverPaths(customCovers),
		contentPolicy: c.contentPolicy,
	}
	for _, root := range pathutil.NormalizeRoots(roots) {
		abs, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		abs = filepath.Clean(abs)
		rootID := rootIDFor(abs)
		ref := ResourceRef{
			ID:           rootID,
			Kind:         ResourceRoot,
			RootID:       rootID,
			AbsolutePath: abs,
		}
		state.roots = append(state.roots, ref)
		state.byID[rootID] = ref
		state.byPathKind[pathKindKey(abs, ResourceRoot)] = rootID
	}
	// 根路径按长度降序，嵌套根场景优先匹配最具体的根。
	sort.Slice(state.roots, func(i, j int) bool {
		return len(state.roots[i].AbsolutePath) > len(state.roots[j].AbsolutePath)
	})
	if result != nil {
		state.result = cloneScanResult(result)
		// 内容用途在发布这一刻定稿：相册级覆盖优先，其次媒体根默认值，
		// 最后全局默认值。它不依赖文件内容，因此重扫也不会改变用户的选择。
		ApplyContentKinds(state.result, c.contentOverrides, c.contentPolicy)
		for i := range state.result.Albums {
			indexAlbum(state, &state.result.Albums[i])
		}
		for i := range state.result.Collections {
			indexCollection(state, &state.result.Collections[i])
		}
		for i := range state.result.SmartCollections {
			for j := range state.result.SmartCollections[i].Albums {
				indexAlbum(state, &state.result.SmartCollections[i].Albums[j])
			}
		}
		state.library = buildLibraryPageIndex(state)
	}
	c.state.Store(state)
	return revision
}

// activeCustomCoverPaths 只保留已经应用到当前扫描结果的人工封面。
// 覆盖记录可能指向已删除或不再属于相册的文件；这些失效记录不能污染
// 面向客户端的摘要状态。
func activeCustomCoverPaths(result *models.ScanResult, overrides map[string]CoverOverride) map[string]bool {
	active := make(map[string]bool)
	if result == nil || len(overrides) == 0 {
		return active
	}
	seen := make(map[string]bool)
	mark := func(album models.Album) {
		albumPath := filepath.Clean(album.Path)
		if seen[albumPath] {
			return
		}
		seen[albumPath] = true
		override, exists := overrides[albumPath]
		if !exists || !albumContainsMedia(album, override.File) {
			return
		}
		if pathKindKey(album.CoverImage, ResourceFile) != pathKindKey(override.File, ResourceFile) {
			return
		}
		active[albumPath] = true
	}
	for _, album := range result.Albums {
		mark(album)
	}
	var walkCollections func([]models.Collection)
	walkCollections = func(collections []models.Collection) {
		for _, collection := range collections {
			for _, album := range collection.Albums {
				mark(album)
			}
			walkCollections(collection.Collections)
		}
	}
	walkCollections(result.Collections)
	for _, smart := range result.SmartCollections {
		for _, album := range smart.Albums {
			mark(album)
		}
	}
	return active
}

func cloneCustomCoverPaths(paths map[string]bool) map[string]bool {
	cloned := make(map[string]bool, len(paths))
	for path, active := range paths {
		if active {
			cloned[path] = true
		}
	}
	return cloned
}

// Clear 立即使所有旧资源 ID 失效。
func (c *ResourceCatalog) Clear() uint64 {
	if c == nil {
		return 0
	}
	c.publishMu.Lock()
	defer c.publishMu.Unlock()
	revision := c.revision.Add(1)
	c.state.Store(emptyCatalogState(revision))
	return revision
}

// Acquire 只读取一次原子指针；调用方应在整个请求中复用返回值。
func (c *ResourceCatalog) Acquire() CatalogSnapshot {
	if c == nil {
		return CatalogSnapshot{}
	}
	return CatalogSnapshot{state: c.state.Load()}
}

// Resolve 将业务资源 ID 解析为内部绝对路径。
func (c *ResourceCatalog) Resolve(id string) (string, bool) {
	return c.Acquire().Resolve(id)
}

// ResolveWithSnapshot 供资源路由中间件在解析 ID 时同时固定快照。
// handler 从 Fiber Locals 取回该值后，整个请求不会跨扫描版本。
func (c *ResourceCatalog) ResolveWithSnapshot(id string) (string, any, bool) {
	snapshot := c.Acquire()
	path, ok := snapshot.Resolve(id)
	return path, snapshot, ok
}

func (c *ResourceCatalog) Lookup(id string) (ResourceRef, bool) {
	return c.Acquire().Lookup(id)
}

// Ready 表示资源目录已经由磁盘快照或一次完整扫描构建完成。
func (c *ResourceCatalog) Ready() bool {
	return c.Acquire().Ready()
}

// ExternalID 返回内部路径对应的业务 ID；未知路径返回空，避免意外泄露。
func (c *ResourceCatalog) ExternalID(path string, kind ResourceKind) string {
	return c.Acquire().ExternalID(path, kind)
}

// RelativeLabel 返回适合展示的“根别名/相对路径”。
func (c *ResourceCatalog) RelativeLabel(id string) string {
	return c.Acquire().RelativeLabel(id)
}

func (s CatalogSnapshot) Revision() uint64 {
	if s.state == nil {
		return 0
	}
	return s.state.revision
}

func (s CatalogSnapshot) Ready() bool {
	return s.state != nil && s.state.result != nil && len(s.state.roots) > 0
}

func (s CatalogSnapshot) Resolve(id string) (string, bool) {
	ref, ok := s.Lookup(id)
	return ref.AbsolutePath, ok
}

func (s CatalogSnapshot) Lookup(id string) (ResourceRef, bool) {
	if s.state == nil {
		return ResourceRef{}, false
	}
	ref, ok := s.state.byID[id]
	return ref, ok
}

func (s CatalogSnapshot) ExternalID(path string, kind ResourceKind) string {
	if s.state == nil || path == "" {
		return ""
	}
	return s.state.byPathKind[pathKindKey(path, kind)]
}

func (s CatalogSnapshot) RelativeLabel(id string) string {
	ref, ok := s.Lookup(id)
	if !ok {
		return ""
	}
	rootName := "媒体库"
	if root, exists := s.Lookup(ref.RootID); exists {
		if name := filepath.Base(root.AbsolutePath); name != "." && name != string(filepath.Separator) {
			rootName = name
		}
	}
	if ref.RelativePath == "" {
		return rootName
	}
	return rootName + "/" + filepath.ToSlash(ref.RelativePath)
}

// AlbumSummary 返回相册的对外摘要（含内容用途）。相册不存在或不是相册时返回 false。
func (s CatalogSnapshot) AlbumSummary(id string) (LibraryNodeSummary, bool) {
	if s.state == nil || s.state.library == nil {
		return LibraryNodeSummary{}, false
	}
	summary, ok := s.state.library.nodes[id]
	if !ok || summary.Kind != string(ResourceAlbum) {
		return LibraryNodeSummary{}, false
	}
	return summary, true
}

// Result 返回内部路径快照，仅供需要文件系统路径的服务端代码只读使用。
func (s CatalogSnapshot) Result() *models.ScanResult {
	if s.state == nil {
		return nil
	}
	return s.state.result
}

func indexCollection(state *resourceCatalogState, collection *models.Collection) {
	if id := indexPath(state, collection.Path, ResourceCollection); id != "" {
		state.collections[id] = *collection
	}
	for i := range collection.Albums {
		indexAlbum(state, &collection.Albums[i])
	}
	for i := range collection.Collections {
		indexCollection(state, &collection.Collections[i])
	}
}

func indexAlbum(state *resourceCatalogState, album *models.Album) {
	if id := indexPath(state, album.Path, ResourceAlbum); id != "" {
		state.albums[id] = *album
	}
	for _, path := range album.ImageFiles {
		indexPath(state, path, ResourceFile)
	}
	for _, path := range album.VideoFiles {
		indexPath(state, path, ResourceFile)
	}
	if album.CoverImage != "" {
		indexPath(state, album.CoverImage, ResourceFile)
	}
}

func indexPath(state *resourceCatalogState, path string, kind ResourceKind) string {
	if path == "" {
		return ""
	}
	abs := filepath.Clean(path)
	for _, root := range state.roots {
		rel, err := filepath.Rel(root.AbsolutePath, abs)
		if err != nil || relEscapesRoot(rel) {
			continue
		}
		rel = filepath.ToSlash(rel)
		if rel == "." {
			rel = ""
		}
		id := resourceID(root.ID, kind, rel)
		ref := ResourceRef{
			ID:           id,
			Kind:         kind,
			RootID:       root.ID,
			RelativePath: rel,
			AbsolutePath: abs,
		}
		state.byID[id] = ref
		state.byPathKind[pathKindKey(abs, kind)] = id
		return id
	}
	return ""
}

func externalID(state *resourceCatalogState, path string, kind ResourceKind) string {
	if state == nil || path == "" {
		return ""
	}
	return state.byPathKind[pathKindKey(path, kind)]
}

func rootIDFor(abs string) string {
	normalized := pathutil.RootKey(abs)
	sum := sha256.Sum256([]byte(normalized))
	return "r_" + hex.EncodeToString(sum[:6])
}

func resourceID(rootID string, kind ResourceKind, rel string) string {
	normalized := filepath.ToSlash(filepath.Clean(rel))
	if runtime.GOOS == "windows" {
		normalized = strings.ToLower(normalized)
	}
	sum := sha256.Sum256([]byte(rootID + "\x00" + string(kind) + "\x00" + normalized))
	prefix := "x_"
	switch kind {
	case ResourceAlbum:
		prefix = "a_"
	case ResourceCollection:
		prefix = "c_"
	case ResourceFile:
		prefix = "f_"
	}
	return prefix + base64.RawURLEncoding.EncodeToString(sum[:16])
}

func pathKindKey(path string, kind ResourceKind) string {
	path = filepath.Clean(path)
	if runtime.GOOS == "windows" {
		path = strings.ToLower(path)
	}
	return string(kind) + "\x00" + path
}

func relEscapesRoot(rel string) bool {
	return rel == ".." || filepath.IsAbs(rel) || strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
