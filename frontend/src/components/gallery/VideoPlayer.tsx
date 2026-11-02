import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  videoUrl,
  createVideoPlaybackId,
  getTranscodeStatus,
  type TranscodeStatus,
} from "../../api/videos";
import TranscodeProgress from "./TranscodeProgress";
import { shouldIgnoreShortcut } from "../../utils/shortcuts";

interface Props {
  /** 当前播放的不透明视频文件 ID */
  src: string;
  /** 进度变化回调（防抖由父组件处理；以秒为单位） */
  onProgress?: (currentTimeSec: number) => void;
  /** 视频元数据加载完成回调（用于父组件恢复进度） */
  onMetaLoaded?: (durationSec: number) => void;
  /** 每个 src 只恢复一次的初始播放位置（秒） */
  initialPositionSec?: number;
  /** 视频自然结束（ended=true）时触发 */
  onEnded?: () => void;
  /** 父组件传入的额外 className（用于容器布局） */
  className?: string;
}

/**
 * 视频播放器（v1 极简版）。
 *
 * 包装原生 <video controls>，做三件事：
 *  1) 键盘：空格 = 播放/暂停，← / → = ±5s，↑ / ↓ = 音量 ±10%
 *  2) 进度上报：timeupdate 触发 onProgress(currentTimeSec)
 *  3) 元数据：loadedmetadata 触发 onMetaLoaded(durationSec)
 *
 * 服务端转码集成 (Phase 2):
 *   - mount 时查 /api/videos/transcode/status
 *   - 如果需要转码 (running/queued)，显示 TranscodeProgress 覆盖层
 *   - 转码完成 (cached) 时强制重挂 <video>，让浏览器重新请求
 *   - 失败 / 不可用 → 显示原有错误覆盖层
 *
 * 故意不做：
 *  - 自定义控件（用浏览器原生 controls，未来可替换为自绘）
 *  - 倍速 / 字幕 / 画中画（依赖浏览器原生能力即可）
 *  - 缩略图 scrub（v2）
 */
