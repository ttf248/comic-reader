package services

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sync/singleflight"
)

// ErrFaststartUnavailable 表示 ffmpeg 不可用或不可执行。
//
// 视频 faststart 化是「优化项」而不是「必需项」:调用方拿到此错误时
// 应回退到直接流式发送原文件,而不是 5xx(原文件本身是合法的,只是
// 没有 faststart 优化)。
var ErrFaststartUnavailable = errors.New("faststart unavailable")

// FaststartStatus 描述一次 faststart 解析的结果。
//
// 状态机:
//
//	Unknown / Skipped / Fast / Remuxed
//
// handler 端一般只关心 "我该发哪个文件" —— 见 Resolve 返回值。
type FaststartStatus int32

const (
	// StatusUnknown 默认零值（理论上不该被外部观察到；Resolve 总会写实际值）。
	StatusUnknown FaststartStatus = iota
	// StatusSkipped 非 MP4/M4V 容器,跳过 faststart 化,直接发原文件。
	StatusSkipped
	// StatusFast 原文件已经是 faststart,无需重封装。
	StatusFast
	// StatusRemuxed 通过 ffmpeg 重封装成功,服务的是缓存文件。
	StatusRemuxed
	// StatusFallback ffmpeg 重封装失败,回退到发原文件。
	StatusFallback
)

func (s FaststartStatus) String() string {
	switch s {
	case StatusSkipped:
		return "skipped"
	case StatusFast:
		return "fast"
	case StatusRemuxed:
		return "remuxed"
	case StatusFallback:
		return "fallback"
	default:
		return "unknown"
	}
}

// VideoFaststartService 把「非 faststart 的 MP4」自动重封装为 faststart 形式
// 并缓存，供 /api/media/:fileId 流式发送。
//
// 为什么需要:
//
//	浏览器原生 <video> 元素对「moov atom 在文件末尾」(非 faststart) 的 MP4,
//	在边下边播场景下往往要拉到文件末尾才能拿到时长和起始位置才能开始播放,
//	对 1GB+ 视频基本不可用。把 moov 移到文件头后,浏览器从头读几十 KB 就
//	能开始播放,体验与 faststart 原生 MP4 一致。
//
// 工作流:
//
//  1. 客户端 GET /api/media/:fileId 触发
//  2. handler 调 Resolve(abs, info) 得到 (servePath, status)
//  3. 缓存命中: 立刻返回缓存文件路径
//     缓存未命中且 ffmpeg 可用: ffmpeg -c copy -movflags +faststart 重封装,
//     结果写盘,下次直接命中
//     缓存未命中且 ffmpeg 不可用: 回退到发原文件 (StatusFallback),
//     不阻断播放只是没有 faststart 优化
//     非 MP4/M4V 容器: 跳过 (StatusSkipped)
//
// 失效策略: 缓存 key = md5(abs_path + "|" + mtime_ns + "|" + size),
// 源文件 mtime/size 变化时 (重新下载/重编码) 自动重新生成。
//
// 并发: singleflight 防止同一视频的并发请求触发多次重封装;内部 sync.Mutex
// 保护 status 字段的原子读写(仅用于诊断/统计,不影响正确性)。
type VideoFaststartService struct {
	cacheDir string
	ffmpeg   string

	// 单次 ffmpeg 调用超时。1GB 文件 -c copy 重封装通常 1-3s,20s 留足余量。
	timeout time.Duration

	// 同 key 并发请求只跑一次 ffmpeg;其它协程等结果。
	flight singleflight.Group

	// 状态计数器(原子);handler 端用 LastStatus() 查最近一次结果,
	// 测试用 Stats() 拿累计计数。
	statusCounters [5]atomic.Int64

	// 可用性探测缓存:Available() 内部跑 `ffmpeg -version`,每次
	// 进程启动 50-200ms;旧实现每个视频请求都跑一次,日志里也常见
	// "faststart remux failed" 时 ffmpeg 没问题但又重跑探活的浪费。
	// sync.Once 保证整个 service 生命周期只探一次。
	availOnce sync.Once
	avail     bool

	// isFaststart() 读 8MiB 头部,重复命中同一文件(mtime+size 不变)
	// 是同一视频多次 Range / 多用户轮询等场景的常见路径,每次都读 8MiB
	// 不划算。key 用 path|mtime_ns|size 派生,源文件被覆盖自动失效。
	// sync.Map 适合"写一次读多次"模式;为防大库下 map 无界增长,
	// 超过 faststartCacheMax 时整体清空(下个请求重新读,符合冷启动语义)。
	fsCache sync.Map
}

