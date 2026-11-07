// Package services 提供本地画廊核心业务服务。
package services

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/pathutil"
)

// ScanOptions 扫描选项。
type ScanOptions struct {
	Roots    []string // 多媒体根目录
	MaxDepth int      // 可选显式上限；0 或负数表示完整递归
	// Exclude 扫描排除规则（详见 ExcludeConfig）。nil 时走 DefaultExclude()
	// 兜底,等价于「跳隐藏 + 跳系统文件」的内置默认。
	//
	// 设计:把规则放在 ScanOptions 而不是构造函数里,让同进程多次扫描能
	// 用不同规则(handler 每次都用最新 config 构造);同时测试也可以
	// 方便地构造空规则 / 严格规则的 ScanOptions。
	Exclude ExcludeConfig
}

// effectiveRoots 返回本轮要扫描的根列表（去重、保序、规范化）。
func (o ScanOptions) effectiveRoots() []string {
	return pathutil.NormalizeRoots(o.Roots)
}

// ScanProgress 扫描进度回调参数。
//
// 由 Scanner 在扫描过程中多次调用，提供给 AsyncScanRunner 转换为 SSE 事件。
type ScanProgress struct {
	Phase       string         // "scanning" / "smart-grouping"
	CurrentPath string         // 当前处理的目录/文件
	Processed   int            // 当前根已读取的目录数
	Total       int            // 当前根已发现的目录数，读取过程中会增长
	RootIndex   int            // 当前根的 0-based 下标
	RootCount   int            // 本轮去重后的根目录总数
	AlbumsFound int            // 累计发现的相册数
	NewAlbums   []models.Album // 本轮新发现的相册
}

// ScanHook 进度回调函数。
type ScanHook func(p ScanProgress)

// ScanErrorKind 扫描过程中可恢复的错误类型。
type ScanErrorKind int

const (
	ScanOK ScanErrorKind = iota
	ScanRootMissing
	ScanRootNotDir
	ScanRootUnreadable
	ScanRootChanged
)

func (k ScanErrorKind) String() string {
	switch k {
	case ScanRootMissing:
		return "root missing"
	case ScanRootNotDir:
		return "root is not a directory"
	case ScanRootUnreadable:
		return "root is unreadable"
	case ScanRootChanged:
		return "root changed"
	default:
		return "ok"
	}
}

// ScanError 扫描失败描述。
type ScanError struct {
	Kind ScanErrorKind
	Path string
	Err  error
}

func (e *ScanError) Error() string {
	return e.Kind.String() + ": " + e.Path + ": " + e.Err.Error()
}

func (e *ScanError) Unwrap() error { return e.Err }

// Scanner 使用单个固定工作池读取目录；目录树在读取完成后再构建。
// worker 不递归等待子任务，因此并发数与目录深度无关，也不会出现父任务
// 占满信号量后等待子任务的死锁。
type Scanner struct {
	workers  int
	ctx      context.Context
	rootKeys map[string]struct{} // 本轮配置根；父根不重复读取单独配置的子根
}

// NewScanner 创建扫描器。
func NewScanner() *Scanner {
	n := min(8, runtime.NumCPU())
	return &Scanner{
		workers: n,
		ctx:     context.Background(),
	}
}

// Scan 执行同步扫描。返回完整结果树。
func (s *Scanner) Scan(opts ScanOptions) (*models.ScanResult, error) {
	return s.ScanWithHook(opts, nil)
}

// ScanWithContext 执行可取消扫描；取消后不再继续读取新目录。
func (s *Scanner) ScanWithContext(ctx context.Context, opts ScanOptions, hook ScanHook) (*models.ScanResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	scoped := *s
	scoped.ctx = ctx
	return scoped.ScanWithHook(opts, hook)
}

// ScanWithHook 与 Scan 相同，但额外接受一个进度回调。
// hook 可以为 nil，此时等同于 Scan。
//
// 多根扫描：opts.Roots 非空时按顺序扫描每个根，合并所有顶层 Albums /
// Collections，并给每个 Album/Collection 填充 SourceRoot/SourceName 字段。
// 跨根同名时，DisplayName 会加 "[SourceName] " 前缀避免歧义。
func (s *Scanner) ScanWithHook(opts ScanOptions, hook ScanHook) (*models.ScanResult, error) {
	roots, err := prepareScanRoots(opts)
	if err != nil {
		return nil, err
	}
	return s.scanRoots(opts, roots, hook)
}

