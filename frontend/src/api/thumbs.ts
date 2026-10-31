import { API_BASE } from "./client";

// 缩略图 URL：仅传服务端生成的文件资源 ID。
export function thumbUrl(fileId: string): string {
  const path = `/api/thumbs/${encodeURIComponent(fileId)}`;
  return API_BASE ? `${API_BASE}${path}` : path;
}

// 把视频封面上传到后端。后端会把字节 resize → 缓存到磁盘。
//
// 失败场景由后端返回 4xx/5xx；本函数抛 Error 给调用方处理。
export async function uploadVideoCover(
  fileId: string,
  blob: Blob,
  signal?: AbortSignal,
): Promise<void> {
  const url = API_BASE
    ? `${API_BASE}/api/thumbs/${encodeURIComponent(fileId)}/cover`
    : `/api/thumbs/${encodeURIComponent(fileId)}/cover`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": blob.type || "image/jpeg" },
    body: blob,
    signal,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && typeof j.error === "string") msg = j.error;
    } catch {
      // ignore parse error
    }
    throw new Error(`upload cover failed: ${msg}`);
  }
}

export interface ThumbnailStats {
  memoryItems: number;
  diskFiles: number;
  cacheDir: string;
}