// faststartCacheMax fsCache 的容量上限。覆盖"用户翻一遍 4k+ 视频"是
// 充足余量;超过时清空,而不是按 LRU 淘汰,避免引入额外锁和复杂度。
const faststartCacheMax = 4096

// FaststartOptions 构造选项。
type FaststartOptions struct {
	CacheDir string        // 必填,缩略图/封面同级目录
	FFmpeg   string        // ffmpeg 可执行文件绝对路径;为空时 Available()=false
	Timeout  time.Duration // 单次 ffmpeg 超时,默认 20s
}

// NewVideoFaststartService 构造;FFmpeg 为空时仍成功但 Available()=false,
// 后续 Resolve 全部返回 StatusFallback(直接发原文件,不报错)。
func NewVideoFaststartService(opts FaststartOptions) *VideoFaststartService {
	t := opts.Timeout
	if t <= 0 {
		t = 20 * time.Second
	}
	return &VideoFaststartService{
		cacheDir: opts.CacheDir,
		ffmpeg:   opts.FFmpeg,
		timeout:  t,
	}
}

// Available 返回 ffmpeg 是否可用(整个 service 生命周期只探测一次)。
//
// 旧实现每次都跑 `ffmpeg -version`(50-200ms 进程启动 + stdout 解析);
// Resolve() / GetStatus() / handler 热路径都会调,日志中"ffmpeg 明明在
// 但每次都重跑探活"的成本很显眼。sync.Once 把结果锁在 service 内部,
// service 实例重建时(main.go 的 OnChange 切换 ffmpeg 路径)自动失效。
func (s *VideoFaststartService) Available() bool {
	if s == nil || s.ffmpeg == "" {
		return false
	}
	s.availOnce.Do(func() {
		cmd := exec.Command(s.ffmpeg, "-version")
		s.avail = cmd.Run() == nil
	})
	return s.avail
}

// FFmpegPath 返回构造时设置的 ffmpeg 路径。
func (s *VideoFaststartService) FFmpegPath() string {
	if s == nil {
		return ""
	}
	return s.ffmpeg
}

// CacheDir 返回构造时设置的缓存目录。
func (s *VideoFaststartService) CacheDir() string {
	if s == nil {
		return ""
	}
	return s.cacheDir
}

