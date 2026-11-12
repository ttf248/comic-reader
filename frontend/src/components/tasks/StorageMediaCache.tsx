import { formatBytes } from "../../api/cache";
import type { MediaCacheScope } from "../../hooks/useStorage";
import { RefreshIcon, TrashIcon } from "../common/Icon";
import CacheRebuildPanel from "./CacheRebuildPanel";

interface Props {
  loading: boolean;
  refreshing: boolean;
  clearing?: MediaCacheScope | "all";
  totalBytes?: number;
  totalFileCount?: number;
  scannedAt?: string;
  ttlSeconds?: number;
  sub: {
    thumbs: SubUsage;
    converted: SubUsage;
    previews: SubUsage;
    videoFaststart: SubUsage;
    videoTranscode: SubUsage;
  };
  onRefresh: () => void;
  onClear: (scope: MediaCacheScope) => void;
  onClearAll: () => void;
}

interface SubUsage {
  path: string;
  bytes: number;
  fileCount: number;
  available: boolean;
}

const SCOPES: { scope: MediaCacheScope; label: string; key: keyof Props["sub"] }[] =
  [
    { scope: "thumbs", label: "缩略图", key: "thumbs" },
    { scope: "converted", label: "转换图", key: "converted" },
    { scope: "previews", label: "预览图", key: "previews" },
    { scope: "faststart", label: "faststart", key: "videoFaststart" },
    { scope: "transcode", label: "转码", key: "videoTranscode" },
  ];

/**
 * 媒体派生缓存：浏览图片时顺手算出来的那些中间产物。
 *
 * 每一类一行，占用与清理按钮在同一行右侧 —— 之前是五张徽章，每张右上角
 * 挂一个垃圾桶图标，图标挤在标签旁边，眼睛找不到哪个是哪个的。
 */
export default function StorageMediaCache({
  loading,
  refreshing,
  clearing,
  totalBytes,
  totalFileCount,
  scannedAt,
  ttlSeconds,
  sub,
  onRefresh,
  onClear,
  onClearAll,
}: Props) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border-faint bg-bg-subtle px-4 py-2.5">
        <div className="min-w-0">
          <h3 className="text-label font-medium text-fg">派生缓存</h3>
          <p className="mt-0.5 text-meta tabular-nums text-fg-subtle">
            {loading
              ? "计算中…"
              : totalBytes === undefined
                ? "—"
                : `${formatBytes(totalBytes)} · ${(totalFileCount ?? 0).toLocaleString()} 个文件`}
            {scannedAt
              ? ` · ${ttlSeconds && ttlSeconds > 0 ? `${ttlSeconds}s 内复用` : "已过期"}`
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border-faint text-fg-muted transition-colors hover:bg-bg-subtle disabled:opacity-50"
            onClick={onRefresh}
            disabled={refreshing}
            title="重新扫描磁盘计算缓存占用"
            aria-label="刷新派生缓存占用"
          >
            {refreshing ? (
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-fg-muted border-t-transparent" />
            ) : (
              <RefreshIcon size={11} />
            )}
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-danger/40 px-2 text-meta text-danger transition-colors hover:bg-danger/5 disabled:opacity-50"
            onClick={onClearAll}
            disabled={clearing === "all"}
            title="清空全部派生缓存"
          >
            <TrashIcon size={10} />
            {clearing === "all" ? "清空中…" : "全清"}
          </button>
        </div>
      </div>

      <ul className="divide-y divide-border-faint">
        {SCOPES.map((item) => {
          const entry = sub[item.key];
          const canClear = entry.available && entry.bytes > 0;
          return (
            <li
              key={item.scope}
              className="flex items-center gap-3 px-4 py-2"
            >
              <span className="w-20 shrink-0 text-meta text-fg-muted">
                {item.label}
              </span>
              <span className="min-w-0 flex-1 font-mono text-meta tabular-nums text-fg">
                {entry.available ? formatBytes(entry.bytes) : "—"}
              </span>
              <span className="w-16 shrink-0 text-right text-meta tabular-nums text-fg-subtle">
                {entry.available ? `${entry.fileCount.toLocaleString()} 个` : ""}
              </span>
              <button
                type="button"
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-30"
                disabled={!canClear || clearing === item.scope}
                onClick={() => onClear(item.scope)}
                title={canClear ? `清空 ${item.label} 缓存` : "暂无内容"}
                aria-label={`清空 ${item.label} 缓存`}
              >
                {clearing === item.scope ? (
                  <span className="inline-block h-2 w-2 animate-spin rounded-full border-2 border-fg-muted border-t-transparent" />
                ) : (
                  <TrashIcon size={10} />
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <details className="group border-t border-border-faint px-4 py-2.5">
        <summary className="cursor-pointer list-none text-meta text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
          重建渲染缓存（缩略图 / 预览图）
        </summary>
        <div className="mt-3">
          <CacheRebuildPanel />
        </div>
      </details>
    </section>
  );
}
