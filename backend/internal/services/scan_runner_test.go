package services

import (
	"context"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

func TestOfflineScanKeepsPublishedSnapshot(t *testing.T) {
	root := t.TempDir()
	cache := NewScanResultCache(filepath.Join(t.TempDir(), "scan.json"))
	previous := &models.ScanResult{Roots: []string{root}, AlbumCount: 7}
	cache.Set(previous)
	runner := NewAsyncScanRunner()
	runner.SetCache(cache)
	t.Cleanup(func() { _ = runner.Shutdown(context.Background()) })
	_, events, err := startSubscribedScan(t, runner, ScanOptions{Roots: []string{root, filepath.Join(root, "offline")}})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.After(5 * time.Second)
	for {
		select {
		case event, ok := <-events:
			if !ok {
				t.Fatal("scan ended without failure event")
			}
			if event.Status == ScanStatusError {
				if got := cache.Get(); got == nil || got.AlbumCount != 7 {
					t.Fatal("failed scan replaced previous snapshot")
				}
				return
			}
		case <-deadline:
			t.Fatal("scan timed out")
		}
	}
}

func TestBlankScanRootsNeverSelectWorkingDirectory(t *testing.T) {
	if roots := (ScanOptions{Roots: []string{"", " ", "\t"}}).effectiveRoots(); len(roots) != 0 {
		t.Fatalf("blank roots selected working directory: %v", roots)
	}
}

func TestAsyncScanRunnerReuseDoesNotCreateUnownedSubscriptions(t *testing.T) {
	runner := NewAsyncScanRunner()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	state := &ScanState{ID: "scan-owned", Ctx: ctx, Cancel: cancel, Status: ScanStatusRunning, subs: make(map[chan ProgressEvent]struct{})}
	runner.states[state.ID] = state
	runner.activeID = state.ID
	id, reused, err := runner.StartOrReuse(ScanOptions{Roots: []string{t.TempDir()}})
	if err != nil || !reused || id != state.ID {
		t.Fatalf("reuse: id=%q reused=%v err=%v", id, reused, err)
	}
	if len(state.subs) != 0 {
		t.Fatalf("starting a scan created %d subscriptions without an owner", len(state.subs))
	}
}

func TestAsyncScanRunnerSubscriptionsHaveIndependentOwners(t *testing.T) {
	runner := NewAsyncScanRunner()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	state := &ScanState{ID: "scan-owned", Ctx: ctx, Cancel: cancel, Status: ScanStatusRunning, subs: make(map[chan ProgressEvent]struct{})}
	state.lastEvent = ProgressEvent{ScanID: state.ID, Status: ScanStatusRunning}
	runner.states[state.ID] = state
	first, releaseFirst, ok := runner.Subscribe(state.ID)
	if !ok {
		t.Fatal("first subscription unavailable")
	}
	defer releaseFirst()
	second, releaseSecond, ok := runner.Subscribe(state.ID)
	if !ok {
		t.Fatal("second subscription unavailable")
	}
	defer releaseSecond()
	<-first
	<-second
	releaseFirst()
	if _, open := <-first; open {
		t.Fatal("released subscription is still open")
	}
	if ctx.Err() != nil {
		t.Fatal("releasing a subscriber cancelled the scan")
	}
	runner.publish(state, ProgressEvent{ScanID: state.ID, Status: ScanStatusRunning, Progress: 17})
	if event := <-second; event.Progress != 17 {
		t.Fatalf("remaining subscriber lost progress: %+v", event)
	}
	releaseSecond()
	releaseSecond()
	if len(state.subs) != 0 {
		t.Fatalf("released subscriptions retained: %d", len(state.subs))
	}
}

func TestAsyncScanRunner_HappyPath(t *testing.T) {
	root := t.TempDir()
	mkdirAll(t, filepathJoin(root, "album1"))
	touchAll(t, filepathJoin(root, "album1", "1.jpg"))
	mkdirAll(t, filepathJoin(root, "album2"))
	touchAll(t, filepathJoin(root, "album2", "1.png"))

	runner := NewAsyncScanRunner()
	id, events, err := startSubscribedScan(t, runner, ScanOptions{Roots: []string{root}})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if id == "" {
		t.Fatal("scan id should not be empty")
	}

	var (
		sawRunning  bool
		completeEv  *ProgressEvent
		totalEvents int
	)

	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				goto done
			}
			totalEvents++
			if ev.Status == ScanStatusRunning {
				sawRunning = true
			}
			if ev.Status == ScanStatusComplete {
				ce := ev
				completeEv = &ce
				goto done
			}
		case <-deadline:
			t.Fatal("scan timed out")
		}
	}