func (s *Scanner) scanRoots(opts ScanOptions, roots []scanRoot, hook ScanHook) (*models.ScanResult, error) {
	start := time.Now()
	absRoots := scanRootPaths(roots)
	scoped := *s
	scoped.rootKeys = make(map[string]struct{}, len(roots))
	for _, root := range roots {
		scoped.rootKeys[pathutil.RootKey(root.path)] = struct{}{}
	}

	var allTopAlbums []models.Album
	var allTopCollections []models.Collection
	var allWarnings []models.ScanWarning

	// 每个根的目录总数动态发现，相册数量则累计整轮扫描，不能在换根时回退。
	completedAlbums := 0
	for rootIndex, root := range roots {
		if err := s.contextErr(); err != nil {
			return nil, err
		}
		if err := root.validate(); err != nil {
			return nil, err
		}
		absRoot := root.path
		rootAlbums := 0
		var rootHook ScanHook
		if hook != nil {
			rootHook = func(event ScanProgress) {
				rootAlbums = event.AlbumsFound
				event.AlbumsFound += completedAlbums
				event.RootIndex = rootIndex
				event.RootCount = len(absRoots)
				hook(event)
			}
		}
		records, warnings, err := scoped.scanDirectoryTree(root, opts.MaxDepth, opts.Exclude, rootHook)
		if err != nil {
			return nil, err
		}
		completedAlbums += rootAlbums
		if err := s.contextErr(); err != nil {
			return nil, err
		}
		if err := root.validate(); err != nil {
			return nil, err
		}
		topAlbums, topCollections := buildRootResult(absRoot, records)
		allWarnings = append(allWarnings, warnings...)

		// 给所有产生的 album/collection 打 source 标签
		srcName := filepath.Base(absRoot)
		stampAlbumSource(&topAlbums, absRoot, srcName)
		stampCollectionSource(&topCollections, absRoot, srcName)

		allTopAlbums = append(allTopAlbums, topAlbums...)
		allTopCollections = append(allTopCollections, topCollections...)
	}

	if err := s.contextErr(); err != nil {
		return nil, err
	}
	// 跨根同名冲突：给 DisplayName 加 [SourceName] 前缀
	applyNamePrefixIfConflict(&allTopAlbums)
	applyCollectionNamePrefixIfConflict(&allTopCollections)

	allAlbums := flattenAlbums(allTopAlbums, allTopCollections)
	if hook != nil {
		hook(ScanProgress{
			Phase:       "smart-grouping",
			RootIndex:   len(absRoots) - 1,
			RootCount:   len(absRoots),
			AlbumsFound: len(allAlbums),
		})
	}
	smart := GroupByTag(allAlbums)
	if err := s.contextErr(); err != nil {
		return nil, err
	}
	if err := validateScanRoots(roots); err != nil {
		return nil, err
	}

	rootsForResult := make([]string, len(absRoots))
	copy(rootsForResult, absRoots)

	result := &models.ScanResult{
		Roots:            rootsForResult,
		Albums:           allTopAlbums,
		Collections:      allTopCollections,
		SmartCollections: smart,
		AlbumCount:       len(allAlbums),
		CollectionCount:  countCollections(allTopCollections),
		Duration:         time.Since(start).Milliseconds(),
		ScannedAt:        time.Now(),
		Warnings:         allWarnings,
	}
	return result, nil
}

// stampAlbumSource 给 album 列表（含嵌套 collection 内）打 SourceRoot / SourceName
// 并把空 DisplayName 填上 Name（基础值，后续冲突检测可能再覆盖）。
//
// 虚拟相册（“本目录媒体”）额外填 Location：相对所属媒体根的目录路径。
// 所有虚拟相册的 Name 恒为“本目录媒体”，扁平列表里必须靠 Location 区分归属。
func stampAlbumSource(albums *[]models.Album, srcRoot, srcName string) {
	for i := range *albums {
		(*albums)[i].SourceRoot = srcRoot
		(*albums)[i].SourceName = srcName
		if (*albums)[i].DisplayName == "" {
			(*albums)[i].DisplayName = (*albums)[i].Name
		}
		if (*albums)[i].Virtual {
			(*albums)[i].Location = albumLocation(srcRoot, (*albums)[i].Path)
			// 展示名跟着归属目录走：Name 只是"本目录媒体"这个类型常量，
			// DisplayName 才是各端真正显示的标题（阅读器标题、属性弹窗、
			// 搜索结果都读它）。
			if (*albums)[i].Location != "" {
				(*albums)[i].DisplayName = (*albums)[i].Location
			}
		}
	}
}

// albumLocation 计算相册归属目录相对媒体根的展示路径（斜杠分隔）。
//
// - 位于媒体根自身（根目录里的散图）→ 用根目录名，如 "存照"；
// - 位于子目录 → 相对路径，如 "2011年/10.1一号公馆"；
// - 路径越界或无法计算 → 退化为目录 basename。
//
// 相对路径而不是 basename：不同父目录下可能有同名目录（两个 "2020年"），
// 只有完整相对路径能唯一标识。
func albumLocation(srcRoot, albumPath string) string {
	if albumPath == "" {
		return ""
	}
	cleanRoot := filepath.Clean(srcRoot)
	cleanAlbum := filepath.Clean(albumPath)
	rel, err := filepath.Rel(cleanRoot, cleanAlbum)
	if err != nil || rel == "." || relEscapesRoot(rel) {
		return filepath.Base(cleanAlbum)
	}
	return filepath.ToSlash(rel)
}

