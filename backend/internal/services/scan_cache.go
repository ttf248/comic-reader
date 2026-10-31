// Package services 提供本地画廊核心业务服务。
package services

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/pathutil"
)

// scanResultSnapshot 不可变快照:发布到 latest 之后,调用方只能读不能改。
// 修改必须构造新 snapshot 并通过 CAS 替换。
type scanResultSnapshot struct {
	result  *models.ScanResult
	version uint64 // 单调递增,用于 flush 协调
}

// ScanResultCache 全局扫描结果缓存。
//
//   - 每次成功扫描完成后由 AsyncScanRunner 写入
//   - 服务启动时从磁盘加载,供前端无需重新扫描即可看到上次结果
//   - 读路径无锁(atomic.Pointer.Load),大库下首页 100+ 卡片并发 Get
//     不再争夺同一把 RWMutex
//   - 写路径通过 atomic.Store 一次性发布;修改类操作(ApplyCoverOverrides /
//     SetWithOverrideApplied)走 CAS 重试,失败重试一次
//   - 写盘异步 + 防抖,避免在 SSE 完成路径上卡住事件流
type ScanResultCache struct {
	path string

	// latest 是当前快照,只读访问。读路径 atomic.Load 无锁;写路径构造新
	// snapshot 并 atomic.Store 替换。中间用 CAS 重试保证多写者不会互相覆盖。
	latest atomic.Pointer[scanResultSnapshot]

	// version 与 dirtyVer 配合:每次 Set/Apply/SetWith... 都 bump version,
	// dirtyVer 记下"需要落盘"的版本号;flush 完成后若 dirtyVer 等于刚
	// 落盘的 version 则清零(用 CAS 避免覆盖并发新写)。
	version  atomic.Uint64
	dirtyVer atomic.Uint64

	// flush 串行化:同一时刻只能有一个 goroutine 在写盘。
	flushMu    sync.Mutex
	flushTimer *time.Timer
}

const (
	flushDebounce          = 500 * time.Millisecond
	scanCacheSchemaVersion = 5
)

type scanCacheEnvelope struct {
	SchemaVersion int                `json:"schemaVersion"`
	RootIDs       []string           `json:"rootIds"`
	Result        *models.ScanResult `json:"result"`
}

// NewScanResultCache 创建缓存，path 为磁盘持久化文件路径。
func NewScanResultCache(path string) *ScanResultCache {
	return &ScanResultCache{path: path}
}

// Get 返回当前缓存的扫描结果(直接返回 atomic snapshot,无锁无深拷贝)。
//
// 关键约束:返回值是「发布后不可变」的快照,调用方只读;任何修改必须
// 走 Set / SetWithOverrideApplied / ApplyCoverOverrides 重新发布。
// 之前 Get 会做 cloneScanResult 整树深拷贝,5k+ 相册 * 200 张图每次
// 都走一遍 deep copy,前端每次 GET /api/library 都要付这笔钱。
//
// 为兼容旧的"调用方修改返回值"行为(虽然不推荐),已有调用方实际
// 没改 ScanResult(grep 全工程未发现 result.Albums[i] = 之类的写
// 操作),只是读了。Get 现在不再做防御性拷贝,改为文档化"只读"契约。
func (c *ScanResultCache) Get() *models.ScanResult {
	snap := c.latest.Load()
	if snap == nil {
		return nil
	}
	return snap.result
}

// Set 写入新的扫描结果并异步、防抖落盘。
//
// 落盘通过 timer 延迟 500ms;若在延迟窗口内再次 Set 则重置 timer,
// 实现"连续多次写合并为一次落盘"。落盘失败不丢内存结果(下次 Set
// 或显式 Flush 会再尝试)。
//
// 关键改动:这里做一次 cloneScanResult 是必要的——外部传进来的
// *models.ScanResult 调用方还持有引用,我们不能让他们看到我们写时
// 改到的字段;clone 一次之后外部再怎么改都不影响我们持有的 snapshot。
func (c *ScanResultCache) Set(r *models.ScanResult) {
	if r == nil {
		return
	}
	ver := c.version.Add(1)
	snap := &scanResultSnapshot{result: cloneScanResult(r), version: ver}
	c.latest.Store(snap)
	c.dirtyVer.Store(ver)
	c.scheduleFlush()
}