// Resolve 是核心入口: 给定视频绝对路径,返回「应该发给浏览器的文件路径」和
// 解析状态。失败永远不返回 error —— 任何内部异常都退化为发原文件(不阻断播放)。
//
// 状态机:
//
//	非 MP4/M4V 容器             → (absPath, StatusSkipped)
//	ffmpeg 不可用                → (absPath, StatusFallback)
//	原文件 Stat 失败             → (absPath, StatusFallback)
//	原文件已是 faststart         → (absPath, StatusFast)         [不发缓存,免得浪费一次磁盘写]
//	重封装成功(新缓存)          → (cachedPath, StatusRemuxed)
//	重封装失败(ffmpeg 报错)     → (absPath, StatusFallback)      [原文件本身可读,只是没 faststart 优化]
//
// 调用方拿到 servePath 后直接 c.SendFile(servePath) 即可;Range/MIME 等
// 头仍由 handler 端按原逻辑设置,因为 faststart 化只改字节布局、不动容器格式。
// Resolve 决定 /api/media 是否要 remux,以及 remux 缓存是否命中。
//
// info 可选非 nil:handler 端已 stat 过源文件,这里复用,省一次 syscall。
// 传 nil 时本函数内部读取源文件信息。
func (s *VideoFaststartService) Resolve(absPath string, info os.FileInfo) (servePath string, status FaststartStatus) {
	if s == nil {
		return absPath, StatusFallback
	}
	defer func() {
		// 兜底:任何 panic / 未预期的早返回都视为 fallback
		if servePath == "" {
			servePath = absPath
			status = StatusFallback
		}
		s.statusCounters[status].Add(1)
	}()

	// 非 MP4/M4V 容器: 跳过(faststart 是 MP4 概念,AVI/MKV/WebM/MOV
	// 处理路径不同;MKV 走 -movflags 不生效)。直接发原文件。
	ext := strings.ToLower(filepath.Ext(absPath))
	if ext != ".mp4" && ext != ".m4v" {
		return absPath, StatusSkipped
	}

	// ffmpeg 不可用: 退化
	if !s.Available() {
		return absPath, StatusFallback
	}

	// 源文件不存在: 退化(handler 会自己 Stat 失败返回 404,这里不必预校验)
	fi := info
	if fi == nil {
		var err error
		fi, err = os.Stat(absPath)
		if err != nil {
			return absPath, StatusFallback
		}
	}

	key := faststartKey(absPath, fi.ModTime(), fi.Size())
	cachedPath := filepath.Join(s.cacheDir, "video-faststart", key+".mp4")

	// 1) 缓存命中 → 直接发缓存文件
	if _, err := statVideoCache(cachedPath); err == nil {
		return cachedPath, StatusRemuxed
	}

	// 2) 原文件已是 faststart → 不写缓存(浪费一次磁盘 IO),
	//    直接让 handler 发原文件,省一次 ffmpeg。
	//    isFaststart() 读 8MiB,这里走 fsCache 命中后 0 IO。
	if cachedFast, ok := s.lookupFaststart(absPath, fi); ok {
		if cachedFast {
			return absPath, StatusFast
		}
		// cached false: 文件已确认非 faststart,落到 remux 分支
	} else if isFaststart(absPath) {
		s.storeFaststart(absPath, fi, true)
		return absPath, StatusFast
	} else {
		s.storeFaststart(absPath, fi, false)
	}

	// 3) 缓存未命中 + 非 faststart → 重封装
	//    singleflight 防止并发请求触发多次 ffmpeg。
	v, err, _ := s.flight.Do(key, func() (interface{}, error) {
		// 双重检查:进入临界区后再查一次磁盘,避免上一个协程刚写完
		// 被本协程再次重写。
		if _, err := statVideoCache(cachedPath); err == nil {
			return cachedPath, nil
		}
		if err := s.remux(absPath, cachedPath); err != nil {
			return "", err
		}
		return cachedPath, nil
	})
	if err != nil {
		// ffmpeg 失败 / 写盘失败:回退到原文件(handler 仍能正常发出去,
		// 只是失去 faststart 优化)。注意记到 stderr 方便排查。
		fmt.Fprintln(os.Stderr, "faststart remux failed; serving source video")
		return absPath, StatusFallback
	}
	return v.(string), StatusRemuxed
}

// LastStatus 返回最近一次 Resolve 的状态(线程安全)。
//
// 设计意图:给 handler / 日志 / 调试用,例如"这次响应到底是发的缓存还是
// 原文件";不想为此引入锁。零竞争窗口可接受(读到旧值不影响正确性)。
func (s *VideoFaststartService) LastStatus() FaststartStatus {
	if s == nil {
		return StatusUnknown
	}
	// 找最新 Add 过的那个(近似,不严格)
	var best FaststartStatus = StatusUnknown
	var bestVal int64
	for i := range s.statusCounters {
		v := s.statusCounters[i].Load()
		if v >= bestVal {
			bestVal = v
			best = FaststartStatus(i)
		}
	}
	return best
}

// Stats 返回各状态累计计数(测试 / 监控用)。
func (s *VideoFaststartService) Stats() (skipped, fast, remuxed, fallback int64) {
	if s == nil {
		return
	}
	return s.statusCounters[StatusSkipped].Load(),
		s.statusCounters[StatusFast].Load(),
		s.statusCounters[StatusRemuxed].Load(),
		s.statusCounters[StatusFallback].Load()
}

// faststartKey 缓存 key。同 (absPath, mtime, size) 一定命中同一缓存,
// 源文件被覆盖/重编码时 mtime 或 size 必变化 → 自动失效。
func faststartKey(absPath string, mtime time.Time, size int64) string {
	h := md5.New()
	fmt.Fprintf(h, "fs:%s|%d|%d", absPath, mtime.UnixNano(), size)
	return hex.EncodeToString(h.Sum(nil))
}