func stampCollectionSource(collections *[]models.Collection, srcRoot, srcName string) {
	for i := range *collections {
		(*collections)[i].SourceRoot = srcRoot
		(*collections)[i].SourceName = srcName
		if (*collections)[i].DisplayName == "" {
			(*collections)[i].DisplayName = (*collections)[i].Name
		}
		// 递归到全部后代，确保深层节点的来源和展示名一致。
		stampAlbumSource(&(*collections)[i].Albums, srcRoot, srcName)
		stampCollectionSource(&(*collections)[i].Collections, srcRoot, srcName)
	}
}

// applyNamePrefixIfConflict 对所有 album 检测同名冲突，冲突的加来源前缀。
// 只在顶层 + collection 内部 album 中各检测一次；不同根的同名 album 会
// 被识别为冲突。
func applyNamePrefixIfConflict(albums *[]models.Album) {
	// 第一遍：统计展示名基础出现次数
	counts := make(map[string]int)
	for _, a := range *albums {
		counts[albumDisplayBase(a)]++
	}
	for i := range *albums {
		base := albumDisplayBase((*albums)[i])
		if counts[base] > 1 && (*albums)[i].SourceName != "" {
			(*albums)[i].DisplayName = "[" + (*albums)[i].SourceName + "] " + base
		}
	}
}

// albumDisplayBase 是相册展示名的基础：虚拟相册用归属目录，普通相册用目录名。
//
// 虚拟相册的 Name 恒为“本目录媒体”，拿它做冲突统计会把所有散图算成同名；
// 用归属目录统计才能发现"两个根下都有 2020年"这种真冲突。
func albumDisplayBase(a models.Album) string {
	if a.Virtual && a.Location != "" {
		return a.Location
	}
	return a.Name
}

// applyCollectionNamePrefixIfConflict 对所有 collection（含嵌套的子 albums）
// 做同名冲突检测。冲突的 collection 改名；其内部子 album 由于名字继承关系
// 不会被全局计数重复（不同根的同名 collection 才会撞）。
func applyCollectionNamePrefixIfConflict(collections *[]models.Collection) {
	// 顶层冲突
	counts := make(map[string]int)
	for _, c := range *collections {
		counts[c.Name]++
	}
	for i := range *collections {
		if counts[(*collections)[i].Name] > 1 && (*collections)[i].SourceName != "" {
			(*collections)[i].DisplayName = "[" + (*collections)[i].SourceName + "] " + (*collections)[i].Name
		}
		// 子 album 在 stampAlbumSource 已经按所在 collection 的源打了 source
		// 但跨根同名时，stampAlbumSource 不会重新命名，需要做冲突检测
		// 不过子 album 的路径在所在 collection 之下，不会跨根冲突
		// 所以此处不处理子 album
	}
}

// fileEntry 在枚举目录时缓存大小和修改时间，构建相册时不再逐文件 Stat。
type fileEntry struct {
	path    string
	size    int64
	modTime time.Time
	// captured 是从文件名推断的拍摄时间；推不出来时是零值。
	// 它不读 EXIF：逐个文件读 EXIF 会把扫描拖成随机 I/O。
	captured time.Time
}

type directoryTask struct {
	path  string
	depth int
}

type directoryRecord struct {
	path     string
	images   []fileEntry
	videos   []fileEntry
	children []string
}

type directoryScanResult struct {
	record   directoryRecord
	children []directoryTask
	warnings []models.ScanWarning
	err      error
}

// scanDirectoryTree 用一个固定工作池读取整棵目录树。协调器是唯一会向
// jobs 写入的协程，worker 永远不等待自己派生的子任务，因而不会死锁。
func (s *Scanner) scanDirectoryTree(
	root scanRoot,
	maxDepth int,
	exclude ExcludeConfig,
	hook ScanHook,
) (map[string]directoryRecord, []models.ScanWarning, error) {
	ctx, cancel := context.WithCancel(s.ctx)
	scoped := *s
	scoped.ctx = ctx
	workerCount := max(1, s.workers)
	jobs := make(chan directoryTask)
	results := make(chan directoryScanResult, workerCount)
	var wg sync.WaitGroup
	defer func() {
		cancel()
		close(jobs)
		wg.Wait()
	}()
	for range workerCount {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for task := range jobs {
				result := scoped.inspectDirectory(root, task, maxDepth, exclude)
				select {
				case results <- result:
				case <-ctx.Done():
					return
				}
			}
		}()
	}

	queue := []directoryTask{{path: root.path}}
	records := make(map[string]directoryRecord)
	var warnings []models.ScanWarning
	active := 0
	processed := 0
	albumsFound := 0

	for len(queue) > 0 || active > 0 {
		var send chan directoryTask
		var next directoryTask
		if len(queue) > 0 {
			send = jobs
			next = queue[0]
		}
		select {
		case send <- next:
			queue = queue[1:]
			active++
		case result := <-results:
			active--
			if result.err != nil {
				return nil, nil, result.err
			}
			processed++
			records[result.record.path] = result.record
			warnings = append(warnings, result.warnings...)
			queue = append(queue, result.children...)
			if len(result.record.images)+len(result.record.videos) > 0 {
				albumsFound++
			}
			if hook != nil {
				hook(ScanProgress{
					Phase:       "scanning",
					CurrentPath: result.record.path,
					Processed:   processed,
					Total:       processed + active + len(queue),
					AlbumsFound: albumsFound,
				})
			}
		case <-ctx.Done():
			return nil, nil, ctx.Err()
		}
	}
	return records, warnings, nil
}

