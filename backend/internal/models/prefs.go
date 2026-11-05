package models

import (
	"strings"
	"time"
	"unicode"
)

// HistoryEntry 单条最近访问记录。
type HistoryEntry struct {
	AlbumID    string    `json:"albumId"`
	Name       string    `json:"name"`
	ImageCount int       `json:"imageCount"`
	OpenedAt   time.Time `json:"openedAt"`
}

// Prefs 用户偏好（持久化在服务端 &lt;cacheDir&gt;/web_settings.json）。
//
// 字段语义对齐原桌面应用：
//   - Favorites：收藏的资源 ID 列表（相册 / 集合 / smart:<tag>）
//   - History：最近访问（LRU，上限 MaxRecent）
//   - Theme：light / dark / system
//   - AutoSwitchAlbum：画廊末尾自动跳到下个相册
//   - ShowSwitchNotif：跨相册切换时显示通知
//   - AppMode：上次使用的工作台（photo / comic）
type Prefs struct {
	Favorites        []string       `json:"favorites"`
	History          []HistoryEntry `json:"history"`
	MaxRecent        int            `json:"maxRecent"`
	AutoSwitchAlbum  bool           `json:"autoSwitchAlbum"`
	ShowSwitchNotif  bool           `json:"showSwitchNotif"`
	Theme            string         `json:"theme"`
	SidebarCollapsed bool           `json:"sidebarCollapsed"`
	// AppMode 是上次使用的工作台。它决定进入应用根路径时落到照片侧还是
	// 漫画侧；当前在看哪一侧由前端路由决定，不从这里读。
	AppMode AppMode `json:"appMode"`
}

// IsAlbumID 校验公共相册 ID 的稳定格式：a_ + 16 字节哈希的 base64url。
func IsAlbumID(value string) bool {
	return isOpaqueResourceID(value, "a_")
}

// IsFavoriteResourceID 校验收藏可接受的相册、集合或智能标签 ID。
func IsFavoriteResourceID(value string) bool {
	if IsAlbumID(value) || isOpaqueResourceID(value, "c_") {
		return true
	}
	if !strings.HasPrefix(value, "smart:") {
		return false
	}
	tag := strings.TrimPrefix(value, "smart:")
	if tag == "" || len(tag) > 256 || strings.ContainsAny(tag, `/\`) {
		return false
	}
	for _, r := range tag {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func isOpaqueResourceID(value, prefix string) bool {
	if len(value) != len(prefix)+22 || !strings.HasPrefix(value, prefix) {
		return false
	}
	for _, r := range value[len(prefix):] {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return false
	}
	return true
}

// DefaultPrefs 返回默认偏好。
func DefaultPrefs() Prefs {
	return Prefs{
		Favorites:        []string{},
		History:          []HistoryEntry{},
		MaxRecent:        10,
		AutoSwitchAlbum:  true,
		ShowSwitchNotif:  true,
		Theme:            "system",
		SidebarCollapsed: false,
		AppMode:          DefaultAppMode,
	}
}