// isFaststart 通过读文件前若干字节判断 moov atom 是否在文件头部(且 mdat 在它之后)。
//
// MP4 是 box 序列,每个 box = [4 字节 size][4 字节 type][payload...]。
// 顶层 box 顺次扫描:
//
//   - 先遇到 moov: 视为 faststart
//   - 先遇到 mdat: 视为非 faststart(moov 在 mdat 后,典型录屏/手机录制产物)
//   - 探测 buffer 用完还没遇到任一关键 box: 保守视为"非 faststart",
//     触发一次 remux(下次访问走缓存,白跑一次成本可忽略)
//
// 为节省 IO,只读前 8 MiB。实际 faststart 文件的 moov box 一般远小于
// 此值(几十 KB ~ 几 MB,极端 4K HDR 长视频可能更大但仍远小于 8 MiB);
// 而非 faststart 文件的 mdat box 一定在最前几字节就出现,probe 阶段
// 就能识别。
func isFaststart(absPath string) bool {
	const probe = 8 * 1024 * 1024
	f, err := os.Open(absPath)
	if err != nil {
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return false
	}
	readSize := probe
	if st.Size() < int64(readSize) {
		readSize = int(st.Size())
	}
	buf := make([]byte, readSize)
	n, err := f.Read(buf)
	if err != nil && n == 0 {
		return false
	}
	return firstTopLevelAtom(buf[:n], "moov", "mdat") == "moov"
}

// firstTopLevelAtom 按 MP4 box 边界走,返回"先遇到的关键 box type"。
// 不下钻到子 box(box payload 内的偶然字节序列不会被误判)。
//
// 返回值:
//   - "moov"/"mdat": 找到了指定的关键 box
//   - "": 探测 buffer 用完还没找到任一关键 box
func firstTopLevelAtom(data []byte, atoms ...string) string {
	atomSet := make(map[string]bool, len(atoms))
	for _, a := range atoms {
		atomSet[a] = true
	}
	pos := 0
	for pos+8 <= len(data) {
		size := uint32(data[pos])<<24 | uint32(data[pos+1])<<16 | uint32(data[pos+2])<<8 | uint32(data[pos+3])
		boxType := string(data[pos+4 : pos+8])
		if atomSet[boxType] {
			return boxType
		}
		// size == 0: box 延续到文件末尾(本探测 buffer 内无法判断类型)
		// size == 1: 64-bit largesize,跳过(本探测范围内几乎不出现)
		if size == 0 || size == 1 {
			return ""
		}
		// 防御:异常的 size(超大、负数)直接停,免得越界
		if size > uint32(len(data)-pos) {
			return ""
		}
		pos += int(size)
	}
	return ""
}

// containsAtom 在 MP4 box 序列中查找指定 4 字节 type。
// 保留以备未来审计/调试用;主判断改用 firstTopLevelAtom 区分 moov 与 mdat 先后顺序。
func containsAtom(data []byte, want string) bool {
	pos := 0
	for pos+8 <= len(data) {
		size := uint32(data[pos])<<24 | uint32(data[pos+1])<<16 | uint32(data[pos+2])<<8 | uint32(data[pos+3])
		boxType := string(data[pos+4 : pos+8])
		if boxType == want {
			return true
		}
		if size == 0 || size == 1 {
			return false
		}
		if size > uint32(len(data)-pos) {
			return false
		}
		pos += int(size)
	}
	return false
}

