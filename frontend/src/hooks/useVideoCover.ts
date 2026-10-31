import { useCallback, useEffect, useRef, useState } from "react";
import { thumbUrl, uploadVideoCover } from "../api/thumbs";
import { captureVideoFrame } from "../utils/videoFrame";

export type VideoCoverStatus =
  "idle" | "loading" | "missing" | "extracting" | "ready" | "error";

interface Options {
  onStatusChange?: (status: VideoCoverStatus) => void;
}

interface Result {
  status: VideoCoverStatus;
  /** 稳定资源 URL，由 HTTP 缓存头重新验证实际封面。 */
  url: string;
  retry: () => void;
  enabled: boolean;
}

const SERVER_POLL_INITIAL_MS = 200;
const SERVER_POLL_MAX_MS = 1500;
const SERVER_POLL_TIMEOUT_MS = 20_000;

/** 每个资源/重试拥有一次完整探测、抽帧和上传，离开时取消整条任务。 */
export function useVideoCover(
  videoPath: string | null | undefined,
  opts: Options = {},
): Result {
  const [state, setState] = useState({
    path: videoPath ?? "",
    status: (videoPath ? "loading" : "idle") as VideoCoverStatus,
  });
  const [retryNonce, setRetryNonce] = useState(0);
  const onStatusChange = useRef(opts.onStatusChange);
  onStatusChange.current = opts.onStatusChange;

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    const notify = (status: VideoCoverStatus) => {
      if (signal.aborted) return;
      setState({ path: videoPath ?? "", status });
      onStatusChange.current?.(status);
    };
    notify(videoPath ? "loading" : "idle");
    if (videoPath) {
      void (async () => {
        if (!(await probeCover(videoPath, signal))) {
          notify("missing");
          notify("extracting");
          const blob = await captureVideoFrame(videoPath, signal);
          if (signal.aborted) return;
          await uploadVideoCover(videoPath, blob, signal);
          if (signal.aborted) return;
          const response = await fetch(thumbUrl(videoPath), {
            method: "HEAD",
            signal,
          });
          if (!response.ok) throw new Error("uploaded cover unavailable");
        }
        notify("ready");
      })().catch(() => notify("error"));
    }
    return () => controller.abort();
  }, [videoPath, retryNonce]);

  const retry = useCallback(() => setRetryNonce((nonce) => nonce + 1), []);
  const status =
    state.path === (videoPath ?? "")
      ? state.status
      : videoPath
        ? "loading"
        : "idle";
  return {
    status,
    url: videoPath ? thumbUrl(videoPath) : "",
    retry,
    enabled: !!videoPath,
  };
}

// 只有探测超时会进入浏览器回退；网络或其他 HTTP 故障由 UI 提供重试。
async function probeCover(
  fileId: string,
  parentSignal: AbortSignal,
): Promise<boolean> {
  if (parentSignal.aborted) throw parentSignal.reason;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  parentSignal.addEventListener("abort", cancel, { once: true });
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SERVER_POLL_TIMEOUT_MS);
  let delay = SERVER_POLL_INITIAL_MS;
  try {
    while (true) {
      const response = await fetch(thumbUrl(fileId), {
        method: "HEAD",
        signal: controller.signal,
      });
      if (response.ok) return true;
      if (response.status !== 404) throw new Error("cover probe failed");
      await waitForProbeRetry(delay, controller.signal);
      delay = Math.min(delay * 1.5, SERVER_POLL_MAX_MS);
    }
  } catch (error) {
    if (timedOut && !parentSignal.aborted) return false;
    throw error;
  } finally {
    window.clearTimeout(timeout);
    parentSignal.removeEventListener("abort", cancel);
    controller.abort();
  }
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
