import { useCallback, useEffect, useRef, useState } from "react";
import { thumbUrl, uploadVideoCover } from "../api/thumbs";

// 视频封面状态机：
//   idle      — 未启动
//   loading   — 正在检查后端是否已有缓存封面（HEAD）
//   missing   — 后端无封面(ffmpeg 也抽不到,需要降级到浏览器抽帧)
//   extracting— 正在 <video>+canvas 抽帧 + POST(仅 ffmpeg 不可用时走)
//   ready     — 封面已就绪（命中缓存 / 上传成功 / 服务端 ffmpeg 已生成）
//   error     — 抽帧失败（用户可在 UI 触发重试）
export type VideoCoverStatus =
  "idle" | "loading" | "missing" | "extracting" | "ready" | "error";

interface Options {
  /** 状态变化时回调（父组件可据此显示 spinner / 错误提示） */
  onStatusChange?: (status: VideoCoverStatus) => void;
}

interface Result {
  status: VideoCoverStatus;
  /** 给 <img src=...> 用的稳定 URL，由服务端缓存头重新验证实际封面。 */
  url: string;
  /** 手动重试（用于 UI 上的"重试"按钮）。 */
  retry: () => void;
  /** 当前为视频（path 非空） */
  enabled: boolean;
}

const SEEK_RATIO = 0.1; // 抽帧位置 = duration * 10%（太靠前常是黑屏）
const SEEK_MIN = 1.0; // 最少 1s，避免取到片头黑场
const SEEK_MAX = 3.0; // 最多 3s，避免长片抽过开场
const FRAME_MAX_W = 1920; // canvas 导出最大宽（防止超大视频爆内存）

// 服务端 ffmpeg 抽帧通常 < 500ms 就能拿到首字节;给个 1.5s 轮询窗口。
// 真实情况更常见的是 50-200ms(head 探测 + 服务端生成 + 返回)，
// 因此这里用较短的轮询间隔让用户更快看到封面。
const SERVER_POLL_INITIAL_MS = 200;
const SERVER_POLL_MAX_MS = 1500;
const SERVER_POLL_TIMEOUT_MS = 20_000;

/**
 * 视频封面状态管理 hook。
 *
 * v2 流程（服务端有 ffmpeg 时）:
 *   1) 挂载时 HEAD 探测 /api/thumbs/:fileId
 *   2) 200 → ready (秒出)
 *   3) 404 → 短轮询重试 HEAD;超时仍未命中 → missing/extracting，改由浏览器抽帧
 *   4) 网络错误或其他 HTTP 失败 → error，可由用户重试
 *
 * 浏览器抽帧流程（服务端无 ffmpeg 时）:
 *   1) HEAD 404 → extracting
 *   2) <video>+canvas 抽帧 + POST
 *   3) 重新 HEAD → ready，图片使用稳定资源 URL 重新验证封面
 *
 * 即使服务端没有 ffmpeg，浏览器抽帧路径仍可用，只是对 1GB+ 视频的
 * 首次封面生成可能需要数秒。
 */