// remux 调 ffmpeg 把源文件重封装为 faststart 写到 dstPath。
//
// -c copy: 不重新编码(只搬 box),对 1GB 视频 1-3s 完成;
// -movflags +faststart: moov 移到 mdat 前面;
// 输出格式固定 mp4(输入是 mp4/m4v),方便缓存扩展名稳定。
//
// 失败:含 ffmpeg 进程未启动(→ ErrFaststartUnavailable)与 ffmpeg
// 跑了但退出非 0(→ 具体错误,handler 端统一 fallback)。
func (s *VideoFaststartService) remux(srcPath, dstPath string) error {
	tmpPath, err := newVideoCacheTemp(dstPath)
	if err != nil {
		return fmt.Errorf("create remux temporary file: %w", err)
	}
	defer os.Remove(tmpPath)
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, s.ffmpeg,
		"-hide_banner",
		"-loglevel", "error",
		"-y", // 只写本次生成独占的临时文件
		"-i", srcPath,
		"-c", "copy",
		"-movflags", "+faststart",
		"-f", "mp4",
		tmpPath,
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err = cmd.Run()
	if err != nil {
		if cmd.ProcessState == nil {
			// 进程根本没起来(ffmpeg 路径失效、权限不足)→ unavailable
			return fmt.Errorf("%w: %s", ErrFaststartUnavailable, err.Error())
		}
		if ctx.Err() == context.DeadlineExceeded {
			return fmt.Errorf("faststart remux timeout: %w", ctx.Err())
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("faststart remux: %s", msg)
	}
	if _, err := statVideoCache(tmpPath); err != nil {
		return fmt.Errorf("faststart remux produced invalid output: %w", err)
	}
	if err := os.Rename(tmpPath, dstPath); err != nil {
		return fmt.Errorf("publish faststart cache: %w", err)
	}
	return nil
}

// ClearCache 清空 faststart 缓存目录,返回删除文件数和释放字节数。
//
// 与 ThumbnailService.ClearAll 对齐:即便目录为空(返回 0, 0, nil),
// 调用方也能拿到确定的"无操作"结果,前端展示更稳定。
//
// 设计:先 WalkDir 累加字节数,再 RemoveAll —— 一次遍历拿到统计,避免
// 删完文件后 stat 拿不到 size 的尴尬。失败不返回 partial 数字,而是
// 直接把错误往外抛,让 handler 决定如何向用户反馈。
func (s *VideoFaststartService) ClearCache() (deleted int, freedBytes int64, err error) {
	if s == nil || s.cacheDir == "" {
		return 0, 0, nil
	}
	dir := filepath.Join(s.cacheDir, "video-faststart")
	info, statErr := os.Stat(dir)
	if os.IsNotExist(statErr) {
		return 0, 0, nil
	}
	if statErr != nil {
		return 0, 0, statErr
	}
	if !info.IsDir() {
		return 0, 0, fmt.Errorf("faststart cache path is not a directory: %s", dir)
	}
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() {
			return nil
		}
		fi, infoErr := d.Info()
		if infoErr != nil {
			return nil
		}
		freedBytes += fi.Size()
		deleted++
		return nil
	})
	if rmErr := os.RemoveAll(dir); rmErr != nil {
		return deleted, freedBytes, rmErr
	}
	return deleted, freedBytes, nil
}

// 并发安全验证:Resolve 在多协程下不能破坏 s 内部状态。
// 当前实现里 s 只读 ffmpeg/cacheDir,flight 自带并发安全,不需要额外锁。
// 但保留方法签名以备未来加状态字段(已被废弃,只是为防止引用移除编译失败)。
var _ = sync.Mutex{}

// faststartCacheKey 派生 fsCache 的 key:path|mtime_ns|size。
//
// 与 faststartKey(磁盘缓存 key)独立 —— 磁盘 cache key 还要带前缀和
// 编码参数,这里只关心"同一文件同一版本是否 faststart"。
func faststartCacheKey(absPath string, mtime time.Time, size int64) string {
	return fmt.Sprintf("%s|%d|%d", absPath, mtime.UnixNano(), size)
}

// lookupFaststart 查询 fsCache。返回 (value, hit):
//   - hit=true, value=true  → 文件已确认 faststart,跳过 isFaststart 的 8MiB 读
//   - hit=true, value=false → 文件已确认非 faststart,直接走 remux
//   - hit=false              → 缓存未命中,调用方需自己跑 isFaststart + store
func (s *VideoFaststartService) lookupFaststart(absPath string, fi os.FileInfo) (bool, bool) {
	k := faststartCacheKey(absPath, fi.ModTime(), fi.Size())
	if v, ok := s.fsCache.Load(k); ok {
		return v.(bool), true
	}
	return false, false
}

// storeFaststart 把 isFaststart 的结果写入 fsCache。超容量时整体清空
// (简单优于 LRU 淘汰:清空后下次访问重新读 8MiB,符合冷启动语义)。
func (s *VideoFaststartService) storeFaststart(absPath string, fi os.FileInfo, fast bool) {
	// 容量检查:Range 一下大概条目数,超阈值就清空。注意 sync.Map
	// 没有 Len(),这里用 atomic 维护一个近似计数。
	fsCacheSize.Add(1)
	if fsCacheSize.Load() > int64(faststartCacheMax) {
		// 重新建一个空 map 替换进去;旧 map 仍被并发 reader 引用,
		// 不会立即被 GC,但 sync.Map 的零值是空 map,可安全替换。
		s.fsCache = sync.Map{}
		fsCacheSize.Store(0)
		return
	}
	k := faststartCacheKey(absPath, fi.ModTime(), fi.Size())
	s.fsCache.Store(k, fast)
}

// fsCacheSize 维护 fsCache 的近似条目数。sync.Map 没暴露 Len(),
// 简单用一个 atomic counter;清空时归零,小幅误差可接受(超阈值再清
// 一次即可,不会无限增长)。
var fsCacheSize atomic.Int64
