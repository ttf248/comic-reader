package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	"gopkg.in/yaml.v3"
)

// Manager 线程安全地持有当前生效的 *Config。
//
// 启动时 Load() 从 YAML 加载初始值；运行中通过 Update() 应用 PATCH，
// 立即写回磁盘并通过 OnChange 回调通知订阅者（如路径安全中间件、
// 缩略图服务、扫描器）。需要重启才能生效的字段通过 RequiresRestart 报告。
type Manager struct {
	path atomic.Pointer[string]

	// updateMu 串行化完整的读-改-写事务，避免两个非重叠 PATCH 从同一旧快照
	// 出发，后落盘的一方覆盖另一方（访问令牌轮换尤其不能被旧值回写）。
	updateMu sync.Mutex
	mu       sync.RWMutex
	current  *Config

	subsMu sync.Mutex
	subs   []subEntry
}

// subEntry 订阅者句柄，用 token 标识以便取消订阅。
type subEntry struct {
	token string
	fn    ChangeListener
}

// ChangeListener 接收新配置快照。Snapshot 是已合并的 *Config 副本。
type ChangeListener func(snapshot *Config)

// NewManager 创建 Manager 并加载 path 指定的 YAML（缺失使用默认值）。
func NewManager(path string) (*Manager, error) {
	cfg, err := LoadFile(path)
	if err != nil {
		return nil, err
	}
	m := &Manager{current: cfg}
	p := path
	m.path.Store(&p)
	return m, nil
}

// NewManagerWith 直接以已加载的 *Config 构造 Manager（用于测试或
// 已在外层 LoadFile 过的场景）。path 为空时不启用磁盘持久化。
func NewManagerWith(cfg *Config, path string) *Manager {
	m := &Manager{current: cfg}
	if path != "" {
		p := path
		m.path.Store(&p)
	}
	return m
}

// Get 返回当前 *Config 的深拷贝快照（避免外部修改影响内部状态）。
func (m *Manager) Get() *Config {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return cloneConfig(m.current)
}

// Roots 返回当前生效的所有媒体根目录（已规范化）。
func (m *Manager) Roots() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	src := m.current.Roots()
	out := make([]string, len(src))
	copy(out, src)
	return out
}

// Path 返回配置文件路径（绝对），用于错误信息展示。
func (m *Manager) Path() string {
	p := m.path.Load()
	if p == nil {
		return ""
	}
	return *p
}

// OnChange 注册变更回调。返回的函数用于取消订阅。
//
// 同一函数多次注册会被多次调用；如需去重请自行包装。
// token 用于按名称取消订阅（保留参数，未来可扩展 UnsubscribeByName）。
func (m *Manager) OnChange(name string, fn ChangeListener) func() {
	m.subsMu.Lock()
	entry := subEntry{token: name, fn: fn}
	m.subs = append(m.subs, entry)
	m.subsMu.Unlock()
	return func() {
		m.subsMu.Lock()
		defer m.subsMu.Unlock()
		out := m.subs[:0]
		for _, e := range m.subs {
			if e.token == name {
				// 删除所有同名订阅（实际使用中通常一对一）
				continue
			}
			out = append(out, e)
		}
		m.subs = out
	}
}

// Update 应用 patch（部分字段）并写回磁盘。
//
// 行为：
//  1. 合并 patch 到当前 config（patch 字段优先级最高；零值字符串/数字视为"未设置"）
//  2. 重新校验；失败返回错误（不写盘、不更新内存）
//  3. 写盘（原子：tmp + rename），失败回滚内存
//  4. 替换内存中的 *Config 并触发 OnChange
//
// 返回 RequiresRestart 中包含的字段名集合（需要重启才能真正生效的字段）。
// 调用方应据此向用户提示。
func (m *Manager) Update(patch ConfigPatch) (requiresRestart []string, err error) {
	m.updateMu.Lock()
	defer m.updateMu.Unlock()

	// 1. 合并
	m.mu.RLock()
	merged := cloneConfig(m.current)
	m.mu.RUnlock()
	applyPatch(merged, &patch)

	// 2. 校验
	if err := merged.Validate(); err != nil {
		return nil, fmt.Errorf("validate: %w", err)
	}
	if patch.MediaRootsSet {
		if err := merged.ValidateMediaRoots(); err != nil {
			return nil, fmt.Errorf("validate: %w", err)
		}
	}

	// 3. 写盘
	if path := m.Path(); path != "" {
		if err := saveYAML(path, merged); err != nil {
			return nil, fmt.Errorf("save: %w", err)
		}
	}

	// 4. 替换 + 通知
	m.mu.Lock()
	old := m.current
	m.current = merged
	m.mu.Unlock()

	requiresRestart = diffRequiresRestart(old, merged)

	// 配置更新频率很低，同步、按提交顺序通知能保证连续 PATCH 不会让旧快照
	// 后到并覆盖新服务状态。每个 listener 收到独立深拷贝，且 panic 被隔离。
	listeners := m.snapshotListeners()
	for _, e := range listeners {
		notifyListener(e, merged)
	}

	return requiresRestart, nil
}

