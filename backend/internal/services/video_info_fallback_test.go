package services

import (
	"context"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseFFmpegInfoOutput(t *testing.T) {
	cases := []struct {
		name   string
		output string
		want   VideoMetadata
	}{
		{
			name:   "mp4 profiles and color fields",
			output: "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'sample.mp4':\n  Duration: 01:02:03.45, start: 0.000000, bitrate: 1500 kb/s\n  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 25 fps\n",
			want:   VideoMetadata{Width: 1920, Height: 1080, DurationSec: 3723.45, Codec: "h264", Container: "mov,mp4,m4a,3gp,3g2,mj2", BitRate: 1500000},
		},
		{
			name:   "webm audio before video",
			output: "Input #0, matroska,webm, from 'sample.webm':\r\n  Duration: 00:00:02.50, start: 0.000000, bitrate: 1.5 Mb/s\r\n  Stream #0:0: Audio: opus, 48000 Hz, stereo\r\n  Stream #0:1: Video: vp9, yuv420p, 640x360, 25 fps\r\n",
			want:   VideoMetadata{Width: 640, Height: 360, DurationSec: 2.5, Codec: "vp9", Container: "matroska,webm", BitRate: 1500000},
		},
		{
			name:   "unknown duration",
			output: "Input #0, mpegts, from 'sample.ts':\n  Duration: N/A, start: 0.000000, bitrate: N/A\n  Stream #0:0: Video: hevc (Main 10), yuv420p10le, 3840x2160, 25 fps\n",
			want:   VideoMetadata{Width: 3840, Height: 2160, Codec: "hevc", Container: "mpegts"},
		},
		{
			name:   "audio only",
			output: "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'sample.mp4':\n  Duration: 00:00:03.10, start: 0.000000, bitrate: 192 kb/s\n  Stream #0:0: Audio: aac, 48000 Hz, stereo\n",
			want:   VideoMetadata{DurationSec: 3.1, Container: "mov,mp4,m4a,3gp,3g2,mj2", BitRate: 192000},
		},
		{
			name:   "metadata tags do not override streams",
			output: "Input #0, matroska,webm, from 'sample.webm':\n    title: Video: fake, 1x2\n    comment: bitrate: 99999 kb/s\n  Duration: 00:00:01.25, start: 0.000000, bitrate: 800 kb/s\n  Stream #0:0: Video: vp8, yuv420p, 320x240, 25 fps\n  Stream #0:1: Video: mjpeg, yuvj420p, 10x10\n",
			want:   VideoMetadata{Width: 320, Height: 240, DurationSec: 1.25, Codec: "vp8", Container: "matroska,webm", BitRate: 800000},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseFFmpegInfoOutput(tc.output)
			if err != nil {
				t.Fatal(err)
			}
			if got.Width != tc.want.Width || got.Height != tc.want.Height || got.Codec != tc.want.Codec || got.Container != tc.want.Container || got.BitRate != tc.want.BitRate || math.Abs(got.DurationSec-tc.want.DurationSec) > 1e-8 {
				t.Fatalf("got %+v want %+v", *got, tc.want)
			}
		})
	}
}

func TestParseFFmpegInfoOutputRejectsMissingMetadata(t *testing.T) {
	for _, output := range []string{"Error opening input file: private/source.mp4", "Input #0, mp4, from 'private/source.mp4':\n  Duration: NaN:00:00, bitrate: NaN kb/s"} {
		meta, err := parseFFmpegInfoOutput(output)
		if err == nil || meta != nil || strings.Contains(err.Error(), "private") {
			t.Fatalf("unsafe result=%+v err=%v", meta, err)
		}
	}
}

func TestVideoInfoServiceOnlyFFmpegAvailable(t *testing.T) {
	ffmpeg := findFFmpeg(t)
	path := generateTestVideo(t, ffmpeg)
	primary := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ffmpeg})
	want, err := primary.Probe(path)
	if err != nil {
		t.Fatal(err)
	}
	fallback := NewVideoInfoService(VideoInfoOptions{FFmpegPath: ffmpeg, FFprobePath: filepath.Join(t.TempDir(), "missing-ffprobe")})
	if !fallback.Available() {
		t.Error("metadata fallback was disabled even though ffmpeg works")
	}
	got, err := fallback.Probe(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.Width != want.Width || got.Height != want.Height || got.Codec != want.Codec || got.Container != want.Container || math.Abs(got.DurationSec-want.DurationSec) > 0.02 || math.Abs(float64(got.BitRate-want.BitRate)) > 1000 {
		t.Fatalf("fallback=%+v primary=%+v", *got, *want)
	}
}

func TestVideoInfoFallbackTimeoutDoesNotCachePartialOutput(t *testing.T) {
	f := newVideoProbeFixture(t)
	output := "Input #0, mp4, from 'sample.mp4':\n  Duration: 00:00:02.00, bitrate: 100 kb/s\n  Stream #0:0: Video: h264, yuv420p, 320x240\n"
	if err := os.WriteFile(f.output, []byte(output), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VIDEO_INFO_TEST_DELAY", "2s")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	svc := NewVideoInfoService(VideoInfoOptions{FFmpegPath: executable, FFprobePath: filepath.Join(t.TempDir(), "missing-ffprobe"), Timeout: 100 * time.Millisecond})
	meta, err := svc.Probe(f.path)
	if meta != nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("partial timeout was accepted: %+v %v", meta, err)
	}
}

func TestVideoInfoAvailabilityCheckIsBounded(t *testing.T) {
	f := newVideoProbeFixture(t)
	t.Setenv("VIDEO_INFO_TEST_VERSION_DELAY", "2s")
	svc := NewVideoInfoService(VideoInfoOptions{FFprobePath: f.service.FFprobePath(), Timeout: 100 * time.Millisecond})
	started := time.Now()
	if svc.Available() {
		t.Fatal("timed out tool was marked available")
	}
	if time.Since(started) > time.Second {
		t.Fatal("tool availability check ignored timeout")
	}
}

func TestVideoInfoProbeIgnoresNonFiniteNumericFields(t *testing.T) {
	f := newVideoProbeFixture(t)
	output := `{"streams":[{"codec_type":"video","codec_name":"h264","width":320,"height":240}],"format":{"format_name":"mp4","duration":"NaN","bit_rate":"1e300"}}`
	if err := os.WriteFile(f.output, []byte(output), 0o600); err != nil {
		t.Fatal(err)
	}
	meta, err := f.service.Probe(f.path)
	if err != nil || meta.DurationSec != 0 || meta.BitRate != 0 {
		t.Fatalf("unsafe numeric fields: %+v %v", meta, err)
	}
}
