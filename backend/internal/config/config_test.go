package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestCacheCapacityExplicitZeroSurvivesReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("cacheMaxSizeMB: 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadFile(path)
	if err != nil || cfg.CacheMaxSizeMB != 0 {
		t.Fatalf("capacity=%v err=%v", cfg, err)
	}
	if Default().CacheMaxSizeMB != 10240 {
		t.Fatal("unexpected default budget")
	}
}

// writeTempYAML 写入临时 YAML 配置文件并返回路径。
func writeTempYAML(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write temp config: %v", err)
	}
	return path
}

func TestDefault(t *testing.T) {
	d := Default()
	if len(d.Roots()) == 0 {
		t.Error("default MediaRoots must not be empty")
	}
	if d.Port <= 0 || d.Port > 65535 {
		t.Errorf("default Port out of range: %d", d.Port)
	}
	if d.CacheMaxAgeDays <= 0 {
		t.Error("default cache max age must be positive")
	}
	if filepath.Base(d.CacheDir) != DefaultCacheDirName {
		t.Errorf("default CacheDir must end with %q, got %q",
			DefaultCacheDirName, d.CacheDir)
	}
	if d.StaticDir == "" {
		t.Error("default StaticDir must not be empty")
	}
	if d.AccessMode != AccessModeLocal {
		t.Errorf("default AccessMode=%q want %q", d.AccessMode, AccessModeLocal)
	}
	if d.AccessToken != "" {
		t.Error("default AccessToken must be empty")
	}
}

func TestConfigJSONNeverContainsAccessToken(t *testing.T) {
	cfg := Default()
	cfg.AccessToken = "must-not-be-serialized"
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), cfg.AccessToken) || strings.Contains(string(data), "AccessToken") {
		t.Fatalf("JSON leaked access token: %s", data)
	}
}

func TestLoadFile_MissingReturnsDefault(t *testing.T) {
	cfg, err := LoadFile(filepath.Join(t.TempDir(), "nope.yaml"))
	if err != nil {
		t.Fatalf("LoadFile should not error on missing file, got: %v", err)
	}
	d := Default()
	if got, want := cfg.Roots(), d.Roots(); !slices.Equal(got, want) {
		t.Errorf("expected default media roots %q, got %q", want, got)
	}
}

func TestLoadFile_OverridesDefaults(t *testing.T) {
	path := writeTempYAML(t, `
mediaRoots:
  - path: 'D:\photos'
    kind: photo
port: 9090
accessMode: lan
accessToken: 0123456789abcdef0123456789abcdef
allowOsOpen: true
cacheDir: D:\custom-cache
staticDir: build/web
`)

	cfg, err := LoadFile(path)
	if err != nil {
		t.Fatalf("LoadFile: %v", err)
	}
	wantRoot, err := filepath.Abs("D:\\photos")
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Roots(); len(got) != 1 || got[0] != wantRoot {
		t.Errorf("mediaRoots: got %q", got)
	}
	if cfg.Port != 9090 {
		t.Errorf("port: got %d", cfg.Port)
	}
	if cfg.AccessMode != AccessModeLAN || cfg.AccessToken != "0123456789abcdef0123456789abcdef" {
		t.Errorf("access configuration was not loaded")
	}
	if !cfg.AllowOsOpen {
		t.Error("allowOsOpen should be true from file")
	}
	if cfg.CacheDir != "D:\\custom-cache" {
		t.Errorf("cacheDir: got %q", cfg.CacheDir)
	}
	if cfg.StaticDir != "build/web" {
		t.Errorf("staticDir: got %q", cfg.StaticDir)
	}
}

func TestLoadFile_RejectsRemovedRootAliases(t *testing.T) {
	path := writeTempYAML(t, `
comicRoot: D:\legacy
port: 7070
`)

	if _, err := LoadFile(path); err == nil {
		t.Error("expected removed comicRoot field to be rejected")
	}
}

func TestLoadFile_PartialOverrides(t *testing.T) {
	// 只覆盖一个字段，其余应保持 Default()
	path := writeTempYAML(t, `port: 9090`)

	cfg, err := LoadFile(path)
	if err != nil {
		t.Fatalf("LoadFile: %v", err)
	}
	if cfg.Port != 9090 {
		t.Errorf("port: got %d", cfg.Port)
	}
	d := Default()
	if cfg.Host != d.Host {
		t.Errorf("host should keep default, got %q", cfg.Host)
	}
}

func TestLoadFile_InvalidYAML(t *testing.T) {
	path := writeTempYAML(t, `port: "not closed`)
	_, err := LoadFile(path)
	if err == nil {
		t.Error("expected error on invalid YAML")
	}
}

