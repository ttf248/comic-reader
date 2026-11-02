import { api } from "./client";

// GET /api/cache/stats 的响应体。
export interface CacheStats {
  path: string;
  totalBytes: number;
  fileCount: number;
  scannedAt: string;
  durationMs: number;
  // 目录存在但还没被扫描/读取出错时给 false
  available: boolean;
  // 缓存剩余秒数(后端 30s TTL),前端可据此显示"30s 前更新"
  cacheTtlSeconds: number;
  // 按子目录细分 — 后端独立扫描 thumbs / converted / video-faststart /
  // video-transcode。子目录不存在时 Available=false,bytes/fileCount 为 0
  // (还没产生过该类缓存)。
  //
  // converted 是 HEIC/HEIF/TIFF 的整图转换产物,单张可达 MB 级,单独列出
  // 才能让各细分之和等于 totalBytes。
  thumbs: SubUsage;
  converted: SubUsage;
  videoFaststart: SubUsage;
  videoTranscode: SubUsage;
}

// 单个子目录的占用快照。
export interface SubUsage {
  /** 脱敏缓存子目录名称。 */
  path: string;
  bytes: number;
  fileCount: number;
  available: boolean;
}

// POST /api/cache/clear 的响应(scope 化清空)。
//
// 响应结构按 scope 区分字段(scope=thumbs 时只有 thumbs 非空,scope=all
// 时各子项全非空,totalDeleted/totalFreedBytes 是它们之和)。
// 前端 toast "已清空 X" 优先用 total* 字段(scope=all 路径下)。
export interface CacheScopeClearResult {
  scope: "thumbs" | "converted" | "faststart" | "transcode" | "all";
  thumbs?: { deleted: number; freedBytes: number };
  converted?: { deleted: number; freedBytes: number };
  faststart?: { deleted: number; freedBytes: number };
  transcode?: { deleted: number; freedBytes: number };
  totalDeleted: number;
  totalFreedBytes: number;
}

export const cacheApi = {
  stats: () => api<CacheStats>("/api/cache/stats"),
  // 统一清空入口(scope=thumbs|converted|faststart|transcode|all)。
  // scope=all 一键全清,响应里有 totalDeleted/totalFreedBytes 便于 toast。
  clearCache: (
    scope: "thumbs" | "converted" | "faststart" | "transcode" | "all",
  ) =>
    api<CacheScopeClearResult>(`/api/cache/clear?scope=${scope}`, {
      method: "POST",
    }),
};

// 把字节数格式化为 B / KB / MB / GB / TB。
//   - 1 KB = 1024 B
//   - 1 MB = 1024 KB
// 保留 1 位小数,小于 1 KB 显示 "X B"。
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  // 1 位小数,但舍去末尾 .0
  const fixed = n.toFixed(1).replace(/\.0$/, "");
  return `${fixed} ${units[i]}`;
}
