import { api, API_BASE } from "./client";

// 视频原始流 URL（供 <video src=...> 使用）。
//
// 后端 /api/media/:id 支持 Range，前端拖动进度条时浏览器自动按需分段。
export function videoUrl(fileId: string, playbackId: string): string {
  const p = `/api/media/${encodeURIComponent(fileId)}?playback=${encodeURIComponent(playbackId)}`;
  return API_BASE ? `${API_BASE}${p}` : p;
}

// 每次播放尝试使用独立标识，避免浏览器复用上一段解码缓冲；同次 Range 沿用此 URL。
// 标识只隔离浏览器资源，不选择服务端文件，也不携带路径或鉴权信息。
export function createVideoPlaybackId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

// 视频元信息。
//
// 必填字段：path/name/dir/size/mtime/format。
// 可选字段（服务端 ffprobe 可用时填,否则缺省）：
//   - duration / width / height / codec / container / bitRate
//   - transcode：服务端转码状态；后端 ffmpeg 不可用时整个字段省略
//
// 服务端 ffprobe 可一次性返回元数据，UI 可在列表中展示时长。
export interface VideoInfo {
  path: string; // 文件资源 ID
  name: string;
  dir: string; // 根别名/相对父目录，不含文件名
  size: number;
  mtime: string;
  format: string; // 含点，如 ".mp4"
  // ffprobe 元数据(可选)
  duration?: number;
  width?: number;
  height?: number;
  codec?: string;
  container?: string;
  bitRate?: number;
  // 服务端转码状态（可选）
  transcode?: TranscodeStatus;
}

export async function getVideoInfo(fileId: string): Promise<VideoInfo> {
  return api<VideoInfo>(`/api/videos/${encodeURIComponent(fileId)}/info`);
}

export const VIDEO_INFO_BATCH_LIMIT = 100;

export interface VideoInfoBatchItem {
  id: string;
  info?: VideoInfo;
  code?: string;
}

/**
 * 批量读取视频元数据。调用方可以传入超过服务端上限的数组，函数会
 * 自动拆成多个请求并合并为按资源 ID 索引的结果。
 */
export async function getVideoInfoBatch(
  fileIds: string[],
): Promise<Record<string, VideoInfo>> {
  const ids = Array.from(new Set(fileIds.filter(Boolean)));
  const result: Record<string, VideoInfo> = {};
  for (let offset = 0; offset < ids.length; offset += VIDEO_INFO_BATCH_LIMIT) {
    const response = await api<{
      ok: boolean;
      items: VideoInfoBatchItem[];
    }>("/api/videos/info/batch", {
      method: "POST",
      body: { ids: ids.slice(offset, offset + VIDEO_INFO_BATCH_LIMIT) },
      nonIdempotent: true,
    });
    for (const item of response.items) {
      if (item.info) result[item.id] = item.info;
    }
  }
  return result;
}

// ---- 服务端转码 ----

export type TranscodeStatusValue =
  | "skipped"
  | "unavailable"
  | "not_needed"
  | "cached"
  | "queued"
  | "running"
  | "failed"
  | "unknown";

export interface TranscodeStatus {
  status: TranscodeStatusValue;
  progress: number; // 0-1
  etaSec: number;
  error?: string;
}

/**
 * 查转码状态（一次性；轮询用）。
 *
 * @param fileId 视频资源 ID
 */
export async function getTranscodeStatus(
  fileId: string,
): Promise<TranscodeStatus> {
  const url = API_BASE
    ? `${API_BASE}/api/videos/${encodeURIComponent(fileId)}/transcode/status`
    : `/api/videos/${encodeURIComponent(fileId)}/transcode/status`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`transcode status failed: HTTP ${res.status}`);
  }
  return (await res.json()) as TranscodeStatus;
}

/**
 * 取消转码。
 */
export async function cancelTranscode(fileId: string): Promise<void> {
  const url = API_BASE
    ? `${API_BASE}/api/videos/${encodeURIComponent(fileId)}/transcode/cancel`
    : `/api/videos/${encodeURIComponent(fileId)}/transcode/cancel`;
  await fetch(url, { method: "POST" });
}

/**
 * 订阅转码进度事件（SSE）。
 *
 * 返回:
 *   - close(): 关闭连接 + 清理
 *
 * 用法:
 *   const close = subscribeTranscodeEvents(path, {
 *     onProgress: (s) => setState(s),
 *     onDone: (s) => { close(); ... }
 *   })
 */
export function subscribeTranscodeEvents(
  fileId: string,
  handlers: {
    onProgress?: (status: TranscodeStatus) => void;
    onDone?: (status: TranscodeStatus) => void;
    onError?: (err: Event) => void;
  },
): () => void {
  const url = API_BASE
    ? `${API_BASE}/api/videos/${encodeURIComponent(fileId)}/transcode/events`
    : `/api/videos/${encodeURIComponent(fileId)}/transcode/events`;
  const es = new EventSource(url);

  es.addEventListener("progress", (e) => {
    try {
      const status = JSON.parse((e as MessageEvent).data) as TranscodeStatus;
      handlers.onProgress?.(status);
    } catch {
      // ignore parse error
    }
  });
  es.addEventListener("done", (e) => {
    try {
      const status = JSON.parse((e as MessageEvent).data) as TranscodeStatus;
      handlers.onDone?.(status);
    } catch {
      // ignore
    }
    es.close();
  });
  es.onerror = (e) => {
    handlers.onError?.(e);
    // EventSource 在网络断开时会自动重连;不主动 close,
    // 让浏览器自己处理(组件 unmount 时由返回的 close() 关)
  };

  return () => es.close();
}