func (s *Scanner) inspectDirectory(
	root scanRoot,
	task directoryTask,
	maxDepth int,
	exclude ExcludeConfig,
) directoryScanResult {
	result := directoryScanResult{record: directoryRecord{path: task.path}}
	entries, err := os.ReadDir(task.path)
	if err != nil {
		if rootErr := root.validate(); rootErr != nil {
			result.err = rootErr
			return result
		}
		if task.depth == 0 {
			result.err = scanRootReadError(root.path, err)
			return result
		}
		result.warnings = append(result.warnings, models.ScanWarning{
			Code: "directory_unreadable", Path: scanWarningPath(root.path, task.path), Message: "目录无法读取，已跳过",
		})
		return result
	}

	depthLimited := maxDepth > 0 && task.depth >= maxDepth
	for _, entry := range entries {
		if s.contextErr() != nil {
			break
		}
		entryPath := filepath.Join(task.path, entry.Name())
		if _, delegated := s.rootKeys[pathutil.RootKey(entryPath)]; delegated {
			continue
		}
		if entry.Type()&(os.ModeSymlink|os.ModeIrregular) != 0 {
			result.warnings = append(result.warnings, models.ScanWarning{
				Code: "symlink_skipped", Path: scanWarningPath(root.path, entryPath), Message: "链接默认不跟随",
			})
			continue
		}
		if entry.IsDir() {
			if exclude.ShouldSkipDir(entry.Name()) {
				continue
			}
			if depthLimited {
				result.warnings = append(result.warnings, models.ScanWarning{
					Code: "max_depth_reached", Path: scanWarningPath(root.path, task.path), Message: "已达到显式扫描深度上限",
				})
				continue
			}
			result.record.children = append(result.record.children, entryPath)
			result.children = append(result.children, directoryTask{path: entryPath, depth: task.depth + 1})
			continue
		}
		if exclude.ShouldSkipFile(entry.Name()) {
			continue
		}
		kind := ""
		switch {
		case models.IsImageFile(entry.Name()):
			kind = "image"
		case models.IsVideoFile(entry.Name()):
			kind = "video"
		default:
			continue
		}
		fullPath := entryPath
		size := int64(0)
		modTime := time.Time{}
		if info, infoErr := entry.Info(); infoErr == nil {
			size = info.Size()
			modTime = info.ModTime()
		} else {
			result.warnings = append(result.warnings, models.ScanWarning{
				Code: "metadata_unavailable", Path: scanWarningPath(root.path, fullPath), Message: "无法读取媒体元数据",
			})
		}
		file := fileEntry{
			path:     fullPath,
			size:     size,
			modTime:  modTime,
			captured: captureFromFileName(entry.Name()),
		}
		if kind == "image" {
			result.record.images = append(result.record.images, file)
		} else {
			result.record.videos = append(result.record.videos, file)
		}
	}
	sort.Slice(result.record.children, func(i, j int) bool {
		return naturalLess(filepath.Base(result.record.children[i]), filepath.Base(result.record.children[j]))
	})
	sort.Slice(result.children, func(i, j int) bool {
		return naturalLess(filepath.Base(result.children[i].path), filepath.Base(result.children[j].path))
	})
	return result
}

func buildRootResult(root string, records map[string]directoryRecord) ([]models.Album, []models.Collection) {
	record, ok := records[root]
	if !ok {
		return nil, nil
	}
	var albums []models.Album
	var collections []models.Collection
	for _, child := range record.children {
		album, collection := buildDirectoryResult(child, records)
		if album != nil {
			albums = append(albums, *album)
		}
		if collection != nil {
			collections = append(collections, *collection)
		}
	}
	if len(record.images)+len(record.videos) > 0 {
		album := buildAlbum(root, record.images, record.videos)
		if len(albums)+len(collections) > 0 {
			album.Name = models.VirtualAlbumName
			album.DisplayName = album.Name
			album.Virtual = true
		}
		albums = append([]models.Album{*album}, albums...)
	}
	sortLibraryNodes(albums, collections)
	return albums, collections
}