// Reload 从磁盘重新加载（管理员可手动重置被外部编辑的 config）。
// 同样会触发 OnChange 通知。
func (m *Manager) Reload() error {
	m.updateMu.Lock()
	defer m.updateMu.Unlock()

	path := m.Path()
	if path == "" {
		return errors.New("no config path set")
	}
	cfg, err := LoadFile(path)
	if err != nil {
		return err
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	m.mu.Lock()
	old := m.current
	m.current = cfg
	m.mu.Unlock()

	listeners := m.snapshotListeners()
	_ = diffRequiresRestart(old, cfg) // Reload 不返回该字段
	for _, e := range listeners {
		notifyListener(e, cfg)
	}
	return nil
}

func notifyListener(listener subEntry, snapshot *Config) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "config subscriber %q panic: %v\n", listener.token, r)
		}
	}()
	listener.fn(cloneConfig(snapshot))
}

func (m *Manager) snapshotListeners() []subEntry {
	m.subsMu.Lock()
	defer m.subsMu.Unlock()
	return append([]subEntry(nil), m.subs...)
}

// ---- helpers ----

func cloneConfig(c *Config) *Config {
	if c == nil {
		return nil
	}
	cp := *c
	// 深拷贝切片，避免外部修改影响内部状态
	if c.MediaRoots != nil {
		cp.MediaRoots = append([]MediaRoot(nil), c.MediaRoots...)
	}
	if c.SystemFiles != nil {
		cp.SystemFiles = append([]string(nil), c.SystemFiles...)
	}
	if c.ExcludePatterns != nil {
		cp.ExcludePatterns = append([]string(nil), c.ExcludePatterns...)
	}
	return &cp
}

// saveYAML 原子写入（tmp + rename），目录不存在则创建。
func saveYAML(path string, cfg *Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	out, err := marshalConfig(cfg)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	// config.yaml 可能包含访问令牌与本机路径。Unix 创建模式先限制为
	// owner-only；随后由平台实现统一收紧现有文件权限（Windows 使用 DACL）。
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return err
	}
	if err := secureConfigFile(tmp); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename %s -> %s: %w", tmp, path, err)
	}
	if err := secureConfigFile(path); err != nil {
		return err
	}
	return nil
}

// marshalConfig 用 yaml.Node 输出，key 顺序与 config.example.yaml 保持一致，
// 方便用户阅读和人工编辑。
//
// mediaRoots 始终序列化为数组；0 个元素时序列化为空数组 []，让用户明确"已配置但为空"。
func marshalConfig(cfg *Config) ([]byte, error) {
	root := &yaml.Node{
		Kind: yaml.MappingNode,
		Tag:  "!!map",
	}
	addKV := func(k string, v *yaml.Node) {
		root.Content = append(root.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: k},
			v,
		)
	}

	// mediaRoots 数组：每个条目写 path 与 kind。
	roots := cfg.NormalizedRoots()
	rootsNode := &yaml.Node{
		Kind:    yaml.SequenceNode,
		Tag:     "!!seq",
		Content: make([]*yaml.Node, 0, len(roots)),
	}
	for _, r := range roots {
		entry := &yaml.Node{
			Kind:    yaml.MappingNode,
			Tag:     "!!map",
			Content: make([]*yaml.Node, 0, 4),
		}
		entry.Content = append(entry.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "path"},
			scalarString(r.Path),
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "kind"},
			scalarString(r.Kind),
		)
		rootsNode.Content = append(rootsNode.Content, entry)
	}
	addKV("mediaRoots", rootsNode)

	addKV("host", scalarString(cfg.Host))
	addKV("port", scalarInt(cfg.Port))
	addKV("accessMode", scalarString(cfg.AccessMode))
	addKV("accessToken", scalarString(cfg.AccessToken))
	addKV("cacheDir", scalarString(cfg.CacheDir))
	addKV("thumbCacheSize", scalarInt(cfg.ThumbCacheSize))
	addKV("cacheMaxAgeDays", scalarInt(cfg.CacheMaxAgeDays))
	addKV("cacheMaxSizeMB", scalarInt(int(cfg.CacheMaxSizeMB)))
	addKV("allowOsOpen", scalarBool(cfg.AllowOsOpen))
	addKV("staticDir", scalarString(cfg.StaticDir))
	addKV("ffmpegPath", scalarString(cfg.FFmpegPath))
	addKV("skipHidden", scalarBool(cfg.SkipHidden))
	addKV("systemFiles", stringSliceNode(cfg.SystemFiles))
	addKV("excludePatterns", stringSliceNode(cfg.ExcludePatterns))
	return yaml.Marshal(root)
}

