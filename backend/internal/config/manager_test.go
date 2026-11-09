package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func writeValidYAML(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	// 准备一个真实存在的 mediaRoots（避免 Validate 失败）
	root := filepath.Join(dir, "media")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	// 用 filepath.Join 替换占位符，使 root 一定存在
	content = "mediaRoots:\n  - path: \"" + filepath.ToSlash(root) + "\"\n    kind: photo\n" + content
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestNewManager_LoadFromFile(t *testing.T) {
	path := writeValidYAML(t, "port: 9999\n")
	mgr, err := NewManager(path)
	if err != nil {
		t.Fatal(err)
	}
	cfg := mgr.Get()
	if cfg.Port != 9999 {
		t.Errorf("port=%d want 9999", cfg.Port)
	}
	if mgr.Path() != path {
		t.Errorf("path=%q want %q", mgr.Path(), path)
	}
}

func TestManager_Update_Persists(t *testing.T) {
	path := writeValidYAML(t, "")
	mgr, err := NewManager(path)
	if err != nil {
		t.Fatal(err)
	}

	restart, err := mgr.Update(ConfigPatch{
		Port:           8888,
		PortSet:        true,
		AllowOsOpen:    true,
		AllowOsOpenSet: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(restart) != 1 || restart[0] != "port" {
		t.Errorf("requiresRestart=%v want [port]", restart)
	}

	cfg := mgr.Get()
	if cfg.Port != 8888 {
		t.Errorf("port=%d", cfg.Port)
	}
	if !cfg.AllowOsOpen {
		t.Errorf("allowOsOpen should be true")
	}

	// 文件应已落盘
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(data, "port: 8888") {
		t.Errorf("file should contain port: 8888, got: %s", data)
	}
	if !contains(data, "allowOsOpen: true") {
		t.Errorf("file should contain allowOsOpen: true, got: %s", data)
	}
}

func TestManager_Update_AllowOsOpenFalse(t *testing.T) {
	path := writeValidYAML(t, "allowOsOpen: true\n")
	mgr, err := NewManager(path)
	if err != nil {
		t.Fatal(err)
	}
	if !mgr.Get().AllowOsOpen {
		t.Fatal("setup: should be true")
	}

	_, err = mgr.Update(ConfigPatch{
		AllowOsOpen:    false,
		AllowOsOpenSet: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if mgr.Get().AllowOsOpen {
		t.Error("allowOsOpen should be false after explicit PATCH false")
	}
}

func TestManager_Update_AccessConfiguration(t *testing.T) {
	path := writeValidYAML(t, "")
	mgr, err := NewManager(path)
	if err != nil {
		t.Fatal(err)
	}

	restart, err := mgr.Update(ConfigPatch{
		AccessMode:     AccessModeLAN,
		AccessModeSet:  true,
		AccessToken:    "0123456789abcdef0123456789abcdef",
		AccessTokenSet: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(restart) != 0 {
		t.Fatalf("access configuration should hot-update, requiresRestart=%v", restart)
	}
	got := mgr.Get()
	if got.AccessMode != AccessModeLAN || got.AccessToken != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("access config not applied: mode=%q tokenLength=%d", got.AccessMode, len(got.AccessToken))
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(data, "accessMode: \"lan\"") || !contains(data, "accessToken: \"0123456789abcdef0123456789abcdef\"") {
		t.Fatalf("access config not persisted: %s", data)
	}
}

func TestManager_Update_RejectsLANWithoutStrongToken(t *testing.T) {
	path := writeValidYAML(t, "")
	mgr, err := NewManager(path)
	if err != nil {
		t.Fatal(err)
	}

	_, err = mgr.Update(ConfigPatch{AccessMode: AccessModeLAN, AccessModeSet: true})
	if err == nil {
		t.Fatal("expected lan mode without token to be rejected")
	}
	if mgr.Get().AccessMode != AccessModeLocal {
		t.Fatal("invalid update must not mutate current config")
	}
}

func TestManager_Update_RejectsInvalid(t *testing.T) {
	path := writeValidYAML(t, "")
	mgr, err := NewManager(path)
	if err != nil {
		t.Fatal(err)
	}
	// 把 Port 改成非法值
	_, err = mgr.Update(ConfigPatch{
		Port:    70000,
		PortSet: true,
	})
	if err == nil {
		t.Error("expected validation error")
	}
	// 内存应未变
	if mgr.Get().Port == 70000 {
		t.Error("port should not be applied on validation failure")
	}
}

func TestManager_Update_SerializesConcurrentPatches(t *testing.T) {
	for attempt := 0; attempt < 64; attempt++ {
		cfg := Default()
		cfg.MediaRoots = []MediaRoot{{Path: t.TempDir(), Kind: DefaultMediaRootKind}}
		cfg.AccessMode = AccessModeLAN
		cfg.AccessToken = "0123456789abcdef0123456789abcdef"
		mgr := NewManagerWith(cfg, "")

		start := make(chan struct{})
		errs := make(chan error, 2)
		go func() {
			<-start
			_, err := mgr.Update(ConfigPatch{
				AccessToken:    "fedcba9876543210fedcba9876543210",
				AccessTokenSet: true,
			})
			errs <- err
		}()
		go func() {
			<-start
			_, err := mgr.Update(ConfigPatch{
				ThumbCacheSize: 640,
				ThumbCacheSizeSet: true,
			})
			errs <- err
		}()
		close(start)

		for range 2 {
			if err := <-errs; err != nil {
				t.Fatal(err)
			}
		}
		got := mgr.Get()
		if got.AccessToken != "fedcba9876543210fedcba9876543210" || got.ThumbCacheSize != 640 {
			t.Fatalf("concurrent update lost at attempt %d: token=%q thumbCacheSize=%d", attempt, got.AccessToken, got.ThumbCacheSize)
		}
	}
}

func TestManager_Update_MediaRoot(t *testing.T) {
	path := writeValidYAML(t, "")
	mgr, err := NewManager(path)
	if err != nil {
		t.Fatal(err)
	}
	newRoot := filepath.Join(t.TempDir(), "new")
	if err := os.MkdirAll(newRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	_, err = mgr.Update(ConfigPatch{
		MediaRoots:    []MediaRoot{{Path: newRoot, Kind: DefaultMediaRootKind}},
		MediaRootsSet: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg := mgr.Get()
	if got := cfg.Roots(); len(got) != 1 || got[0] != newRoot {
		t.Errorf("media roots=%q want [%q]", got, newRoot)
	}
}

func TestManagerOfflineRootCanBeRepaired(t *testing.T) {
	cfg := Default()
	cfg.MediaRoots = []MediaRoot{{Path: filepath.Join(t.TempDir(), "offline"), Kind: DefaultMediaRootKind}}
	mgr := NewManagerWith(cfg, filepath.Join(t.TempDir(), "config.yaml"))
	if err := cfg.Validate(); err != nil {
		t.Fatalf("offline root blocks startup: %v", err)
	}
	if _, err := mgr.Update(ConfigPatch{ThumbCacheSize: 640, ThumbCacheSizeSet: true}); err != nil {
		t.Fatalf("offline root blocks unrelated settings: %v", err)
	}
	if _, err := mgr.Update(ConfigPatch{MediaRoots: cfg.MediaRoots, MediaRootsSet: true}); err == nil {
		t.Fatal("explicitly saving an unavailable root should fail")
	}
	if _, err := mgr.Update(ConfigPatch{MediaRoots: []MediaRoot{{Path: t.TempDir(), Kind: DefaultMediaRootKind}}, MediaRootsSet: true}); err != nil {
		t.Fatalf("repair root: %v", err)
	}
	if _, err := mgr.Update(ConfigPatch{MediaRoots: []MediaRoot{}, MediaRootsSet: true}); err != nil {
		t.Fatalf("clear roots for setup: %v", err)
	}
	if err := mgr.Reload(); err != nil {
		t.Fatal(err)
	}
	if len(mgr.Roots()) != 0 {
		t.Fatal("empty root configuration did not persist")
	}
}

// 多根 PATCH：传入数组应整体替换。
func TestManager_Update_MediaRootsMulti(t *testing.T) {
	path := writeValidYAML(t, "")
	mgr, err := NewManager(path)
	if err != nil {
		t.Fatal(err)
	}
	root1 := filepath.Join(t.TempDir(), "r1")
	root2 := filepath.Join(t.TempDir(), "r2")
	for _, r := range []string{root1, root2} {
		if err := os.MkdirAll(r, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	_, err = mgr.Update(ConfigPatch{
		MediaRoots:    []MediaRoot{{Path: root1, Kind: DefaultMediaRootKind}, {Path: root2, Kind: DefaultMediaRootKind}},
		MediaRootsSet: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	roots := mgr.Roots()
	if len(roots) != 2 {
		t.Fatalf("expected 2 roots, got %d (%v)", len(roots), roots)
	}
	if roots[0] != root1 || roots[1] != root2 {
		t.Errorf("roots order: %v", roots)
	}
}

func TestManager_Update_NotifiesSubscribers(t *testing.T) {
	path := writeValidYAML(t, "")
	mgr, err := NewManager(path)
	if err != nil {
		t.Fatal(err)
	}
	var (
		mu      sync.Mutex
		calls   int
		lastCfg *Config
		done    = make(chan struct{})
	)
	_ = mgr.OnChange("test", func(s *Config) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		lastCfg = s
		close(done)
	})
	defer func() {
		// 防 close 重复
		mu.Lock()
		defer mu.Unlock()
	}()

	_, err = mgr.Update(ConfigPatch{
		ThumbCacheSize:    200,
		ThumbCacheSizeSet: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	// listener 按配置提交顺序同步派发；channel 仍用于断言确已调用。
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("subscriber not called within 2s")
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Errorf("calls=%d want 1", calls)
	}
	if lastCfg == nil || lastCfg.ThumbCacheSize != 200 {
		t.Errorf("lastCfg.ThumbCacheSize=%v", lastCfg)
	}
}

func TestManager_Update_Unsubscribe(t *testing.T) {
	path := writeValidYAML(t, "")
	mgr, err := NewManager(path)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	cancel := mgr.OnChange("u", func(s *Config) { calls++ })
	cancel()

	if _, err := mgr.Update(ConfigPatch{Port: 7777, PortSet: true}); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Errorf("calls=%d want 0 after unsubscribe", calls)
	}
}

func TestManager_GetReturnsCopy(t *testing.T) {
	path := writeValidYAML(t, "")
	mgr, _ := NewManager(path)
	a := mgr.Get()
	a.Port = 1234
	b := mgr.Get()
	if b.Port == 1234 {
		t.Error("Get() should return a copy")
	}
}

func TestDiffRequiresRestartKeepsServiceGraphsConsistent(t *testing.T) {
	base := Default()
	tests := []struct {
		name   string
		mutate func(*Config)
		want   string
	}{
		{name: "cache directory", mutate: func(c *Config) { c.CacheDir = "other-cache" }, want: "cacheDir"},
		{name: "ffmpeg path", mutate: func(c *Config) { c.FFmpegPath = "other-ffmpeg" }, want: "ffmpegPath"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			changed := cloneConfig(base)
			tc.mutate(changed)
			got := diffRequiresRestart(base, changed)
			if len(got) != 1 || got[0] != tc.want {
				t.Fatalf("diffRequiresRestart=%v, want [%s]", got, tc.want)
			}
		})
	}

	hot := cloneConfig(base)
	hot.ThumbCacheSize++
	hot.CacheMaxAgeDays++
	hot.AllowOsOpen = !hot.AllowOsOpen
	hot.AccessMode = AccessModeLAN
	hot.AccessToken = "0123456789abcdef0123456789abcdef"
	if got := diffRequiresRestart(base, hot); len(got) != 0 {
		t.Fatalf("hot fields unexpectedly require restart: %v", got)
	}
}

func TestConfigPatch_UnmarshalJSON(t *testing.T) {
	// 显式 false
	var p ConfigPatch
	if err := json.Unmarshal([]byte(`{"allowOsOpen":false}`), &p); err != nil {
		t.Fatal(err)
	}
	if !p.AllowOsOpenSet {
		t.Error("AllowOsOpenSet should be true")
	}
	if p.AllowOsOpen {
		t.Error("AllowOsOpen should be false")
	}

	// 完全不提供
	p = ConfigPatch{}
	if err := json.Unmarshal([]byte(`{"port":1234}`), &p); err != nil {
		t.Fatal(err)
	}
	if p.AllowOsOpenSet {
		t.Error("AllowOsOpenSet should be false when field not in JSON")
	}
	if !p.PortSet || p.Port != 1234 {
		t.Error("port not picked up")
	}

	p = ConfigPatch{}
	if err := json.Unmarshal([]byte(`{"accessMode":"lan","accessToken":"0123456789abcdef0123456789abcdef"}`), &p); err != nil {
		t.Fatal(err)
	}
	if !p.AccessModeSet || p.AccessMode != AccessModeLAN || !p.AccessTokenSet {
		t.Fatalf("access patch not picked up: %+v", p)
	}
}

func contains(haystack []byte, needle string) bool {
	return len(haystack) == 0 && needle == "" ||
		(len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0)
}

func indexOf(b []byte, s string) int {
	n := len(s)
	for i := 0; i+n <= len(b); i++ {
		if string(b[i:i+n]) == s {
			return i
		}
	}
	return -1
}