func buildDirectoryResult(path string, records map[string]directoryRecord) (*models.Album, *models.Collection) {
	record, ok := records[path]
	if !ok {
		return nil, nil
	}
	var childAlbums []models.Album
	var childCollections []models.Collection
	for _, child := range record.children {
		album, collection := buildDirectoryResult(child, records)
		if album != nil {
			childAlbums = append(childAlbums, *album)
		}
		if collection != nil {
			childCollections = append(childCollections, *collection)
		}
	}
	hasFiles := len(record.images)+len(record.videos) > 0
	hasChildren := len(childAlbums)+len(childCollections) > 0
	if hasFiles && !hasChildren {
		return buildAlbum(path, record.images, record.videos), nil
	}
	if !hasFiles && !hasChildren {
		return nil, nil
	}
	if hasFiles {
		loose := buildAlbum(path, record.images, record.videos)
		loose.Name = models.VirtualAlbumName
		loose.DisplayName = loose.Name
		loose.Virtual = true
		childAlbums = append([]models.Album{*loose}, childAlbums...)
	}
	sortLibraryNodes(childAlbums, childCollections)
	collection := &models.Collection{
		Type:        "collection",
		Path:        path,
		Name:        filepath.Base(path),
		DisplayName: filepath.Base(path),
		Albums:      childAlbums,
		Collections: childCollections,
		AlbumCount:  descendantAlbumCount(childAlbums, childCollections),
	}
	applyCollectionDate(collection, path)
	return nil, collection
}

// applyCollectionDate 给集合补上时间：目录的修改时间，以及后代相册
// 拍摄时间的代表值（按媒体数加权取众数）。
//
// 集合本身不是「拍于某天」的东西，但排序、「最近更新」与时间线都需要
// 它有时间 —— 早先集合不带任何时间戳，按时间排序时它们会永远排在最后。
func applyCollectionDate(collection *models.Collection, path string) {
	if fi, err := os.Stat(path); err == nil {
		collection.ModTime = fi.ModTime()
	}
	if date, ok := collectionCaptureDate(collection.Albums, collection.Collections); ok {
		collection.Date = date
		collection.DateSource = "filename"
		return
	}
	if folderDate, ok := strictDateFromPath(path); ok {
		collection.Date = folderDate
		collection.DateSource = "folder"
		return
	}
	collection.Date = collection.ModTime
	collection.DateSource = "modified"
}

// collectionCaptureDate 汇总后代相册的拍摄时间。
//
// 按媒体数加权：一本 1200 张的相册比一本 3 张的更能代表这个集合的
// 年代。众数并列时取较早的一天。
func collectionCaptureDate(albums []models.Album, collections []models.Collection) (time.Time, bool) {
	counts := make(map[string]int)
	collect := func(list []models.Album) {
		for _, album := range list {
			if album.DateSource != "filename" || album.Date.IsZero() {
				continue
			}
			weight := album.ImageCount + album.VideoCount
			if weight <= 0 {
				weight = 1
			}
			counts[album.Date.Format("20060102")] += weight
		}
	}
	collect(albums)
	for _, child := range collections {
		collect(child.Albums)
	}
	if len(counts) == 0 {
		return time.Time{}, false
	}
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	best := keys[0]
	for _, key := range keys[1:] {
		if counts[key] > counts[best] {
			best = key
		}
	}
	stamp, err := time.ParseInLocation("20060102", best, time.UTC)
	if err != nil {
		return time.Time{}, false
	}
	return stamp, true
}

func sortLibraryNodes(albums []models.Album, collections []models.Collection) {
	sort.SliceStable(albums, func(i, j int) bool {
		if albums[i].Virtual != albums[j].Virtual {
			return albums[i].Virtual
		}
		return naturalLess(albums[i].Name, albums[j].Name)
	})
	sort.SliceStable(collections, func(i, j int) bool {
		return naturalLess(collections[i].Name, collections[j].Name)
	})
}

func descendantAlbumCount(albums []models.Album, collections []models.Collection) int {
	count := len(albums)
	for i := range collections {
		count += collections[i].AlbumCount
	}
	return count
}

func scanWarningPath(root, path string) string {
	rootName := filepath.Base(root)
	relative, err := filepath.Rel(root, path)
	if err != nil || relEscapesRoot(relative) || relative == "." {
		return rootName
	}
	return rootName + "/" + filepath.ToSlash(relative)
}

func (s *Scanner) contextErr() error {
	if s == nil || s.ctx == nil {
		return nil
	}
	return s.ctx.Err()
}

