import { videoUrl } from "../api/videos";

const FRAME_MAX_W = 1920;
const CAPTURE_TIMEOUT_MS = 30_000;

/** 直接用媒体 URL 抽取一帧，交由浏览器按需发送 Range 请求。 */
export function captureVideoFrame(
  fileId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  if (signal?.aborted) {
    return Promise.reject(
      new DOMException("frame capture cancelled", "AbortError"),
    );
  }
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    let settled = false;
    let seekReady = false;
    let drawing = false;

    const finish = (blob: Blob | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("loadeddata", drawWhenReady);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      video.removeAttribute("src");
      video.load();
      if (blob) resolve(blob);
      else reject(error);
    };
    const drawWhenReady = () => {
      if (settled || drawing || !seekReady || video.readyState < 2) return;
      drawing = true;
      void drawFrame(video).then(
        (blob) => finish(blob),
        (error: unknown) => finish(null, error),
      );
    };
    const onSeeked = () => {
      seekReady = true;
      drawWhenReady();
    };
    const onMetadata = () => {
      const duration = video.duration;
      // 短视频也必须定位在片尾之前；不可用时长则等待第 0 帧可解码。
      const target =
        Number.isFinite(duration) && duration > 0
          ? Math.min(
              Math.max(0, duration - 0.1),
              Math.min(3, Math.max(1, duration * 0.1)),
            )
          : 0;
      if (Math.abs(video.currentTime - target) < 0.001) {
        onSeeked();
      } else {
        try {
          video.currentTime = target;
        } catch (error) {
          finish(null, error);
        }
      }
    };
    const onError = () => finish(null, new Error("video load error"));
    const onAbort = () =>
      finish(null, new DOMException("frame capture cancelled", "AbortError"));
    const timeout = window.setTimeout(
      () => finish(null, new Error("video frame capture timed out")),
      CAPTURE_TIMEOUT_MS,
    );

    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    video.addEventListener("loadedmetadata", onMetadata, { once: true });
    video.addEventListener("loadeddata", drawWhenReady);
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    video.src = videoUrl(fileId);
  });
}

function drawFrame(video: HTMLVideoElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const scale = Math.min(1, FRAME_MAX_W / width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const release = () => {
      canvas.width = 0;
      canvas.height = 0;
    };
    try {
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas 2d not available");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          release();
          if (blob) resolve(blob);
          else reject(new Error("canvas.toBlob returned null"));
        },
        "image/jpeg",
        0.85,
      );
    } catch (error) {
      release();
      reject(error);
    }
  });
}