export function useVideoCover(
  videoPath: string | null | undefined,
  opts: Options = {},
): Result {
  const [status, setStatus] = useState<VideoCoverStatus>(
    videoPath ? "loading" : "idle",
  );
  const [coverRevision, setCoverRevision] = useState(0);
  // 防止 effect 重复触发 extracting（StrictMode 双 mount 时尤其需要）
  const startedRef = useRef(false);
  // retry() 调用时递增，强制重抽
  const [retryNonce, setRetryNonce] = useState(0);

  const setSt = useCallback(
    (s: VideoCoverStatus) => {
      setStatus(s);
      opts.onStatusChange?.(s);
    },
    [opts],
  );

  // 检查封面是否存在(可服务端的轮询探针)
  useEffect(() => {
    if (!videoPath) {
      setSt("idle");
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    let timedOut = false;
    startedRef.current = false;
    setSt("loading");

    // 短轮询:服务端 ffmpeg 抽帧是同步的(在我们 GET 的时候才触发),
    // 但 1) 多个用户同时 GET 时 ffmpeg 进程池可能忙;2) 大视频抽帧偶尔
    // 超过 500ms。所以这里给一个最多 20s 的递增轮询,覆盖服务端慢启动场景。
    let delay = SERVER_POLL_INITIAL_MS;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
      if (!cancelled) setSt("missing");
    }, SERVER_POLL_TIMEOUT_MS);

    const poll = async (): Promise<void> => {
      try {
        while (!controller.signal.aborted) {
          const r = await fetch(thumbUrl(videoPath), {
            method: "HEAD",
            signal: controller.signal,
          });
          if (cancelled || timedOut) return;
          if (r.ok) {
            setSt("ready");
            return;
          }
          if (r.status !== 404) {
            setSt("error");
            return;
          }
          await waitForProbeRetry(delay, controller.signal);
          delay = Math.min(delay * 1.5, SERVER_POLL_MAX_MS);
        }
      } catch {
        // 主动取消不报告失败；超时已进入浏览器抽帧，网络故障则提供重试。
        if (!cancelled && !timedOut) setSt("error");
      } finally {
        window.clearTimeout(timeout);
      }
    };
    void poll();

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
    // 封面上传成功后也再检查一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoPath, coverRevision, retryNonce]);

  // 抽帧 + 上传(浏览器侧,作为服务端不可用时的降级)
  const extract = useCallback(async () => {
    if (!videoPath) return;
    setSt("extracting");
    try {
      const blob = await captureVideoFrame(videoPath);
      await uploadVideoCover(videoPath, blob);
      setCoverRevision((revision) => revision + 1);
    } catch (err) {
      console.error("[useVideoCover] extract failed:", err);
      setSt("error");
    }
  }, [videoPath, setSt]);

  // 状态为 missing 时(服务端超时 / 抽帧一直失败)自动启动浏览器抽帧
  useEffect(() => {
    if (status !== "missing") return;
    if (startedRef.current) return;
    startedRef.current = true;
    void extract();
  }, [status, extract]);

  const retry = useCallback(() => {
    startedRef.current = false;
    setRetryNonce((n) => n + 1);
  }, []);

  const url = videoPath ? thumbUrl(videoPath) : "";
  return { status, url, retry, enabled: !!videoPath };
}

function waitForProbeRetry(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("cover probe cancelled", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      signal.removeEventListener("abort", abort);
      abort();
    }
  });
}

/**
 * 在浏览器内从视频文件抽一帧 JPEG 字节。
 *
 * 步骤：
 *   1) 创建一个不挂到 DOM 的 <video>（挂到 DOM 会触发自动播放限制）
 *   2) 监听 loadedmetadata → 算 seek 目标（duration * 10%，夹到 1~3s）
 *   3) 监听 seeked → drawImage → canvas.toBlob
 *   4) 释放 video.src（revokeObjectURL）
 *
 * 注意：传入视频资源 ID，函数内部用 fetch 先把视频流拉成 Blob
 * URL（走 /api/media/:id，带 Range 支持）。这样跨域 / Range 协商都
 * 交给后端处理。
 *
 * v2 起这个函数降级为"服务端 ffmpeg 不可用时的兜底"——对 1GB+ 视频
 * 会拉整段到内存,比较慢;v1 时代是主路径。
 */
export async function captureVideoFrame(videoPath: string): Promise<Blob> {
  // 1) 拉取视频作为 Blob（避免直接 src=URL 在某些环境 Range 行为不一致）
  const resp = await fetch(`/api/media/${encodeURIComponent(videoPath)}`);
  if (!resp.ok) {
    throw new Error(`fetch video: HTTP ${resp.status}`);
  }
  const blob = await resp.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const frame = await new Promise<Blob>((resolve, reject) => {
      const video = document.createElement("video");
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = "anonymous";
      video.src = objectUrl;

      const cleanup = () => {
        video.removeAttribute("src");
        video.load();
      };

      video.addEventListener(
        "loadedmetadata",
        () => {
          // 计算抽帧位置
          const d = video.duration;
          if (!Number.isFinite(d) || d <= 0) {
            // 兜底：取第 0 帧
            drawFrame(video, 0).then(resolve, reject);
            return;
          }
          const target = Math.min(SEEK_MAX, Math.max(SEEK_MIN, d * SEEK_RATIO));
          const onSeeked = () => {
            video.removeEventListener("seeked", onSeeked);
            drawFrame(video, target).then(resolve, reject);
          };
          video.addEventListener("seeked", onSeeked);
          video.currentTime = target;
        },
        { once: true },
      );

      video.addEventListener(
        "error",
        () => {
          cleanup();
          reject(new Error("video load error"));
        },
        { once: true },
      );
    });
    return frame;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function drawFrame(video: HTMLVideoElement, at: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const scale = Math.min(1, FRAME_MAX_W / vw);
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("canvas 2d not available"));
      return;
    }
    try {
      ctx.drawImage(video, 0, 0, w, h);
    } catch (err) {
      reject(err);
      return;
    }
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("canvas.toBlob returned null"));
      },
      "image/jpeg",
      0.85,
    );
    // at 是 currentTime 值的副本，留作未来调试
    void at;
  });
}