// buildAlbum 把「图片+视频」组装成一个 Album（不含任何子目录逻辑）。
//
// images/videos 的 size 由 classifyAndScan 在收集时通过 DirEntry.Info()
// 拿到,这里直接累加,不再 N+1 stat。N+1 在 1k+ 张图的相册上是几百毫秒
// 级别的浪费(每张 stat 一次),改完后整本相册只多一次 dir stat 拿 modTime。
func buildAlbum(dir string, images, videos []fileEntry) *models.Album {
	imagePaths := make([]string, len(images))
	var totalSize int64
	for i, e := range images {
		imagePaths[i] = e.path
		totalSize += e.size
	}
	videoPaths := make([]string, len(videos))
	for i, e := range videos {
		videoPaths[i] = e.path
		totalSize += e.size
	}
	sort.SliceStable(imagePaths, func(i, j int) bool {
		return naturalLess(filepath.Base(imagePaths[i]), filepath.Base(imagePaths[j]))
	})
	sort.SliceStable(videoPaths, func(i, j int) bool {
		return naturalLess(filepath.Base(videoPaths[i]), filepath.Base(videoPaths[j]))
	})
	modTime := time.Time{}
	if fi, err := os.Stat(dir); err == nil {
		modTime = fi.ModTime()
	}
	allFiles := make([]fileEntry, 0, len(images)+len(videos))
	allFiles = append(allFiles, images...)
	allFiles = append(allFiles, videos...)
	// 文件名里推断出的拍摄日期：这本相册出现过的所有日期，以及其中
	// 最有代表性的一天（按媒体数加权取众数）。
	captureDates, captureDate := aggregateCaptureDates(allFiles)
	date, dateSource := resolveAlbumDate(dir, captureDate, allFiles, modTime)
	name := filepath.Base(dir)
	// 封面选择：图片优先
	var cover, coverKind string
	switch {
	case len(imagePaths) > 0:
		cover, coverKind = imagePaths[0], "image"
	default:
		cover, coverKind = videoPaths[0], "video"
	}
	return &models.Album{
		Type:         "album",
		Path:         dir,
		Name:         name,
		ImageFiles:   imagePaths,
		VideoFiles:   videoPaths,
		CoverImage:   cover,
		CoverKind:    coverKind,
		ImageCount:   len(imagePaths),
		VideoCount:   len(videoPaths),
		FolderSize:   totalSize,
		Tags:         ExtractTags(name),
		ModTime:      modTime,
		Date:         date,
		DateSource:   dateSource,
		CaptureDates: captureDates,
	}
}

// aggregateCaptureDates 汇总一本相册里从文件名推断出的拍摄日期。
//
// 返回去重升序的日期列表（"YYYYMMDD"）与最有代表性的那一天。
// 「代表性」按媒体数加权取众数：一年里拍了三天的相册，众数那一天
// 比「最新那一天」更能代表这本相册 —— 一张后来存进来的截图不该
// 把整本相册的年份拽走。众数并列时取较早的一天。
func aggregateCaptureDates(files []fileEntry) ([]string, time.Time) {
	if len(files) == 0 {
		return nil, time.Time{}
	}
	counts := make(map[string]int, len(files))
	for _, file := range files {
		if file.captured.IsZero() {
			continue
		}
		counts[file.captured.Format("20060102")]++
	}
	if len(counts) == 0 {
		return nil, time.Time{}
	}
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	best := keys[0]
	for _, key := range keys[1:] {
		if counts[key] > counts[best] {
			best = key
		}
	}
	stamp, err := time.ParseInLocation("20060102", best, time.UTC)
	if err != nil {
		return keys, time.Time{}
	}
	return keys, stamp
}

var strictFolderDate = regexp.MustCompile(`^(\d{4})(?:[-_.](\d{2})(?:[-_.](\d{2}))?)?$|^(\d{4})(\d{2})(\d{2})$`)

// 文件名里的拍摄时间。
//
// 相机与手机普遍把时间写进文件名：IMG_20240101_105902.jpg、
// 2024-01-01 22-10.jpg、微信图片_20240629212933.jpg、
// 咸鱼之王 bug 推塔 2023-3-4.mp4。照片库最有价值的时间维度就在
// 这些名字里，读一次文件名就够了 —— 不必为它去读 EXIF。
//
// 三种写法各一条正则：分隔数字、中文年月日、紧凑八位。RE2 不支持
// 前后瞻，所以「不能落在数字串中间」这类边界由代码判断。
type captureNamePattern struct {
	re *regexp.Regexp
	// strictTail 表示匹配后面不能紧跟数字：分隔写法里
	// 「2024-01-011」这种多一位的写法宁可判掉，也不要猜。
	strictTail bool
}

var captureNamePatterns = []captureNamePattern{
	{regexp.MustCompile(`(20\d{2})[-_.](\d{1,2})[-_.](\d{1,2})`), true},
	{regexp.MustCompile(`(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?`), false},
	{regexp.MustCompile(`(20\d{2})(\d{2})(\d{2})`), false},
}