func TestValidate(t *testing.T) {
	dir := t.TempDir()

	cases := []struct {
		name    string
		mutate  func(c *Config)
		wantErr bool
	}{
		{"empty_root", func(c *Config) { c.MediaRoots = nil }, false},
		{"missing_root", func(c *Config) { c.MediaRoots = []MediaRoot{{Path: filepath.Join(dir, "nope"), Kind: DefaultMediaRootKind}} }, false},
		{"file_not_dir", func(c *Config) {
			f := filepath.Join(dir, "f.txt")
			os.WriteFile(f, []byte("x"), 0o644)
			c.MediaRoots = []MediaRoot{{Path: f, Kind: DefaultMediaRootKind}}
		}, false},
		{"bad_port_low", func(c *Config) { c.Port = 0 }, true},
		{"bad_port_high", func(c *Config) { c.Port = 70000 }, true},
		{"bad_access_mode", func(c *Config) { c.AccessMode = "public" }, true},
		{"lan_without_token", func(c *Config) { c.AccessMode = AccessModeLAN }, true},
		{"lan_short_token", func(c *Config) {
			c.AccessMode = AccessModeLAN
			c.AccessToken = "too-short"
		}, true},
		{"lan_token_with_whitespace", func(c *Config) {
			c.AccessMode = AccessModeLAN
			c.AccessToken = "0123456789abcdef 123456789abcdef0"
		}, true},
		{"lan_token_too_long", func(c *Config) {
			c.AccessMode = AccessModeLAN
			c.AccessToken = strings.Repeat("x", MaxAccessTokenLength+1)
		}, true},
		{"lan_with_strong_token", func(c *Config) {
			c.AccessMode = AccessModeLAN
			c.AccessToken = "0123456789abcdef0123456789abcdef"
			c.MediaRoots = []MediaRoot{{Path: dir, Kind: DefaultMediaRootKind}}
		}, false},
		{"bad_root_kind", func(c *Config) {
			c.MediaRoots = []MediaRoot{{Path: dir, Kind: "manga"}}
		}, true},
		{"ok", func(c *Config) { c.MediaRoots = []MediaRoot{{Path: dir, Kind: DefaultMediaRootKind}} }, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := Default()
			tc.mutate(cfg)
			err := cfg.Validate()
			if tc.wantErr && err == nil {
				t.Errorf("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Errorf("unexpected error: %v", err)
			}
		})
	}
}

func TestAddr(t *testing.T) {
	c := &Config{Host: "127.0.0.1", Port: 9090}
	if got := c.Addr(); got != "127.0.0.1:9090" {
		t.Errorf("Addr: got %q", got)
	}
}

// 旧写法（媒体根只写一个路径字符串）必须报错，而不是被悄悄当成照片目录：
// 属性要显式写出来，否则用户以为自己在看照片，实际目录被归到了别处。
func TestLoadFile_LegacyRootStringIsRejected(t *testing.T) {
	path := writeTempYAML(t, `
mediaRoots:
  - 'D:\photos'
`)
	_, err := LoadFile(path)
	if err == nil {
		t.Fatal("legacy mediaRoots string should be rejected")
	}
	if !strings.Contains(err.Error(), "kind") {
		t.Fatalf("错误信息应指向新写法, got: %v", err)
	}
}

// 属性只有照片与漫画两种；非法值在归一化时回落到默认属性。
func TestNormalizeMediaRootKind(t *testing.T) {
	cases := map[string]string{
		"photo": "photo",
		"comic": "comic",
		" manga": "photo",
		"":      "photo",
	}
	for input, want := range cases {
		if got := NormalizeMediaRootKind(input); got != want {
			t.Errorf("NormalizeMediaRootKind(%q)=%q want %q", input, got, want)
		}
	}
}

func TestEmptyRootDoesNotBecomeWorkingDirectory(t *testing.T) {
	cfg := Default()
	cfg.MediaRoots = []MediaRoot{
		{Path: "", Kind: DefaultMediaRootKind},
		{Path: " ", Kind: DefaultMediaRootKind},
		{Path: "\t", Kind: DefaultMediaRootKind},
	}
	if roots := cfg.Roots(); len(roots) != 0 {
		t.Fatalf("blank roots resolved to a directory: %v", roots)
	}
}

// 默认缓存目录应使用 .local-gallery；不依赖环境变量。
func TestDefault_CacheDirIsRuntimeRelative(t *testing.T) {
	cfg := Default()
	if filepath.Base(cfg.CacheDir) != DefaultCacheDirName {
		t.Errorf("CacheDir must end with %q, got %q",
			DefaultCacheDirName, cfg.CacheDir)
	}
}
