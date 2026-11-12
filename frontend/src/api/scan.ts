import { api } from "./client";

export interface ScanStartResponse {
  scanId: string;
}

export interface ProgressEvent {
  scanId: string;
  progress: number;
  status: "pending" | "running" | "complete" | "cancelled" | "error";
  phase?: string;
  currentPath?: string;
  albumsFound: number;
  error?: string;
  elapsedMs: number;
}

export const scanApi = {
  start: () => api<ScanStartResponse>("/api/scans", { method: "POST" }),
  cancel: (id: string) =>
    api<{ ok: boolean }>(`/api/scans/${id}`, { method: "DELETE" }),
  // 强制清空媒体库索引（内存 + scan_cache.json）。清空后需用户手动重新扫描。
  clearCache: () => api<{ ok: boolean }>("/api/library", { method: "DELETE" }),
};
