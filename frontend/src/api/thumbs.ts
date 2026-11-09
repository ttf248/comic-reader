import { API_BASE } from "./client";

/**
 * 渲染图 URL 构造。
 *
 * 参数：
 *   - fileId：服务端生成的文件资源 ID。
 *   - version：媒体内容版本号（源文件 mtime + size + 渲染算法版本）。
 *     带上的请求若与当前版本一致，服务端回 immutable，浏览器可以长期
 *     缓存 —— 重复打开页面时这张图一次网络请求都不发。
 *   - width：渲染档位宽度；缺省用服务端缺省档位。
 */
export function thumbUrl(
  fileId: string,
  version?: string,
  width?: number,
): string {
  const path = `/api/thumbs/${encodeURIComponent(fileId)}`;
  const query = renditionQuery(version, width);
  return API_BASE ? `${API_BASE}${path}${query}` : `${path}${query}`;
}

/**
 * thumbSrcSet 构造 srcset 候选列表。
 *
 * 渲染不裁剪，同一张源图在各档之间宽高比一致，所以浏览器可以按
 * "需要多宽"自由挑档，页面也不会因为换档而跳版。
 */
export function thumbSrcSet(
  fileId: string,
  version: string | undefined,
  widths: number[],
): string {
  return widths
    .map((width) => `${thumbUrl(fileId, version, width)} ${width}w`)
    .join(", ");
}

/** renditionQuery 拼出 ?w=…&v=… 查询串（按参数有无决定要不要问号）。 */
export function renditionQuery(
  version?: string,
  width?: number,
): string {
  const parts: string[] = [];
  if (typeof width === "number" && Number.isFinite(width) && width > 0) {
    parts.push(`w=${Math.round(width)}`);
  }
  if (version) {
    parts.push(`v=${encodeURIComponent(version)}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
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
