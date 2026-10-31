package services

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// 子进程模拟 ffprobe，记录实际启动次数；不依赖测试机上的媒体工具。
func TestMain(m *testing.M) {
	if os.Getenv("VIDEO_INFO_TEST_HELPER") == "1" {
		os.Exit(videoInfoProbeHelper())
	}
	os.Exit(m.Run())
}

func videoInfoProbeHelper() int {
	if len(os.Args) > 1 && os.Args[1] == "-version" {
		fmt.Println("test ffprobe")
		return 0
	}
	data, err := os.ReadFile(os.Getenv("VIDEO_INFO_TEST_OUTPUT"))
	if err != nil {
		return 1
	}
	log, err := os.OpenFile(os.Getenv("VIDEO_INFO_TEST_CALLS"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return 1
	}
	_, err = log.WriteString("probe\n")
	log.Close()
	if err != nil {
		return 1
	}
	if info, err := os.Stat(os.Args[len(os.Args)-1]); err != nil || !info.Mode().IsRegular() {
		return 1
	}
	if delay, _ := time.ParseDuration(os.Getenv("VIDEO_INFO_TEST_DELAY")); delay > 0 {
		time.Sleep(delay)
	}
	if gate := os.Getenv("VIDEO_INFO_TEST_GATE"); gate != "" {
		var output ffprobeOutput
		if err := json.Unmarshal(data, &output); err != nil || len(output.Streams) == 0 {
			return 1
		}
		path := filepath.Join(gate, strconv.Itoa(output.Streams[0].Width))
		deadline := time.Now().Add(3 * time.Second)
		for {
			if _, err := os.Stat(path); err == nil {
				break
			}
			if time.Now().After(deadline) {
				return 1
			}
			time.Sleep(time.Millisecond)
		}
	}
	_, err = os.Stdout.Write(data)
	if err != nil {
		return 1
	}
	return 0
}

type videoProbeFixture struct {
	service *VideoInfoService
	path    string
	output  string
	log     string
}

func newVideoProbeFixture(t *testing.T) videoProbeFixture {
	t.Helper()
	dir := t.TempDir()
	fixture := videoProbeFixture{
		path: filepath.Join(dir, "source.mp4"), output: filepath.Join(dir, "output.json"), log: filepath.Join(dir, "calls.log"),
	}
	if err := os.WriteFile(fixture.path, []byte("source"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixture.setWidth(t, 320)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("VIDEO_INFO_TEST_HELPER", "1")
	t.Setenv("VIDEO_INFO_TEST_OUTPUT", fixture.output)
	t.Setenv("VIDEO_INFO_TEST_CALLS", fixture.log)
	t.Setenv("VIDEO_INFO_TEST_DELAY", "")
	t.Setenv("VIDEO_INFO_TEST_GATE", "")
	fixture.service = NewVideoInfoService(VideoInfoOptions{FFprobePath: executable})
	return fixture
}

func (f videoProbeFixture) setWidth(t *testing.T, width int) {
	t.Helper()
	output := fmt.Sprintf(`{"streams":[{"codec_type":"video","codec_name":"h264","width":%d,"height":240}],"format":{"format_name":"mp4","duration":"2.0","bit_rate":"1024"}}`, width)
	if err := os.WriteFile(f.output, []byte(output), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (f videoProbeFixture) calls(t *testing.T) int {
	t.Helper()
	data, err := os.ReadFile(f.log)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return bytes.Count(data, []byte("\n"))
}

func TestVideoInfoRepeatedProbeIsCachedAndCopied(t *testing.T) {
	f := newVideoProbeFixture(t)
	first, err := f.service.Probe(f.path)
	if err != nil {
		t.Fatal(err)
	}
	first.Width = 999
	second, err := f.service.Probe(f.path)
	if err != nil {
		t.Fatal(err)
	}
	if second.Width != 320 || f.calls(t) != 1 {
		t.Fatalf("repeated query width=%d probe calls=%d", second.Width, f.calls(t))
	}
}

func TestVideoInfoConcurrentProbeSharesWork(t *testing.T) {
	f := newVideoProbeFixture(t)
	t.Setenv("VIDEO_INFO_TEST_DELAY", "40ms")
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if meta, err := f.service.Probe(f.path); err != nil || meta.Width != 320 {
				t.Error("concurrent probe failed")
			}
		}()
	}
	close(start)
	wg.Wait()
	if count := f.calls(t); count != 1 {
		t.Fatalf("external probe calls=%d want 1", count)
	}
}

func TestVideoInfoProbeInvalidatesFileFingerprint(t *testing.T) {
	for _, change := range []string{"size", "mtime"} {
		t.Run(change, func(t *testing.T) {
			f := newVideoProbeFixture(t)
			if _, err := f.service.Probe(f.path); err != nil {
				t.Fatal(err)
			}
			info, err := os.Stat(f.path)
			if err != nil {
				t.Fatal(err)
			}
			modified := info.ModTime()
			if change == "size" {
				if err := os.WriteFile(f.path, []byte("larger source"), 0o600); err != nil {
					t.Fatal(err)
				}
			} else {
				modified = modified.Add(time.Second)
			}
			if err := os.Chtimes(f.path, modified, modified); err != nil {
				t.Fatal(err)
			}
			f.setWidth(t, 640)
			for i := 0; i < 2; i++ {
				meta, err := f.service.Probe(f.path)
				if err != nil || meta.Width != 640 {
					t.Fatalf("changed file result=%+v err=%v", meta, err)
				}
			}
			if count := f.calls(t); count != 2 {
				t.Fatalf("probe calls=%d want 2", count)
			}
		})
	}
}

func TestVideoInfoProbeFailuresRemainRetriable(t *testing.T) {
	f := newVideoProbeFixture(t)
	if err := os.WriteFile(f.output, []byte("broken json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Probe(f.path); err == nil {
		t.Fatal("invalid probe output was accepted")
	}
	f.setWidth(t, 320)
	for i := 0; i < 2; i++ {
		if _, err := f.service.Probe(f.path); err != nil {
			t.Fatal("probe failure could not be retried")
		}
	}
	if count := f.calls(t); count != 2 {
		t.Fatalf("probe calls=%d want 2", count)
	}
}

func TestVideoInfoCachedSourceRemoved(t *testing.T) {
	f := newVideoProbeFixture(t)
	if _, err := f.service.Probe(f.path); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(f.path); err != nil {
		t.Fatal(err)
	}
	_, err := f.service.Probe(f.path)
	if err == nil || strings.Contains(err.Error(), f.path) {
		t.Fatal("removed source did not return a safe error")
	}
	if count := f.calls(t); count != 1 {
		t.Fatalf("removed file started another probe: %d", count)
	}
}

func waitVideoProbeCalls(t *testing.T, f videoProbeFixture, count int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for f.calls(t) < count {
		if time.Now().After(deadline) {
			t.Fatalf("probe did not start: want %d calls", count)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestVideoInfoClearCacheBlocksLateRefill(t *testing.T) {
	f := newVideoProbeFixture(t)
	gate := t.TempDir()
	t.Setenv("VIDEO_INFO_TEST_GATE", gate)
	f.setWidth(t, 10)
	type result struct {
		meta *VideoMetadata
		err  error
	}
	first, second := make(chan result, 1), make(chan result, 1)
	var wg sync.WaitGroup
	defer func() {
		os.WriteFile(filepath.Join(gate, "10"), nil, 0o600)
		os.WriteFile(filepath.Join(gate, "20"), nil, 0o600)
		wg.Wait()
	}()
	probe := func(channel chan<- result) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			meta, err := f.service.Probe(f.path)
			channel <- result{meta, err}
		}()
	}
	probe(first)
	waitVideoProbeCalls(t, f, 1)
	f.service.ClearCache()
	f.setWidth(t, 20)
	probe(second)
	waitVideoProbeCalls(t, f, 2)
	if err := os.WriteFile(filepath.Join(gate, "20"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	newer := <-second
	if newer.err != nil || newer.meta.Width != 20 {
		t.Fatal("new generation joined an old probe")
	}
	if err := os.WriteFile(filepath.Join(gate, "10"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	older := <-first
	if older.err != nil || older.meta.Width != 10 {
		t.Fatal("old probe did not finish independently")
	}
	current, err := f.service.Probe(f.path)
	if err != nil || current.Width != 20 || f.calls(t) != 2 {
		t.Fatal("old probe refilled the cleared cache")
	}
}

func TestVideoInfoClearCacheForcesFreshProbe(t *testing.T) {
	f := newVideoProbeFixture(t)
	if _, err := f.service.Probe(f.path); err != nil {
		t.Fatal(err)
	}
	f.setWidth(t, 640)
	f.service.ClearCache()
	meta, err := f.service.Probe(f.path)
	if err != nil || meta.Width != 640 || f.calls(t) != 2 {
		t.Fatal("cleared metadata remained cached")
	}
}
