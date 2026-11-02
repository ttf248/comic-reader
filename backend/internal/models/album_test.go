package models

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestIsImageFile(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		// 正例
		{"a.jpg", true},
		{"a.JPG", true},
		{"a.jpeg", true},
		{"a.png", true},
		{"a.PNG", true},
		{"a.gif", true},
		{"a.bmp", true},
		{"a.webp", true},
		{"a.tiff", true},
		{"a.tif", true},
		{"page-001.jpg", true},
		// iPhone 照片
		{"IMG_0001.heic", true},
		{"IMG_0001.HEIC", true},
		{"photo.heif", true},
		{"photo.HEIF", true},
		// 反例
		{"a.txt", false},
		{"a", false},
		{".jpg", false},
		{"", false},
		{"noext", false},
		{"a.tar.gz", false},
		{"a.mp4", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsImageFile(tc.name); got != tc.want {
				t.Errorf("IsImageFile(%q) = %v, want %v", tc.name, got, tc.want)
			}
		})
	}
}

func TestLowerExt(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"a.JPG", ".jpg"},
		{"page.Png", ".png"},
		{"no.ext.here", ".here"},
		{"noext", ""},
	}
	for _, tc := range cases {
		if got := lowerExt(tc.in); got != tc.want {
			t.Errorf("lowerExt(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestAlbumMarshalJSON_UsesCurrentMediaKeysOnly(t *testing.T) {
	a := Album{
		Type:       "album",
		Path:       "E:/p/a",
		Name:       "a",
		ImageFiles: []string{"E:/p/a/1.jpg", "E:/p/a/2.jpg"},
		ImageCount: 2,
		ModTime:    time.Now(),
	}
	raw, err := json.Marshal(a)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(raw)
	for _, key := range []string{`"imageFiles"`, `"videoFiles"`, `"imageCount"`} {
		if !strings.Contains(s, key) {
			t.Errorf("Album JSON 缺少键 %s：%s", key, s)
		}
	}
	for _, legacyKey := range []string{`"files"`, `"fileCount"`} {
		if strings.Contains(s, legacyKey) {
			t.Errorf("Album JSON 不应输出旧键 %s：%s", legacyKey, s)
		}
	}
	if !strings.Contains(s, `"E:/p/a/1.jpg"`) || !strings.Contains(s, `"E:/p/a/2.jpg"`) {
		t.Errorf("Album JSON 未正确输出文件列表：%s", s)
	}
}

func TestScanResultMarshalJSON_UsesRootsOnly(t *testing.T) {
	r := ScanResult{
		Roots:           []string{"E:/p"},
		Albums:          []Album{{Type: "album", Path: "E:/p/a", Name: "a", ImageCount: 3}},
		AlbumCount:      1,
		CollectionCount: 0,
		ScannedAt:       time.Now(),
	}
	raw, err := json.Marshal(r)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(raw)
	for _, key := range []string{`"roots"`, `"albums"`, `"albumCount"`} {
		if !strings.Contains(s, key) {
			t.Errorf("ScanResult JSON 缺少键 %s：%s", key, s)
		}
	}
}

// TestAlbumMarshalJSON_NilSlices 验证当前媒体列表始终输出 []。
func TestAlbumMarshalJSON_NilSlices(t *testing.T) {
	a := Album{Type: "album", Path: "E:/p/a", Name: "a", ImageCount: 0}
	raw, err := json.Marshal(a)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(raw)
	if strings.Contains(s, `"imageFiles":null`) || strings.Contains(s, `"videoFiles":null`) {
		t.Errorf("nil 切片未转为 []：%s", s)
	}
	if !strings.Contains(s, `"imageFiles":[]`) || !strings.Contains(s, `"videoFiles":[]`) {
		t.Errorf("Album JSON 缺少空数组：%s", s)
	}

	// Collection / SmartCollection 同理
	c := Collection{Type: "collection", Path: "E:/p/c", Name: "c"}
	raw, _ = json.Marshal(c)
	if strings.Contains(string(raw), `"albums":null`) {
		t.Errorf("Collection nil albums 未转为 []：%s", string(raw))
	}
	sc := SmartCollection{Type: "smartCollection", Tag: "t"}
	raw, _ = json.Marshal(sc)
	s = string(raw)
	if strings.Contains(s, `"albums":null`) || strings.Contains(s, `"tags":null`) {
		t.Errorf("SmartCollection nil slices 未转为 []：%s", s)
	}
}

func TestAlbumJSONRoundTrip(t *testing.T) {
	original := Album{
		Type:       "album",
		Path:       "E:/p/a",
		Name:       "a",
		ImageFiles: []string{"E:/p/a/1.jpg", "E:/p/a/2.jpg"},
		ImageCount: 2,
	}
	raw, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var loaded Album
	if err := json.Unmarshal(raw, &loaded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(loaded.ImageFiles) != 2 {
		t.Errorf("Unmarshal 后 ImageFiles 数量 = %d, want 2", len(loaded.ImageFiles))
	}
	if loaded.ImageFiles[0] != "E:/p/a/1.jpg" || loaded.ImageFiles[1] != "E:/p/a/2.jpg" {
		t.Errorf("Unmarshal 后 ImageFiles 内容错：%v", loaded.ImageFiles)
	}

	current := []byte(`{"type":"album","path":"E:/p/current","name":"current","imageFiles":["x.jpg"]}`)
	var decoded Album
	if err := json.Unmarshal(current, &decoded); err != nil {
		t.Fatalf("current unmarshal: %v", err)
	}
	if len(decoded.ImageFiles) != 1 || decoded.ImageFiles[0] != "x.jpg" {
		t.Errorf("current Unmarshal 后 ImageFiles = %v", decoded.ImageFiles)
	}
}

// TestIsVideoFile 验证常见视频扩展名识别 + 大小写不敏感。
func TestIsVideoFile(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		// 正例
		{"a.mp4", true},
		{"a.MP4", true},
		{"a.webm", true},
		{"a.mov", true},
		{"a.mkv", true},
		{"a.avi", true},
		{"a.m4v", true},
		{"rec-2026-08-20.m4v", true},
		// 反例：图片/文本/无扩展名
		{"a.jpg", false},
		{"a.txt", false},
		{"a", false},
		{"noext", false},
		{"", false},
		{"a.mp3", false}, // 音频
		{"a.mp4.txt", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsVideoFile(tc.name); got != tc.want {
				t.Errorf("IsVideoFile(%q) = %v, want %v", tc.name, got, tc.want)
			}
		})
	}
}

// TestAlbumMarshalVideoFields 验证 VideoFiles / videoCount / coverKind
// 都正确序列化。
func TestAlbumMarshalVideoFields(t *testing.T) {
	a := Album{
		Type:       "album",
		Path:       "E:/p/v",
		Name:       "v",
		VideoFiles: []string{"E:/p/v/clip.mp4", "E:/p/v/clip2.mkv"},
		VideoCount: 2,
		CoverKind:  "video",
		CoverImage: "E:/p/v/clip.mp4",
	}
	raw, err := json.Marshal(a)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(raw)
	for _, key := range []string{`"videoFiles"`, `"videoCount":2`, `"coverKind":"video"`, `"coverImage":"E:/p/v/clip.mp4"`} {
		if !strings.Contains(s, key) {
			t.Errorf("Album JSON 缺少 %q：%s", key, s)
		}
	}
	// nil VideoFiles 也序列化为 []
	empty := Album{Type: "album", Path: "E:/p/x", Name: "x"}
	raw2, _ := json.Marshal(empty)
	if strings.Contains(string(raw2), `"videoFiles":null`) {
		t.Errorf("nil VideoFiles 未转为 []：%s", string(raw2))
	}
}

// TestAlbumUnmarshalVideoFields 验证 cache 读回时 VideoFiles 不丢。
func TestAlbumUnmarshalVideoFields(t *testing.T) {
	raw := []byte(`{
		"type":"album","path":"E:/p/v","name":"v",
		"videoFiles":["E:/p/v/a.mp4","E:/p/v/b.mkv"],
		"videoCount":2,"coverKind":"video"
	}`)
	var a Album
	if err := json.Unmarshal(raw, &a); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(a.VideoFiles) != 2 {
		t.Fatalf("VideoFiles = %v, want 2 items", a.VideoFiles)
	}
	if a.VideoFiles[0] != "E:/p/v/a.mp4" || a.VideoFiles[1] != "E:/p/v/b.mkv" {
		t.Errorf("VideoFiles 内容错：%v", a.VideoFiles)
	}
	if a.CoverKind != "video" {
		t.Errorf("CoverKind = %q, want video", a.CoverKind)
	}
	if a.VideoCount != 2 {
		t.Errorf("VideoCount = %d, want 2", a.VideoCount)
	}

	// 旧 cache 完全没有 video 字段时也不报错
	legacy := []byte(`{"type":"album","path":"E:/p/old","name":"old","imageFiles":["x.jpg"]}`)
	var old Album
	if err := json.Unmarshal(legacy, &old); err != nil {
		t.Fatalf("legacy unmarshal: %v", err)
	}
	if len(old.VideoFiles) != 0 {
		t.Errorf("legacy VideoFiles 应为零值, got %v", old.VideoFiles)
	}
}

// TestNeedsBrowserConversion 验证只有浏览器解不了的格式才需要服务端转换。
func TestNeedsBrowserConversion(t *testing.T) {
	convert := []string{"a.heic", "a.HEIC", "b.heif", "c.tif", "d.TIFF"}
	for _, name := range convert {
		if !NeedsBrowserConversion(name) {
			t.Errorf("%s 应需要转换", name)
		}
	}
	keep := []string{"a.jpg", "b.PNG", "c.gif", "d.webp", "e.mp4", "f"}
	for _, name := range keep {
		if NeedsBrowserConversion(name) {
			t.Errorf("%s 不应需要转换", name)
		}
	}
}