// Flush 强制立即落盘(用于服务关闭前等关键路径)。幂等:若内存已
// 干净则什么都不做。
func (c *ScanResultCache) Flush() error {
	return c.flush()
}

// LoadWithRoots 启动时加载磁盘缓存，并在缓存记录的多媒体根与 currentRoots
// 不一致时清空缓存（清空后调用方应主动触发一次扫描，避免前端拉到旧根下的
// 扫描结果）。
//
// 行为：
//   - 缓存文件不存在：与 Load 行为一致，直接返回 nil（无错）。
//   - 缓存文件存在但解析失败：返回错误（与 Load 行为一致）。
//   - currentRoots 为 nil 或空：拒绝加载，因为脱敏快照无法还原内部路径。
//   - 缓存里的根集合与 currentRoots 不一致：调用 Clear() 清空内存与磁盘，
//     并通过返回值 rootsMismatch=true 通知调用方需要重扫。
//   - 一致：按原样加载到内存。
//
// 当前根先按配置与扫描器共用的规则绝对化、去空、去重，再比较根 ID 集合。
// 重复根 ID 或目录树中的重复物理节点视为无效，不能恢复重复扫描产出的统计。
func (c *ScanResultCache) LoadWithRoots(currentRoots []string) (rootsMismatch bool, err error) {
	currentRoots = pathutil.NormalizeRoots(currentRoots)
	if len(currentRoots) == 0 {
		return false, errors.New("current media roots are required to load scan cache")
	}
	c.flushMu.Lock()
	defer c.flushMu.Unlock()
	data, err := os.ReadFile(c.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	envelope := &scanCacheEnvelope{}
	if err := json.Unmarshal(data, envelope); err != nil {
		return false, err
	}
	if envelope.SchemaVersion != scanCacheSchemaVersion || envelope.Result == nil {
		c.resetMemory()
		if err := isolateUnsupportedScanCache(c.path); err != nil {
			return true, err
		}
		return true, nil
	}
	currentRootIDs := make([]string, 0, len(currentRoots))
	for _, root := range currentRoots {
		abs, absErr := filepath.Abs(root)
		if absErr != nil {
			return false, absErr
		}
		currentRootIDs = append(currentRootIDs, rootIDFor(abs))
	}
	if !sameRootIDs(envelope.RootIDs, currentRootIDs) || hasRepeatedScanNodes(envelope.Result) {
		c.resetMemory()
		if err := removeCacheFile(c.path); err != nil {
			return true, err
		}
		return true, nil
	}
	result, err := decodeScanResultFromDisk(envelope.Result, currentRoots)
	if err != nil {
		return false, fmt.Errorf("decode scan cache: %w", err)
	}
	ver := c.version.Add(1)
	snap := &scanResultSnapshot{result: result, version: ver}
	c.latest.Store(snap)
	c.dirtyVer.Store(0) // 刚从磁盘加载,无需再落盘
	return false, nil
}

// scheduleFlush 启动 500ms 防抖 timer。多次调用会重置 timer。
func (c *ScanResultCache) scheduleFlush() {
	c.flushMu.Lock()
	defer c.flushMu.Unlock()
	if c.flushTimer != nil {
		c.flushTimer.Stop()
	}
	c.flushTimer = time.AfterFunc(flushDebounce, func() {
		if err := c.flush(); err != nil {
			fmt.Fprintf(os.Stderr, "scan_cache async flush: %v\n", err)
		}
	})
}

// flush 把内存中的最新结果写到磁盘(原子重命名)。dirtyVer 配合 latest.version
// 保证写盘期间到达的新 Set 不会被错误标记为已持久化:
//
//   - flush 开始时读 dirtyVer(目标版本),记下要写盘的是哪个版本
//   - flush 期间可能并发 Set 把 latest 推到更高版本,dirtyVer 也跟着 bump
//   - flush 写盘成功后,只在 dirtyVer 还等于目标版本时才清零;
//     否则保留 dirtyVer(让另一次 flush 来写新版本)
func (c *ScanResultCache) flush() error {
	c.flushMu.Lock()
	defer c.flushMu.Unlock()

	dirtyVer := c.dirtyVer.Load()
	if dirtyVer == 0 {
		return nil
	}
	snap := c.latest.Load()
	if snap == nil {
		// memory empty, reset dirty
		c.dirtyVer.Store(0)
		return nil
	}

	envelope, err := encodeScanResultForDisk(snap.result)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(envelope, "", "  ")
	if err != nil {
		return err
	}
	if err := writeScanCacheAtomic(c.path, data); err != nil {
		return err
	}
	// CAS 清 dirtyVer:只有 dirtyVer 还等于目标版本时才能清零。
	// 如果在 flush 期间又来了新 Set,bump 到新版本,dirtVer 不再等于
	// 目标值,CAS 失败,dirtyVer 保留(下一次 Set 触发的 flush 会写
	// 新版本)。
	c.dirtyVer.CompareAndSwap(dirtyVer, 0)
	return nil
}

// Clear 清空内存中的扫描结果并删除磁盘文件(媒体根目录变更后调用)。
// 后续首次加载/扫描会按新根重新填充。
func (c *ScanResultCache) Clear() error {
	c.flushMu.Lock()
	defer c.flushMu.Unlock()
	if c.flushTimer != nil {
		c.flushTimer.Stop()
		c.flushTimer = nil
	}
	c.latest.Store(nil)
	c.dirtyVer.Store(0)
	c.version.Add(1) // bump 让旧 in-flight flush 看见的 dirtyVer 失效
	return removeCacheFile(c.path)
}

// resetMemory 清空 in-memory state。**调用方必须已持有 flushMu**。
// 拆成 locked 版本避免 LoadWithRoots / Clear 在持锁时再调用死锁。
func (c *ScanResultCache) resetMemory() {
	if c.flushTimer != nil {
		c.flushTimer.Stop()
		c.flushTimer = nil
	}
	c.latest.Store(nil)
	c.dirtyVer.Store(0)
	c.version.Add(1)
}

func cloneScanResult(result *models.ScanResult) *models.ScanResult {
	if result == nil {
		return nil
	}
	out := *result
	out.Roots = append([]string(nil), result.Roots...)
	out.Warnings = append([]models.ScanWarning(nil), result.Warnings...)
	out.Albums = cloneAlbums(result.Albums)
	out.Collections = cloneCollections(result.Collections)
	out.SmartCollections = make([]models.SmartCollection, len(result.SmartCollections))
	for i := range result.SmartCollections {
		out.SmartCollections[i] = result.SmartCollections[i]
		out.SmartCollections[i].Tags = append([]string(nil), result.SmartCollections[i].Tags...)
		out.SmartCollections[i].Albums = cloneAlbums(result.SmartCollections[i].Albums)
	}
	return &out
}

func cloneAlbums(albums []models.Album) []models.Album {
	if albums == nil {
		return nil
	}
	out := make([]models.Album, len(albums))
	for i := range albums {
		out[i] = albums[i]
		out[i].ImageFiles = append([]string(nil), albums[i].ImageFiles...)
		out[i].VideoFiles = append([]string(nil), albums[i].VideoFiles...)
		out[i].Tags = append([]string(nil), albums[i].Tags...)
	}
	return out
}

func cloneCollections(collections []models.Collection) []models.Collection {
	if collections == nil {
		return nil
	}
	out := make([]models.Collection, len(collections))
	for i := range collections {
		out[i] = collections[i]
		out[i].Albums = cloneAlbums(collections[i].Albums)
		out[i].Collections = cloneCollections(collections[i].Collections)
	}
	return out
}

type scanCacheRoot struct {
	id   string
	path string
}

func encodeScanResultForDisk(result *models.ScanResult) (*scanCacheEnvelope, error) {
	if result == nil {
		return nil, errors.New("scan result is empty")
	}
	if hasRepeatedScanNodes(result) {
		return nil, errors.New("scan result repeats a physical node")
	}
	roots := append([]string(nil), result.Roots...)
	if len(roots) == 0 {
		return nil, errors.New("scan result has no roots")
	}
	rootIDs := make([]string, 0, len(roots))
	seenRootIDs := make(map[string]struct{}, len(roots))
	for _, root := range roots {
		abs, err := filepath.Abs(root)
		if err != nil {
			return nil, err
		}
		abs = filepath.Clean(abs)
		id := rootIDFor(abs)
		if _, exists := seenRootIDs[id]; exists {
			return nil, errors.New("scan result repeats a root")
		}
		seenRootIDs[id] = struct{}{}
		rootIDs = append(rootIDs, id)
	}
	// 当前 schema 直接存原始 result，不再做路径混淆。
	// 原始 result。绝对路径会出现在 cache.json 里 ——
	// 风险被两层降低:
	//   - cache.json 位于本地 cacheDir,默认 127.0.0.1 后端服务,无外网访问
	//   - 公共 API 响应走 catalog.ExternalID 转成 r_/a_/c_/f_ ID
	// 旧版 encode/decode 全套删除,见 transformScanResultPaths / etc.
	return &scanCacheEnvelope{
		SchemaVersion: scanCacheSchemaVersion,
		RootIDs:       rootIDs,
		Result:        cloneScanResult(result),
	}, nil
}

// decodeScanResultFromDisk 从磁盘加载的 envelope 还原 result。
//
// 当前 schema 的 result 已是 raw(绝对路径)，直接 clone 出来用。
// 绝对路径是否合法(还在当前 mediaRoots 下)由调用方校验:LoadWithRoots
// 已经在调用 decode 之前确认过 rootIDs 与 currentRoots 一致,所以这里
// 不再做路径校验。
func decodeScanResultFromDisk(result *models.ScanResult, _ []string) (*models.ScanResult, error) {
	if result == nil {
		return nil, errors.New("scan cache result is empty")
	}
	return cloneScanResult(result), nil
}

func writeScanCacheAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".scan-cache-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func removeCacheFile(path string) error {
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func isolateUnsupportedScanCache(path string) error {
	stamp := time.Now().Format("20060102150405") + "-" + fmt.Sprintf("%d", time.Now().UnixNano()%1_000_000)
	return os.Rename(path, path+".unsupported."+stamp)
}

// FindAlbum 按路径查找相册（递归 Collection）。
func (c *ScanResultCache) FindAlbum(path string) *models.Album {
	r := c.Get()
	if r == nil {
		return nil
	}
	for i := range r.Albums {
		if r.Albums[i].Path == path {
			a := r.Albums[i]
			return &a
		}
	}
	for i := range r.Collections {
		if a := findAlbumInCollection(&r.Collections[i], path); a != nil {
			return a
		}
	}
	for i := range r.SmartCollections {
		for j := range r.SmartCollections[i].Albums {
			if r.SmartCollections[i].Albums[j].Path == path {
				a := r.SmartCollections[i].Albums[j]
				return &a
			}
		}
	}
	return nil
}

// FindCollection 按路径查找集合（递归嵌套 Collection）。
//
// 扫描器会按目录层级产出嵌套集合（Collection.Collections），所以顶层之外的
// 集合（"2024年/夏威夷-度假"、"2024年/夏威夷-度假/相片"）也必须能找到。
// 旧版只在顶层 r.Collections 里线性查找，导致点击首页 401 个文件夹中的
// 任何深层集合都返回 404 —— 反馈「文件夹里面的子文件夹无法正常加载」。
func (c *ScanResultCache) FindCollection(path string) *models.Collection {
	r := c.Get()
	if r == nil {
		return nil
	}
	for i := range r.Collections {
		if found := findCollectionRecursive(&r.Collections[i], path); found != nil {
			return found
		}
	}
	return nil
}

// findCollectionRecursive 在 col 及其嵌套子集合中查找 path。
// 命中时返回深拷贝（避免外部修改内部状态）。
func findCollectionRecursive(col *models.Collection, path string) *models.Collection {
	if col.Path == path {
		c := *col
		return &c
	}
	for i := range col.Collections {
		if found := findCollectionRecursive(&col.Collections[i], path); found != nil {
			return found
		}
	}
	return nil
}

// FindSmartCollection 按标签名查找智能集合。
func (c *ScanResultCache) FindSmartCollection(tag string) *models.SmartCollection {
	r := c.Get()
	if r == nil {
		return nil
	}
	for i := range r.SmartCollections {
		s := r.SmartCollections[i]
		if s.Tag == tag {
			return &s
		}
	}
	return nil
}

// findAlbumInCollection 在 col 及其嵌套子集合中递归查找相册。
//
// 旧实现只在 col.Albums 顶层线性查找，遇到嵌套 Collection（"2024年/
// 夏威夷-度假/相片/作品" 这种 4 层结构）就找不到，导致 FindAlbum 拿不到
// 深层相册。扫描器现在支持 Collection 嵌套（详见 scanner.go），这里
// 也必须跟着递归。
func findAlbumInCollection(col *models.Collection, path string) *models.Album {
	for i := range col.Albums {
		if col.Albums[i].Path == path {
			a := col.Albums[i]
			return &a
		}
	}
	for i := range col.Collections {
		if a := findAlbumInCollection(&col.Collections[i], path); a != nil {
			return a
		}
	}
	return nil
}

// sameRootIDs 比较不透明根 ID 集合；重复 ID 表示无效的缓存或调用输入。
func sameRootIDs(cached, current []string) bool {
	if len(cached) != len(current) {
		return false
	}
	set := make(map[string]struct{}, len(cached))
	for _, id := range cached {
		if _, exists := set[id]; exists {
			return false
		}
		set[id] = struct{}{}
	}
	for _, id := range current {
		if _, exists := set[id]; !exists {
			return false
		}
		delete(set, id)
	}
	return true
}

// 只校验实体目录树；同一物理目录的虚拟相册/集合属于不同 kind，标签视图可重复引用相册。
func hasRepeatedScanNodes(result *models.ScanResult) bool {
	seen := make(map[string]struct{})
	add := func(path string, kind ResourceKind) bool {
		if path == "" {
			return false
		}
		key := pathKindKey(path, kind)
		if _, exists := seen[key]; exists {
			return true
		}
		seen[key] = struct{}{}
		return false
	}
	var collectionsRepeat func([]models.Collection) bool
	collectionsRepeat = func(collections []models.Collection) bool {
		for _, collection := range collections {
			if add(collection.Path, ResourceCollection) {
				return true
			}
			for _, album := range collection.Albums {
				if add(album.Path, ResourceAlbum) {
					return true
				}
			}
			if collectionsRepeat(collection.Collections) {
				return true
			}
		}
		return false
	}
	for _, album := range result.Albums {
		if add(album.Path, ResourceAlbum) {
			return true
		}
	}
	return collectionsRepeat(result.Collections)
}

// ApplyCoverOverrides 把用户设置的封面覆盖应用到当前缓存结果上。
//
// 处理流程：
//  1. 遍历 ScanResult.Albums 和嵌套 Collection.Albums
//  2. 对每条 cover override：确认 coverFile 仍在对应 album 目录里（防
//     越权 + 防止文件已被删/移走），否则静默跳过
//  3. 替换 CoverImage + CoverKind（按文件扩展名推断 image/video）
//
// 关键改动:stat / 扩展名检查全在锁外完成,只把"修改结果 + CAS 替换"
// 放进临界区。5000+ 收藏冷启动从"全路径锁持有时间 = 总 stat 时间"
// 降到"临界区只有 clone + CAS",stat 自身可与并发 Set 交错。
func (c *ScanResultCache) ApplyCoverOverrides(overrides map[string]CoverOverride) int {
	if len(overrides) == 0 {
		return 0
	}
	caseInsensitive := runtime.GOOS == "windows"

	for {
		old := c.latest.Load()
		if old == nil {
			return 0
		}

		// 第一遍:对当前快照收集"待修改项",做 stat + 扩展名校验(全在锁外)
		type mod struct {
			file string
			kind string
		}
		mods := make(map[string]mod)
		collect := func(albums []models.Album) {
			for i := range albums {
				ov, ok := overrides[filepath.Clean(albums[i].Path)]
				if !ok {
					continue
				}
				if coverKindFromExt(ov.File) == "" {
					continue
				}
				if !fileInsideDir(ov.File, albums[i].Path, caseInsensitive) {
					// cover 文件不在 album 内（被移走/删除/越权），静默跳过
					continue
				}
				mods[albums[i].Path] = mod{file: ov.File, kind: coverKindFromExt(ov.File)}
			}
		}
		collect(old.result.Albums)
		var walkColl func(cols []models.Collection)
		walkColl = func(cols []models.Collection) {
			for i := range cols {
				collect(cols[i].Albums)
				walkColl(cols[i].Collections)
			}
		}
		walkColl(old.result.Collections)

		if len(mods) == 0 {
			return 0
		}

		// 第二遍:基于旧快照 clone 出一份新的,把 mods 应用上去
		next := cloneScanResult(old.result)
		apply := func(albums []models.Album) {
			for i := range albums {
				m, ok := mods[albums[i].Path]
				if !ok {
					continue
				}
				albums[i].CoverImage = m.file
				albums[i].CoverKind = m.kind
			}
		}
		apply(next.Albums)
		var applyColl func(cols []models.Collection)
		applyColl = func(cols []models.Collection) {
			for i := range cols {
				apply(cols[i].Albums)
				applyColl(cols[i].Collections)
			}
		}
		applyColl(next.Collections)

		// CAS 替换:并发 Set 期间可能失败,失败重试(重做 stat + apply)
		ver := c.version.Add(1)
		newSnap := &scanResultSnapshot{result: next, version: ver}
		if c.latest.CompareAndSwap(old, newSnap) {
			c.dirtyVer.Store(ver)
			c.scheduleFlush()
			return len(mods)
		}
		// CAS 失败:并发 Set 推到了更新的 snapshot,基于更新的
		// 快照重新计算 mods,再 CAS 一次。理论上重试一次就够。
	}
}

// fileInsideDir 检查 file 路径是否在 dir 目录内（file 的父目录 = dir，
// 或 file 父目录以 dir 为前缀）。用于验证 cover override 没越权。
func fileInsideDir(file, dir string, caseInsensitive bool) bool {
	fp := filepath.Clean(file)
	dp := filepath.Clean(dir)
	if caseInsensitive {
		fp = strings.ToLower(fp)
		dp = strings.ToLower(dp)
	}
	if fp == dp {
		return false // 文件不能等于目录
	}
	rel, err := filepath.Rel(dp, fp)
	if err != nil {
		return false
	}
	if rel == "." || rel == ".." {
		return false
	}
	if strings.HasPrefix(rel, "..") {
		return false
	}
	return true
}

// coverKindFromExt 按文件扩展名推断 "image" / "video"。
func coverKindFromExt(p string) string {
	ext := strings.ToLower(filepath.Ext(p))
	switch ext {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif", ".avif":
		return "image"
	case ".mp4", ".webm", ".mov", ".mkv", ".avi":
		return "video"
	}
	return ""
}

// SetWithOverrideApplied 把用户设置的 cover 立即应用到缓存结果中的
// 对应 album(在顶层 albums 与嵌套 collections 内都找),并标记 dirty
// 让异步 flush 落盘 scan_cache.json。找不到匹配的 album 时静默成功
// (下一次扫描器跑或加载时 ApplyCoverOverrides 会按 store 重新填上)。
//
// 走 CAS 重试路径:在旧快照上 clone 出新快照,改对应 album,原子替换。
func (c *ScanResultCache) SetWithOverrideApplied(albumPath, coverFile, coverKind string) {
	albumPath = filepath.Clean(albumPath)
	caseInsensitive := runtime.GOOS == "windows"
	for {
		old := c.latest.Load()
		if old == nil {
			return
		}
		next := cloneScanResult(old.result)
		var walkAlbums func(a *models.Album) bool
		walkAlbums = func(a *models.Album) bool {
			ap := filepath.Clean(a.Path)
			if caseInsensitive {
				if strings.EqualFold(ap, albumPath) {
					a.CoverImage = coverFile
					a.CoverKind = coverKind
					return true
				}
			} else if ap == albumPath {
				a.CoverImage = coverFile
				a.CoverKind = coverKind
				return true
			}
			return false
		}
		hit := false
		for i := range next.Albums {
			if walkAlbums(&next.Albums[i]) {
				hit = true
				break
			}
		}
		if !hit {
			var walk func(cs []models.Collection) bool
			walk = func(cs []models.Collection) bool {
				for i := range cs {
					for j := range cs[i].Albums {
						if walkAlbums(&cs[i].Albums[j]) {
							return true
						}
					}
					if len(cs[i].Collections) > 0 && walk(cs[i].Collections) {
						return true
					}
				}
				return false
			}
			hit = walk(next.Collections)
		}
		if !hit {
			return
		}
		ver := c.version.Add(1)
		newSnap := &scanResultSnapshot{result: next, version: ver}
		if c.latest.CompareAndSwap(old, newSnap) {
			c.dirtyVer.Store(ver)
			c.scheduleFlush()
			return
		}
	}
}

// RebuildCoverForAlbum 清除 override 后让该 album 的封面回到扫描器默认：
// 图片优先 → images[0]，否则 videos[0]。
//
// 找不到该 album 路径时静默成功(同 SetWithOverrideApplied)。
// 走 CAS 重试路径。
func (c *ScanResultCache) RebuildCoverForAlbum(albumPath string) {
	albumPath = filepath.Clean(albumPath)
	caseInsensitive := runtime.GOOS == "windows"
	for {
		old := c.latest.Load()
		if old == nil {
			return
		}
		next := cloneScanResult(old.result)
		var rebuild func(a *models.Album) bool
		rebuild = func(a *models.Album) bool {
			ap := filepath.Clean(a.Path)
			match := ap == albumPath
			if !match && caseInsensitive {
				match = strings.EqualFold(ap, albumPath)
			}
			if !match {
				return false
			}
			if len(a.ImageFiles) > 0 {
				a.CoverImage = a.ImageFiles[0]
				a.CoverKind = "image"
			} else if len(a.VideoFiles) > 0 {
				a.CoverImage = a.VideoFiles[0]
				a.CoverKind = "video"
			} else {
				a.CoverImage = ""
				a.CoverKind = ""
			}
			return true
		}
		hit := false
		for i := range next.Albums {
			if rebuild(&next.Albums[i]) {
				hit = true
				break
			}
		}
		if !hit {
			var walk func(cs []models.Collection) bool
			walk = func(cs []models.Collection) bool {
				for i := range cs {
					for j := range cs[i].Albums {
						if rebuild(&cs[i].Albums[j]) {
							return true
						}
					}
					if len(cs[i].Collections) > 0 && walk(cs[i].Collections) {
						return true
					}
				}
				return false
			}
			hit = walk(next.Collections)
		}
		if !hit {
			return
		}
		ver := c.version.Add(1)
		newSnap := &scanResultSnapshot{result: next, version: ver}
		if c.latest.CompareAndSwap(old, newSnap) {
			c.dirtyVer.Store(ver)
			c.scheduleFlush()
			return
		}
	}
}
