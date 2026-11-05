// Package config 提供本地画廊后端的 YAML 配置加载。
//
// 配置来源唯一：YAML 文件（默认 ./config.yaml，可用 --config 指定）。
// 未配置的字段走内置默认值；缓存目录默认在进程 CWD 下创建
// `.local-gallery/`（存放缩略图、扫描结果、用户偏好）。
//
// 字段优先级：YAML 文件中显式值 > 内置默认值。无任何 env / flag 覆盖。
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"gopkg.in/yaml.v3"

	"github.com/tianlongxiang/local-gallery/internal/pathutil"
)

// Version 后端版本号（编译期可通过 -ldflags 注入）。
var Version = "0.1.0"

// DefaultConfigName 未指定 --config 时查找的文件名（相对 CWD）。
const DefaultConfigName = "config.yaml"

// DefaultCacheDirName 未配置 cacheDir 时使用的目录名（创建在 CWD 下）。
const DefaultCacheDirName = ".local-gallery"

// AccessMode 控制 API 的网络访问边界。
//
// local 是默认且最安全的模式：只接受回环地址请求；lan 用于受信局域网，
// 所有非健康检查 API 都必须通过访问令牌或由令牌换取的短期会话认证。
const (
	AccessModeLocal = "local"
	AccessModeLAN   = "lan"

	// MinAccessTokenLength 防止把容易猜测的短口令当作局域网访问令牌。
	// 推荐使用密码学安全随机源生成至少 32 个 ASCII 字符。
	MinAccessTokenLength = 32
	MaxAccessTokenLength = 256
)

// DefaultFFmpegPath ffmpeg 默认可执行文件位置。
//
// 解析规则由 services.NewVideoCoverExtractor 内部处理:
// 1) 优先用 config.yaml 里显式写的 ffmpegPath
// 2) 否则用本常量(<RepoRoot>/bin/ffmpeg/windows/amd64/ffmpeg.exe)
// 3) 都没有 → Available()=false,视频封面回退到客户端抽帧
const DefaultFFmpegPath = "../bin/ffmpeg/windows/amd64/ffmpeg.exe"

// MediaRoot 是一个媒体根目录及其内容属性。
//
// 属性（Kind）是这个目录里内容的性质："photo" 照片或 "comic" 漫画，
// 两者互斥——一个目录只能是一种。目录下的相册与集合继承它。
type MediaRoot struct {
	Path string `yaml:"path" json:"path"`
	Kind string `yaml:"kind" json:"kind"`
}

// UnmarshalYAML 解析媒体根条目。
//
// 条目必须是「路径 + 属性」的映射：属性由目录自己决定，不能只写路径。
// 旧写法（直接写一个路径字符串）会得到一条指明新写法的错误，
// 而不是被悄悄当成照片目录。
func (r *MediaRoot) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind == yaml.ScalarNode {
		return fmt.Errorf(
			"mediaRoots 条目必须写成 {path: \"...\", kind: photo|comic} 映射，不再支持只写路径",
		)
	}
	type plain MediaRoot
	var value plain
	if err := node.Decode(&value); err != nil {
		return err
	}
	*r = MediaRoot(value)
	return nil
}

// DefaultMediaRootKind 是目录未显式写属性时使用的属性。
//
// 属性只有两种且互斥：一个目录要么是照片目录，要么是漫画目录。
const DefaultMediaRootKind = "photo"

// NormalizeMediaRootKind 归一化目录属性；空值或非法值回落到默认属性。
func NormalizeMediaRootKind(value string) string {
	switch strings.TrimSpace(value) {
	case "photo", "comic":
		return strings.TrimSpace(value)
	default:
		return DefaultMediaRootKind
	}
}

// Config 后端总配置（YAML 字段保持 camelCase）。
//
// 媒体根只使用 `mediaRoots` 数组字段，避免多个配置入口产生歧义；
// 每个元素同时携带目录路径与它的内容属性。
type Config struct {
	MediaRoots      []MediaRoot `yaml:"mediaRoots"`
	Host            string      `yaml:"host"`
	Port            int         `yaml:"port"`
	AccessMode      string      `yaml:"accessMode"`
	AccessToken     string      `yaml:"accessToken" json:"-"`
	AllowOsOpen     bool        `yaml:"allowOsOpen"`
	CacheDir        string      `yaml:"cacheDir"`
	ThumbSizeW      int         `yaml:"thumbSizeW"`
	ThumbSizeH      int         `yaml:"thumbSizeH"`
	ThumbCacheSize  int         `yaml:"thumbCacheSize"`
	CacheMaxAgeDays int         `yaml:"cacheMaxAgeDays"`
	CacheMaxSizeMB  int64       `yaml:"cacheMaxSizeMB"`
	StaticDir       string      `yaml:"staticDir"`

	// FFmpegPath ffmpeg 可执行文件绝对路径。空 → 走 DefaultFFmpegPath。
	// 留空且 DefaultFFmpegPath 不存在 → 服务端抽帧关闭,视频封面仍由浏览器
	// 抽帧 + 上传(fallback 路径完整保留)。
	FFmpegPath string `yaml:"ffmpegPath"`

	// 扫描排除规则：详见 services.ExcludeConfig / services.DefaultExclude。
	//
	//   - SkipHidden (默认 true):跳过任何以 `.` 开头的子目录(.git / .cache / ...)
	//   - SystemFiles (内置白名单 + 用户追加):永远跳过的系统噪声文件
	//     (Thumbs.db / desktop.ini / .DS_Store 等)
	//   - ExcludePatterns:用户自定义 glob 模式列表,匹配单个目录/文件名
	//     (basename 粒度,不分跨层)。`*` / `?` 走 Go filepath.Match 语义。
	//
	// 这些规则在扫描时直接生效,无需重启;配置变更后下一次扫描就用新规则。
	SkipHidden      bool     `yaml:"skipHidden"`
	SkipHiddenSet   bool     `yaml:"-"` // YAML 显式提供标记(支持 false 覆盖)
	SystemFiles     []string `yaml:"systemFiles"`
	ExcludePatterns []string `yaml:"excludePatterns"`

}