done:

	if !sawRunning && totalEvents > 1 {
		t.Errorf("expected at least one running event before complete")
	}
	if completeEv == nil {
		t.Fatal("never received complete event")
	}
	if completeEv.AlbumsFound != 2 {
		t.Errorf("albums found: got %d, want 2", completeEv.AlbumsFound)
	}

	// Result 可获取
	res := runner.Result(id)
	if res == nil {
		t.Fatal("Result should be available after complete")
	}
	if res.AlbumCount != 2 {
		t.Errorf("album count: got %d", res.AlbumCount)
	}
}

func TestAsyncScanRunner_Cancel(t *testing.T) {
	root := t.TempDir()
	// 创建足够多的相册让扫描有耗时
	for i := 0; i < 500; i++ {
		dir := filepathJoin(root, "album-"+itoa(i))
		mkdirAll(t, dir)
		touchAll(t, filepathJoin(dir, "1.jpg"))
	}

	runner := NewAsyncScanRunner()
	id, events, err := startSubscribedScan(t, runner, ScanOptions{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
	}

	// 立即取消；取消必须贯穿扫描器，不能在后台继续跑完并发布 complete。
	if !runner.Cancel(id) {
		t.Fatal("Cancel returned false")
	}

	deadline := time.After(5 * time.Second)
	var sawCancelled, sawComplete bool
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				goto check
			}
			if ev.Status == ScanStatusCancelled {
				sawCancelled = true
				goto check
			}
			if ev.Status == ScanStatusComplete {
				sawComplete = true
				goto check
			}
		case <-deadline:
			t.Fatal("scan should have finished (cancelled or complete) within timeout")
		}
	}
check:
	if !sawCancelled || sawComplete {
		t.Fatalf("cancelled=%v complete=%v", sawCancelled, sawComplete)
	}
	runner.Wait(id)
	if got := runner.Get(id); got == nil || got.Status != ScanStatusCancelled || got.Result != nil {
		t.Fatalf("state after cancel=%+v", got)
	}
}

func TestAsyncScanRunner_ReusesActiveScanAndBroadcasts(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 300; i++ {
		dir := filepathJoin(root, "album-"+itoa(i))
		mkdirAll(t, dir)
		touchAll(t, filepathJoin(dir, "1.jpg"))
	}
	runner := NewAsyncScanRunner()
	id1, reused1, err := runner.StartOrReuse(ScanOptions{Roots: []string{root}})
	if err != nil || reused1 {
		t.Fatalf("first start reused=%v err=%v", reused1, err)
	}
	id2, reused2, err := runner.StartOrReuse(ScanOptions{Roots: []string{root}})
	if err != nil || !reused2 || id1 != id2 {
		t.Fatalf("second start id=%q reused=%v err=%v", id2, reused2, err)
	}
	events1, release1, ok := runner.Subscribe(id1)
	if !ok {
		t.Fatal("first subscription unavailable")
	}
	defer release1()
	events2, release2, ok := runner.Subscribe(id2)
	if !ok {
		t.Fatal("second subscription unavailable")
	}
	defer release2()

	for index, events := range []<-chan ProgressEvent{events1, events2} {
		deadline := time.After(5 * time.Second)
		for {
			select {
			case event, ok := <-events:
				if !ok {
					t.Fatalf("subscriber %d closed before terminal event", index)
				}
				if event.Status == ScanStatusComplete {
					goto nextSubscriber
				}
			case <-deadline:
				t.Fatalf("subscriber %d timed out", index)
			}
		}
	nextSubscriber:
	}
}