func scalarString(s string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: s, Style: yaml.DoubleQuotedStyle}
}
func scalarInt(n int) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: fmt.Sprintf("%d", n)}
}
func scalarBool(b bool) *yaml.Node {
	v := "false"
	if b {
		v = "true"
	}
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: v}
}

// stringSliceNode 序列化为 YAML 序列。nil/空都输出空数组 `[]`,
// 让用户明确「已配置但为空」,而不是看上去缺字段。
func stringSliceNode(s []string) *yaml.Node {
	n := &yaml.Node{
		Kind:    yaml.SequenceNode,
		Tag:     "!!seq",
		Content: make([]*yaml.Node, 0, len(s)),
	}
	for _, v := range s {
		n.Content = append(n.Content, scalarString(v))
	}
	return n
}

// applyPatch 把 patch 中的显式字段合并到 dst。Set 标志由 ConfigPatch 提供。
func applyPatch(dst *Config, p *ConfigPatch) {
	if p.MediaRootsSet {
		dst.MediaRoots = append([]MediaRoot(nil), p.MediaRoots...)
	}
	if p.HostSet {
		dst.Host = p.Host
	}
	if p.PortSet {
		dst.Port = p.Port
	}
	if p.AccessModeSet {
		dst.AccessMode = p.AccessMode
	}
	if p.AccessTokenSet {
		dst.AccessToken = p.AccessToken
	}
	if p.CacheDirSet {
		dst.CacheDir = p.CacheDir
	}
	if p.ThumbCacheSizeSet {
		dst.ThumbCacheSize = p.ThumbCacheSize
	}
	if p.CacheMaxAgeDaysSet {
		dst.CacheMaxAgeDays = p.CacheMaxAgeDays
	}
	if p.CacheMaxSizeMBSet {
		dst.CacheMaxSizeMB = p.CacheMaxSizeMB
	}
	if p.AllowOsOpenSet {
		dst.AllowOsOpen = p.AllowOsOpen
	}
	if p.StaticDirSet {
		dst.StaticDir = p.StaticDir
	}
	if p.FFmpegPathSet {
		dst.FFmpegPath = p.FFmpegPath
	}
	if p.SkipHiddenSet {
		dst.SkipHidden = p.SkipHidden
	}
	if p.SystemFilesSet {
		// 显式空数组 = 清空用户追加的白名单(内置依然由 services 层兜底)
		dst.SystemFiles = append([]string(nil), p.SystemFiles...)
	}
	if p.ExcludePatternsSet {
		dst.ExcludePatterns = append([]string(nil), p.ExcludePatterns...)
	}
}

// diffRequiresRestart 返回需要重启才能生效的字段名（仅在确实变化时返回）。
//
// 当前规则：
//   - host / port：监听地址，进程级
//   - staticDir：Fiber 在启动时已注册 Static；运行中无法卸载
//   - cacheDir：扫描缓存、偏好、缩略图与视频服务必须作为整体切换
//   - ffmpegPath：抽帧、元数据、faststart 与转码服务必须作为整体切换
//   - mediaRoots：路径安全中间件和扫描器可通过 Manager 热更新；扫描缓存会
//     被 onUpdate 钩子清空，调用方应主动触发重新扫描（不视为需要重启）
//
// 其它字段（accessMode / accessToken / thumbCacheSize / cacheMaxAgeDays /
// thumbCacheSize / allowOsOpen）可热生效。
func diffRequiresRestart(old, neu *Config) []string {
	var out []string
	if old.Host != neu.Host {
		out = append(out, "host")
	}
	if old.Port != neu.Port {
		out = append(out, "port")
	}
	if old.StaticDir != neu.StaticDir {
		out = append(out, "staticDir")
	}
	if old.CacheDir != neu.CacheDir {
		out = append(out, "cacheDir")
	}
	if old.FFmpegPath != neu.FFmpegPath {
		out = append(out, "ffmpegPath")
	}
	return out
}