// Roots 返回规范化后的所有媒体根目录（绝对路径、去空、去重、保序）。
//
// 永远返回非 nil 切片（避免下游 nil 检查）。
func (c *Config) Roots() []string {
	roots := c.NormalizedRoots()
	out := make([]string, 0, len(roots))
	for _, root := range roots {
		out = append(out, root.Path)
	}
	return out
}

// NormalizedRoots 返回规范化后的媒体根条目：路径绝对化、去空、去重、保序，
// 并为每个条目补齐内容属性（未写时用全局默认）。
//
// 去重按平台规则折叠大小写（Windows 忽略、其它平台区分），保留首次出现的写法。
func (c *Config) NormalizedRoots() []MediaRoot {
	result := make([]MediaRoot, 0, len(c.MediaRoots))
	seen := make(map[string]struct{}, len(c.MediaRoots))
	for _, root := range c.MediaRoots {
		path := strings.TrimSpace(root.Path)
		if path == "" {
			continue
		}
		absolute, err := filepath.Abs(path)
		if err != nil {
			// 保留无法绝对化的输入，让后续路径校验报告错误，不能静默漏掉一个根。
			absolute = filepath.Clean(path)
		}
		key := pathutil.RootKey(absolute)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, MediaRoot{
			Path: absolute,
			Kind: NormalizeMediaRootKind(root.Kind),
		})
	}
	return result
}

// RootKinds 返回「规范化根路径 → 内容属性」映射，供用途策略使用。
func (c *Config) RootKinds() map[string]string {
	kinds := make(map[string]string)
	for _, root := range c.NormalizedRoots() {
		kinds[root.Path] = root.Kind
	}
	return kinds
}

// Default 返回内置默认配置（缓存目录指向 CWD/.local-gallery）。
func Default() *Config {
	return &Config{
		MediaRoots:      []MediaRoot{{Path: filepath.Join(".", "media"), Kind: DefaultMediaRootKind}},
		Host:            "127.0.0.1",
		Port:            8080,
		AccessMode:      AccessModeLocal,
		AccessToken:     "",
		AllowOsOpen:     false,
		CacheDir:        filepath.Join(".", DefaultCacheDirName),
		ThumbSizeW:      320,
		ThumbSizeH:      350,
		ThumbCacheSize:  500,
		CacheMaxAgeDays: 30,
		CacheMaxSizeMB:  10240,
		StaticDir:       "dist",
		FFmpegPath:      DefaultFFmpegPath,
		// 排除规则默认值:跳隐藏目录 + 内置系统白名单
		// (Thumbs.db / desktop.ini / .DS_Store);用户可继续追加 patterns。
		// nil slice 序列化为 `[]` 在 PATCH 语义里就保留默认,无需特别处理。
		SkipHidden:      true,
		SystemFiles:     nil,
		ExcludePatterns: nil,
	}
}

// LoadFile 从 YAML 配置文件加载并覆盖默认配置。
// 文件不存在不视为错误；解析失败或字段类型错误视为错误。
func LoadFile(path string) (*Config, error) {
	cfg := Default()

	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return cfg, nil
		}
		return nil, fmt.Errorf("read config file: %w", err)
	}

	// 第一次解析：标准字段
	tmp := &Config{}
	decoder := yaml.NewDecoder(strings.NewReader(string(data)))
	decoder.KnownFields(true)
	if err := decoder.Decode(tmp); err != nil {
		return nil, fmt.Errorf("parse config file: %w", err)
	}

	// 第二次解析用于探测 skipHidden 是否显式给出。默认是 true，用户 YAML 里
	// 写 `skipHidden: false` 应当能关掉 —— 不能用「零值视为未配置」的
	// 简化约定(那只会让用户能开不能关)。
	raw := map[string]any{}
	if err := yaml.Unmarshal(data, &raw); err == nil {
		if _, ok := raw["skipHidden"]; ok {
			if b, ok := raw["skipHidden"].(bool); ok {
				tmp.SkipHiddenSet = true
				tmp.SkipHidden = b
			}
		}
	}

	mergeFile(cfg, tmp)
	if _, present := raw["cacheMaxSizeMB"]; present {
		cfg.CacheMaxSizeMB = tmp.CacheMaxSizeMB
	}
	if err := secureConfigFile(path); err != nil {
		return nil, fmt.Errorf("secure config file: %w", err)
	}
	return cfg, nil
}