// captureFromFileName 从文件名里推断拍摄时间。
//
// 只认「日」这一级：文件名里的时间常常只精确到时刻（105902），
// 而日期才是时间轴与「那年今日」要的粒度。推不出来时返回零值。
//
// 时间部分（若文件名里有 HHMMSS / HH-MM-SS）会被采用，让相册的
// 时间尽量接近真实拍摄时刻；没有就用当天正午 —— 与目录名日期的
// 口径一致，避免同一相册里的时间因为随机时刻而乱序。
func captureFromFileName(name string) time.Time {
	base := filepath.Base(name)
	for _, pattern := range captureNamePatterns {
		for _, loc := range pattern.re.FindAllStringSubmatchIndex(base, -1) {
			// 数字串中间不当作日期：「120240101」里的「20240101」
			// 是一串数字的一部分，不是日期。
			if loc[0] > 0 && isDigitByte(base[loc[0]-1]) {
				continue
			}
			if pattern.strictTail && loc[1] < len(base) && isDigitByte(base[loc[1]]) {
				continue
			}
			year := atoiOrZero(base[loc[2]:loc[3]])
			month := atoiOrZero(base[loc[4]:loc[5]])
			day := atoiOrZero(base[loc[6]:loc[7]])
			if year < 1900 || year > 2199 || month < 1 || month > 12 || day < 1 || day > 31 {
				continue
			}
			hour, minute, second := 12, 0, 0
			if clock := captureClockFromTail(base[loc[1]:]); !clock.IsZero() {
				hour, minute, second = clock.Clock()
			}
			stamp := time.Date(year, time.Month(month), day, hour, minute, second, 0, time.UTC)
			// Date 会把 2 月 30 日进位到 3 月；比对回去才能判掉这种假日期。
			if stamp.Year() != year || int(stamp.Month()) != month || stamp.Day() != day {
				continue
			}
			return stamp
		}
	}
	return time.Time{}
}

// captureClockFromTail 从日期之后的文件名尾巴里找时刻（105902 / 22-10）。
// 找不到时返回零值。
func captureClockFromTail(tail string) time.Time {
	buf := make([]byte, 0, 6)
	for i := 0; i < len(tail) && len(buf) < 6; i++ {
		c := tail[i]
		if c >= '0' && c <= '9' {
			buf = append(buf, c)
			continue
		}
		// 分隔符跳过，别的字符停下：文件名里跟日期无关的部分不该
		// 被当成时刻。
		if c == '-' || c == '_' || c == '.' {
			continue
		}
		break
	}
	if len(buf) < 4 {
		return time.Time{}
	}
	if len(buf) == 4 {
		buf = append(buf, '0', '0')
	}
	hour := atoiOrZero(string(buf[0:2]))
	minute := atoiOrZero(string(buf[2:4]))
	second := atoiOrZero(string(buf[4:6]))
	if hour > 23 || minute > 59 || second > 59 {
		return time.Time{}
	}
	return time.Date(2000, time.January, 1, hour, minute, second, 0, time.UTC)
}

func isDigitByte(c byte) bool {
	return c >= '0' && c <= '9'
}

func atoiOrZero(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}

// resolveAlbumDate 将时间语义收口在扫描层，避免不同页面以各自的正则
// 重复推断。filenameDate 来自文件名推断（见 captureFromFileName）——
// 当前扫描主链路不读取每个文件的 EXIF，避免百万媒体库被随机 I/O 拖慢。
func resolveAlbumDate(dir string, filenameDate time.Time, files []fileEntry, dirModified time.Time) (time.Time, string) {
	if !filenameDate.IsZero() {
		return filenameDate, "filename"
	}
	if folderDate, ok := strictDateFromPath(dir); ok {
		return folderDate, "folder"
	}
	latest := dirModified
	for _, file := range files {
		if file.modTime.After(latest) {
			latest = file.modTime
		}
	}
	return latest, "modified"
}

func strictDateFromPath(path string) (time.Time, bool) {
	cleaned := filepath.Clean(path)
	volume := filepath.VolumeName(cleaned)
	withoutVolume := strings.TrimPrefix(cleaned, volume)
	parts := strings.FieldsFunc(withoutVolume, func(r rune) bool {
		return r == '/' || r == '\\'
	})
	for i := len(parts) - 1; i >= 0; i-- {
		if parsed, ok := parseStrictDateSegment(parts[i]); ok {
			return parsed, true
		}
		if i >= 2 {
			year, yearOK := parseBoundedInt(parts[i-2], 1900, 2199)
			month, monthOK := parseBoundedInt(parts[i-1], 1, 12)
			day, dayOK := parseBoundedInt(parts[i], 1, 31)
			if yearOK && monthOK && dayOK {
				if parsed, valid := makeStrictDate(year, month, day); valid {
					return parsed, true
				}
			}
		}
	}
	return time.Time{}, false
}

