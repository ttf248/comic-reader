package config

import "encoding/json"

// ConfigPatch 用于 Update() 的部分更新 payload。
//
// 每个字段配一个 "Set" 标记：true 表示"显式提供"，false 表示"未提供"。
// 这样 PATCH 接口可以正确区分"用户清空字段"和"用户没动这个字段"。
// bool 字段尤其需要这个机制（默认 false 不能区分 unset / explicit false）。
//
// MediaRoots 用数组替换语义：显式空数组 `[]` 表示"用户清空所有根"，
// 未提供字段表示"不修改"；区分通过 MediaRootsSet 实现。
type ConfigPatch struct {
	CacheMaxSizeMB     int64      `json:"cacheMaxSizeMB,omitempty"`
	CacheMaxSizeMBSet  bool       `json:"-"`
	MediaRoots         []MediaRoot `json:"mediaRoots,omitempty"`
	MediaRootsSet      bool       `json:"-"`
	Host               string   `json:"host,omitempty"`
	HostSet            bool     `json:"-"`
	Port               int      `json:"port,omitempty"`
	PortSet            bool     `json:"-"`
	AccessMode         string   `json:"accessMode,omitempty"`
	AccessModeSet      bool     `json:"-"`
	AccessToken        string   `json:"accessToken,omitempty"`
	AccessTokenSet     bool     `json:"-"`
	CacheDir           string   `json:"cacheDir,omitempty"`
	CacheDirSet        bool     `json:"-"`
	ThumbCacheSize     int      `json:"thumbCacheSize,omitempty"`
	ThumbCacheSizeSet  bool     `json:"-"`
	CacheMaxAgeDays    int      `json:"cacheMaxAgeDays,omitempty"`
	CacheMaxAgeDaysSet bool     `json:"-"`
	AllowOsOpen        bool     `json:"allowOsOpen,omitempty"`
	AllowOsOpenSet     bool     `json:"-"`
	StaticDir          string   `json:"staticDir,omitempty"`
	StaticDirSet       bool     `json:"-"`
	FFmpegPath         string   `json:"ffmpegPath,omitempty"`
	FFmpegPathSet      bool     `json:"-"`

	// 排除规则:SkipHidden 走 Set 标记(默认 true,允许 false 覆盖);
	// SystemFiles / ExcludePatterns 用数组替换语义(显式空数组 = 清空)。
	SkipHidden         bool     `json:"skipHidden,omitempty"`
	SkipHiddenSet      bool     `json:"-"`
	SystemFiles        []string `json:"systemFiles,omitempty"`
	SystemFilesSet     bool     `json:"-"`
	ExcludePatterns    []string `json:"excludePatterns,omitempty"`
	ExcludePatternsSet bool     `json:"-"`
}

// DefaultsPatch 返回一个所有 Set 标志为 false 的空 patch（用于"读"语义）。
func DefaultsPatch() ConfigPatch {
	return ConfigPatch{}
}

// UnmarshalJSON 自定义反序列化：基于 raw 字段存在性来设置对应的 Set 标志。
// 这样前端可发送 {"allowOsOpen": false} 并被识别为"显式关闭"。
func (p *ConfigPatch) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	type plain ConfigPatch
	var pp plain
	if err := json.Unmarshal(data, &pp); err != nil {
		return err
	}
	*p = ConfigPatch(pp)
	if _, ok := raw["mediaRoots"]; ok {
		p.MediaRootsSet = true
	}
	if _, ok := raw["host"]; ok {
		p.HostSet = true
	}
	if _, ok := raw["port"]; ok {
		p.PortSet = true
	}
	if _, ok := raw["accessMode"]; ok {
		p.AccessModeSet = true
	}
	if _, ok := raw["accessToken"]; ok {
		p.AccessTokenSet = true
	}
	if _, ok := raw["cacheDir"]; ok {
		p.CacheDirSet = true
	}
	if _, ok := raw["thumbCacheSize"]; ok {
		p.ThumbCacheSizeSet = true
	}
	if _, ok := raw["cacheMaxAgeDays"]; ok {
		p.CacheMaxAgeDaysSet = true
	}
	if _, ok := raw["cacheMaxSizeMB"]; ok {
		p.CacheMaxSizeMBSet = true
	}
	if _, ok := raw["allowOsOpen"]; ok {
		p.AllowOsOpenSet = true
	}
	if _, ok := raw["staticDir"]; ok {
		p.StaticDirSet = true
	}
	if _, ok := raw["ffmpegPath"]; ok {
		p.FFmpegPathSet = true
	}
	if _, ok := raw["skipHidden"]; ok {
		p.SkipHiddenSet = true
	}
	if _, ok := raw["systemFiles"]; ok {
		p.SystemFilesSet = true
	}
	if _, ok := raw["excludePatterns"]; ok {
		p.ExcludePatternsSet = true
	}
	return nil
}
