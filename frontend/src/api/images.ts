import { API_BASE } from "./client";

// 全图 URL（与 thumbUrl 对应）
export function imageUrl(fileId: string): string {
  const p = `/api/media/${encodeURIComponent(fileId)}`;
  return API_BASE ? `${API_BASE}${p}` : p;
}

// 预览图 URL：服务端按宽度等比缩放后的 JPEG。
//
// 阅读器连续模式按视口宽度展示图片，直接用原图的话手机照片动辄 5MB+，
// 一屏就是几 MB，整本翻完是 GB 级流量。预览图约为原图的 1/10~1/30。
//
// 宽度与服务端保持同一区间（320~4096），超出时服务端也会夹一次。
export function previewUrl(fileId: string, width: number): string {
  const w = Math.max(320, Math.min(4096, Math.round(width)));
  const p = `/api/previews/${encodeURIComponent(fileId)}?w=${w}`;
  return API_BASE ? `${API_BASE}${p}` : p;
}