func parseStrictDateSegment(segment string) (time.Time, bool) {
	match := strictFolderDate.FindStringSubmatch(segment)
	if match == nil {
		return time.Time{}, false
	}
	yearText, monthText, dayText := match[1], match[2], match[3]
	if match[4] != "" {
		yearText, monthText, dayText = match[4], match[5], match[6]
	}
	year, yearOK := parseBoundedInt(yearText, 1900, 2199)
	if !yearOK {
		return time.Time{}, false
	}
	month, day := 1, 1
	if monthText != "" {
		var ok bool
		month, ok = parseBoundedInt(monthText, 1, 12)
		if !ok {
			return time.Time{}, false
		}
	}
	if dayText != "" {
		var ok bool
		day, ok = parseBoundedInt(dayText, 1, 31)
		if !ok {
			return time.Time{}, false
		}
	}
	return makeStrictDate(year, month, day)
}

func parseBoundedInt(value string, low, high int) (int, bool) {
	parsed, err := strconv.Atoi(value)
	return parsed, err == nil && parsed >= low && parsed <= high
}

func makeStrictDate(year, month, day int) (time.Time, bool) {
	parsed := time.Date(year, time.Month(month), day, 12, 0, 0, 0, time.UTC)
	if parsed.Year() != year || int(parsed.Month()) != month || parsed.Day() != day {
		return time.Time{}, false
	}
	return parsed, true
}

// flattenAlbums 汇总所有顶层 + 集合（含嵌套集合）内含的相册。
//
// 现在扫描模型支持 Collection 嵌套（Collection.Collections 字段），所以
// smart grouping 要走到所有层级，否则深嵌套里的相册不会被聚合到
// 「标签 / 主题」维度。
func flattenAlbums(topAlbums []models.Album, topCollections []models.Collection) []models.Album {
	all := make([]models.Album, 0, len(topAlbums))
	all = append(all, topAlbums...)
	var walk func(cols []models.Collection)
	walk = func(cols []models.Collection) {
		for _, c := range cols {
			all = append(all, c.Albums...)
			if len(c.Collections) > 0 {
				walk(c.Collections)
			}
		}
	}
	walk(topCollections)
	return all
}

func countCollections(colls []models.Collection) int {
	count := len(colls)
	for i := range colls {
		count += countCollections(colls[i].Collections)
	}
	return count
}

// naturalLess 比较文件名中的 ASCII 数字段，使 page2 排在 page10 前。
// 非数字部分不区分大小写；完全相同时用原字符串保证稳定顺序。
func naturalLess(left, right string) bool {
	a := strings.ToLower(left)
	b := strings.ToLower(right)
	for i, j := 0, 0; i < len(a) && j < len(b); {
		if isASCIIDigit(a[i]) && isASCIIDigit(b[j]) {
			iEnd, jEnd := i, j
			for iEnd < len(a) && isASCIIDigit(a[iEnd]) {
				iEnd++
			}
			for jEnd < len(b) && isASCIIDigit(b[jEnd]) {
				jEnd++
			}
			aDigits := strings.TrimLeft(a[i:iEnd], "0")
			bDigits := strings.TrimLeft(b[j:jEnd], "0")
			if aDigits == "" {
				aDigits = "0"
			}
			if bDigits == "" {
				bDigits = "0"
			}
			if len(aDigits) != len(bDigits) {
				return len(aDigits) < len(bDigits)
			}
			if aDigits != bDigits {
				return aDigits < bDigits
			}
			if iEnd-i != jEnd-j {
				return iEnd-i < jEnd-j
			}
			i, j = iEnd, jEnd
			continue
		}
		if a[i] != b[j] {
			return a[i] < b[j]
		}
		i++
		j++
	}
	if len(a) != len(b) {
		return len(a) < len(b)
	}
	return left < right
}

func isASCIIDigit(value byte) bool {
	return value >= '0' && value <= '9'
}

// ExtractTags 从文件夹名中提取所有方括号标签。
//
// 规则：扫描整个名称，把每一对 `[...]` 的内容作为一个标签；
// 标签首尾空白会被 trim；空标签会被丢弃。
//
// 例子：
//   - "[作者A] 我的图集" → ["作者A"]
//   - "[tag1][tag2] 名字"  → ["tag1", "tag2"]
//   - "（无标签）"          → []
func ExtractTags(name string) []string {
	var tags []string
	for {
		i := strings.Index(name, "[")
		if i < 0 {
			break
		}
		rest := name[i+1:]
		j := strings.Index(rest, "]")
		if j < 0 {
			break
		}
		if t := strings.TrimSpace(rest[:j]); t != "" {
			tags = append(tags, t)
		}
		// 继续往后找（一次可能多个 [tag]）
		name = rest[j+1:]
	}
	return tags
}