// mergeFile 把 file 中显式值合并到 dst。零值字段保持 dst 默认。
//
// bool 字段特殊处理：YAML 未设置时为零值 false；只要 file 显式给出
// true 即视为开启，false 视为未配置（沿用 dst 默认）。
//
// MediaRoots 非 nil 表示 YAML 显式提供，空数组表示尚未配置媒体库。
func mergeFile(dst, file *Config) {
	if file.MediaRoots != nil {
		dst.MediaRoots = append([]MediaRoot(nil), file.MediaRoots...)
	}
	if file.Host != "" {
		dst.Host = file.Host
	}
	if file.Port != 0 {
		dst.Port = file.Port
	}
	if file.AccessMode != "" {
		dst.AccessMode = file.AccessMode
	}
	if file.AccessToken != "" {
		dst.AccessToken = file.AccessToken
	}
	if file.AllowOsOpen {
		dst.AllowOsOpen = true
	}
	if file.CacheDir != "" {
		dst.CacheDir = file.CacheDir
	}
	if file.ThumbSizeW != 0 {
		dst.ThumbSizeW = file.ThumbSizeW
	}
	if file.ThumbSizeH != 0 {
		dst.ThumbSizeH = file.ThumbSizeH
	}
	if file.CacheMaxAgeDays != 0 {
		dst.CacheMaxAgeDays = file.CacheMaxAgeDays
	}
	if file.ThumbCacheSize > 0 {
		dst.ThumbCacheSize = file.ThumbCacheSize
	}
	if file.StaticDir != "" {
		dst.StaticDir = file.StaticDir
	}
	// FFmpegPath:空串(用户没写)→保留 dst 的 DefaultFFmpegPath。
	// 显式空串仍然视为未配置,避免用户在 YAML 写 ffmpegPath: "" 时
	// 把默认路径"清空"。
	if file.FFmpegPath != "" {
		dst.FFmpegPath = file.FFmpegPath
	}
	// 排除规则:
	//   - SkipHidden 通过 SkipHiddenSet 显式覆盖(默认 true 也能被 false 覆盖)
	//   - SystemFiles / ExcludePatterns:非 nil 即替换(包含显式空数组 → 清空)
	if file.SkipHiddenSet {
		dst.SkipHidden = file.SkipHidden
	}
	if file.SystemFiles != nil {
		dst.SystemFiles = append([]string(nil), file.SystemFiles...)
	}
	if file.ExcludePatterns != nil {
		dst.ExcludePatterns = append([]string(nil), file.ExcludePatterns...)
	}
	// 内容属性随 mediaRoots 条目整体替换，无需单独合并。
}

// Validate 校验运行参数，不要求媒体目录在线；管理员仍可进入设置页修复目录。
func (c *Config) Validate() error {
	if c.Port <= 0 || c.Port > 65535 {
		return fmt.Errorf("invalid port %d", c.Port)
	}
	switch c.AccessMode {
	case AccessModeLocal:
	case AccessModeLAN:
		if len(c.AccessToken) < MinAccessTokenLength {
			return fmt.Errorf("accessToken must contain at least %d characters in lan mode", MinAccessTokenLength)
		}
		if len(c.AccessToken) > MaxAccessTokenLength {
			return fmt.Errorf("accessToken must contain at most %d characters in lan mode", MaxAccessTokenLength)
		}
		if strings.IndexFunc(c.AccessToken, func(r rune) bool {
			return unicode.IsSpace(r) || unicode.IsControl(r)
		}) >= 0 {
			return errors.New("accessToken must not contain whitespace or control characters")
		}
	default:
		return fmt.Errorf("invalid accessMode %q (must be %q or %q)", c.AccessMode, AccessModeLocal, AccessModeLAN)
	}
	if c.ThumbSizeW <= 0 || c.ThumbSizeH <= 0 {
		return errors.New("thumb size must be positive")
	}
	if c.CacheMaxSizeMB < 0 || c.CacheMaxSizeMB > 1048576 {
		return errors.New("cacheMaxSizeMB must be between 0 and 1048576")
	}
	for _, root := range c.MediaRoots {
		if root.Kind != "" && root.Kind != "photo" && root.Kind != "comic" {
			return fmt.Errorf("mediaRoots kind must be photo or comic (got %q)", root.Kind)
		}
	}
	return nil
}

// ValidateMediaRoots 仅在用户显式修改媒体根时检查可用性，避免误保存错别字。
// 空列表用于初始设置或主动清空；未修改根时离线磁盘不阻止其他设置保存。
func (c *Config) ValidateMediaRoots() error {
	for _, root := range c.Roots() {
		info, err := os.Stat(root)
		if err != nil || !info.IsDir() {
			return errors.New("media root is unavailable or is not a directory")
		}
	}
	return nil
}

// Addr 返回监听地址 host:port。
func (c *Config) Addr() string {
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}