export default function VideoPlayer({
  src,
  onProgress,
  onMetaLoaded,
  initialPositionSec,
  onEnded,
  className,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const restoredSourceRef = useRef<string | null>(null);
  // 空格键按下后应用期望的暂停状态（null = 本次空格不由应用处理）。
  // 用于抵消浏览器在 keyup 阶段的原生播放/暂停切换。
  const spacePausedRef = useRef<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const mediaURL = useMemo(
    () => videoUrl(src, `${createVideoPlaybackId()}-${retryKey}`),
    [src, retryKey],
  );
  const [transcodeStatus, setTranscodeStatus] =
    useState<TranscodeStatus | null>(null);

  // 切到下一个视频时清状态
  useEffect(() => {
    setError(null);
    setTranscodeStatus(null);
    restoredSourceRef.current = null;
  }, [src]);

  const restorePosition = useCallback(
    (video: HTMLVideoElement | null) => {
      const restoreKey = `${src}#${retryKey}`;
      if (!video || restoredSourceRef.current === restoreKey) return;
      if (
        initialPositionSec === undefined ||
        !Number.isFinite(initialPositionSec) ||
        initialPositionSec <= 0 ||
        !Number.isFinite(video.duration) ||
        video.duration <= 0
      ) {
        return;
      }
      // 不定位到精确片尾，否则某些浏览器会立即触发 ended。
      video.currentTime = Math.min(
        initialPositionSec,
        Math.max(0, video.duration - 0.1),
      );
      restoredSourceRef.current = restoreKey;
    },
    [initialPositionSec, retryKey, src],
  );

  // 活动查询通常晚于 loadedmetadata，因此 prop 到达时也要尝试恢复。
  useEffect(() => {
    restorePosition(videoRef.current);
  }, [restorePosition, retryKey]);

  // 查服务端转码状态
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    getTranscodeStatus(src)
      .then((s) => {
        if (cancelled) return;
        setTranscodeStatus(s);
      })
      .catch(() => {
        // status 端点失败 → 当作"无转码服务",不影响播放
        if (!cancelled) setTranscodeStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [src, retryKey]);

  // 键盘控制
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || shouldIgnoreShortcut(e)) return;
      const v = videoRef.current;
      if (!v) return;
      switch (e.key) {
        case " ":
        case "k":
        case "K":
          e.preventDefault();
          {
            const nextPaused = !v.paused;
            if (e.key === " ") spacePausedRef.current = nextPaused;
            if (nextPaused) v.pause();
            else v.play().catch(() => {});
          }
          break;
        case "ArrowLeft":
          e.preventDefault();
          v.currentTime = Math.max(0, v.currentTime - 5);
          break;
        case "ArrowRight":
          e.preventDefault();
          v.currentTime = Math.min(
            v.duration || v.currentTime + 5,
            v.currentTime + 5,
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          v.volume = Math.min(1, v.volume + 0.1);
          break;
        case "ArrowDown":
          e.preventDefault();
          v.volume = Math.max(0, v.volume - 0.1);
          break;
        case "m":
        case "M":
          e.preventDefault();
          v.muted = !v.muted;
          break;
        // 'F11' / 'f' / 全屏由 GalleryHeader 顶层处理；此处不重复
      }
    };
    // 焦点落在 <video> 上时，浏览器还有一套原生键盘行为：空格在 keyup
    // 阶段会再切换一次播放/暂停（激活行为，无法用 preventDefault 取消）。
    // 应用在 keydown 已经切换过，两次叠加等于没切换 —— 表现为"点过视频
    // 之后按空格没反应"。所以这里记下应用期望的状态，等 keyup 之后把
    // 原生那次切换抵消掉。
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " ") return;
      const expected = spacePausedRef.current;
      if (expected === null) return;
      spacePausedRef.current = null;
      const v = videoRef.current;
      if (!v || v.paused === expected) return;
      if (expected) v.pause();
      else v.play().catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // 把 HTMLMediaElement 的 MediaError 翻译成对人友好的中文消息。
  //
  // 常见码（详见 https://developer.mozilla.org/docs/Web/API/MediaError/code）：
  //   1 MEDIA_ERR_ABORTED        - 用户中止（一般不应弹错）
  //   2 MEDIA_ERR_NETWORK        - 网络错误（断网/超时/Range 失败）
  //   3 MEDIA_ERR_DECODE         - 解码错误（编码/容器损坏，或浏览器 codec 不支持）
  //   4 MEDIA_ERR_SRC_NOT_SUPPORTED - 资源不支持（404/CORS/MIME 错/浏览器不支持该编码）
  function describeError(media: HTMLVideoElement | null): string {
    const err = media?.error;
    if (!err) return "视频加载失败";
    switch (err.code) {
      case 1:
        return "播放已中止";
      case 2:
        return "视频加载失败（网络错误：可能是断网、Range 请求失败或服务器无响应）";
      case 3:
        return "视频解码失败（编码或容器不被当前浏览器支持；常见于 AV1 / H.265 / 非 faststart MP4）";
      case 4:
        return "视频加载失败（资源不可用：文件不存在、CORS 被拒、MIME 不匹配，或浏览器不支持该编码）";
      default:
        return "视频加载失败";
    }
  }

  // 是否在转码中？展示 TranscodeProgress 覆盖层
  //
  // pending 也算：视频需要转码但任务还没起来（转码由媒体请求触发）。
  // 这时直接放行会让 <video> 报解码失败，用户只看到一句"加载失败"，
  // 看不到真正的原因——正在转码。
  const isTranscoding =
    transcodeStatus !== null &&
    (transcodeStatus.status === "running" ||
      transcodeStatus.status === "queued" ||
      transcodeStatus.status === "pending" ||
      transcodeStatus.status === "failed");

  return (
    <div
      className={
        className ??
        "relative flex-1 flex items-center justify-center min-h-0 bg-black"
      }
    >
      <video
        ref={videoRef}
        key={
          `${src}#${retryKey}` /* 切视频 / 手动重试时强制重挂载，避免 src 缓存问题 */
        }
        src={mediaURL}
        controls
        autoPlay
        playsInline
        // poster 用 thumbnail 缓存（首次访问可能 404 + code=video_cover_missing，
        // 浏览器对此静默处理，poster 显示空白；不阻断视频）
        className="max-w-full max-h-full outline-none"
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          restorePosition(v);
          if (Number.isFinite(v.duration) && v.duration > 0) {
            onMetaLoaded?.(v.duration);
          }
        }}
        onTimeUpdate={(e) => {
          // 每秒最多 4 次（timeupdate 浏览器自己会 throttle），对 UI 足够
          onProgress?.(e.currentTarget.currentTime);
        }}
        onEnded={() => {
          onEnded?.();
        }}
        onError={(e) => {
          setError(describeError(e.currentTarget));
        }}
      />
      {/* 转码进度覆盖层（仅在转码中显示）*/}
      {isTranscoding && (
        <TranscodeProgress
          src={src}
          onReady={() => {
            // 转码完成:刷新状态 + 重挂 <video> 让浏览器重新请求
            setTranscodeStatus({
              ...transcodeStatus,
              status: "cached",
              progress: 1,
            });
            setError(null);
            setRetryKey((k) => k + 1);
          }}
        />
      )}
      {/* 错误覆盖层（仅在没在转码时显示;转码失败时由 TranscodeProgress 接管）*/}
      {error && !isTranscoding && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="max-w-md mx-4 bg-black/80 text-white/90 text-sm px-4 py-3 rounded-md flex flex-col items-center gap-2 text-center">
            <div>{error}</div>
            <button
              type="button"
              className="pointer-events-auto text-[12.5px] px-2 py-1 rounded border border-white/30 hover:bg-white/10"
              onClick={() => {
                setError(null);
                setRetryKey((k) => k + 1);
              }}
            >
              重试
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