func TestAsyncScanRunner_DoesNotBlockWithoutEventConsumer(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 200; i++ {
		dir := filepathJoin(root, "album-"+itoa(i))
		mkdirAll(t, dir)
		touchAll(t, filepathJoin(dir, "1.jpg"))
	}
	runner := NewAsyncScanRunner()
	id, _, err := runner.StartOrReuse(ScanOptions{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		runner.Wait(id)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("scan blocked because nobody consumed progress events")
	}
}

func TestAsyncScanRunner_MissingRoot(t *testing.T) {
	runner := NewAsyncScanRunner()
	_, _, err := runner.StartOrReuse(ScanOptions{Roots: nil})
	if err == nil {
		t.Error("expected error for empty root")
	}
}

func TestAsyncScanRunner_CancelUnknown(t *testing.T) {
	runner := NewAsyncScanRunner()
	if runner.Cancel("nope") {
		t.Error("cancel of unknown id should return false")
	}
}

func TestAsyncScanRunner_GetUnknown(t *testing.T) {
	runner := NewAsyncScanRunner()
	if runner.Get("nope") != nil {
		t.Error("Get of unknown id should return nil")
	}
}

func TestAsyncScanRunner_ShutdownCancelsAndRejectsNewScans(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 500; i++ {
		dir := filepathJoin(root, "album-"+itoa(i))
		mkdirAll(t, dir)
		touchAll(t, filepathJoin(dir, "1.jpg"))
	}
	runner := NewAsyncScanRunner()
	id, _, err := runner.StartOrReuse(ScanOptions{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := runner.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	state := runner.Get(id)
	if state == nil || state.Status != ScanStatusCancelled {
		t.Fatalf("state after shutdown=%+v", state)
	}
	if _, _, err := runner.StartOrReuse(ScanOptions{Roots: []string{root}}); err == nil {
		t.Fatal("StartOrReuse should reject new scans after shutdown")
	}
}

func TestAsyncScanRunner_InvalidatePreventsOldLibraryRevival(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 300; i++ {
		dir := filepathJoin(root, "album-"+itoa(i))
		mkdirAll(t, dir)
		touchAll(t, filepathJoin(dir, "1.jpg"))
	}
	catalog := NewResourceCatalog()
	cache := NewScanResultCache(filepathJoin(t.TempDir(), "scan.json"))
	runner := NewAsyncScanRunner()
	runner.SetCatalog(catalog)
	runner.SetCache(cache)
	id, _, err := runner.StartOrReuse(ScanOptions{Roots: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	runner.Invalidate()
	runner.Wait(id)

	state := runner.Get(id)
	if state == nil || state.Status != ScanStatusCancelled {
		t.Fatalf("state=%+v, want cancelled", state)
	}
	if catalog.Ready() || cache.Get() != nil {
		t.Fatal("invalidated scan republished an obsolete library")
	}
}

func startSubscribedScan(t *testing.T, runner *AsyncScanRunner, opts ScanOptions) (string, <-chan ProgressEvent, error) {
	t.Helper()
	id, _, err := runner.StartOrReuse(opts)
	if err != nil {
		return "", nil, err
	}
	events, release, ok := runner.Subscribe(id)
	if !ok {
		t.Fatal("new scan subscription unavailable")
	}
	t.Cleanup(release)
	return id, events, nil
}

// helpers（避免引入 strconv/filepath 到测试包根）
func filepathJoin(parts ...string) string {
	return filepath.Join(parts...)
}

func itoa(n int) string {
	return strconv.Itoa(n)
}
