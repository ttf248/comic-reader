import { formatBytes, type SubUsage } from "../../api/cache";
import type { MediaCacheScope } from "../../hooks/useStorage";
import SubUsageBadge from "../common/SubUsageBadge";
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
 * 它们可以随时重建，所以给每一类都留了单独清理的入口 —— 转码缓存涨到
 * 几十 GB 时，不必把缩略图一起清掉。
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
    <section className="rounded-xl border border-border bg-bg-elevated shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-faint px-5 py-4 sm:px-6">
        <div>
          <h3 className="text-label font-medium text-fg">媒体派生缓存</h3>
          <p className="mt-1 text-meta text-fg-subtle">
            浏览与播放时算出来的中间产物，可以随时重建。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-faint px-2.5 text-meta text-fg-muted transition-colors hover:bg-bg-subtle disabled:opacity-50"
            onClick={onRefresh}
            disabled={refreshing}
            title="重新扫描磁盘计算缓存占用"
          >
            {refreshing ? (
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-fg-muted border-t-transparent" />
            ) : (
              <RefreshIcon size={11} />
            )}
            <span>刷新</span>
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-danger/40 px-2.5 text-meta text-danger transition-colors hover:bg-danger/5 disabled:opacity-50"
            onClick={onClearAll}
            disabled={clearing === "all"}
            title="清空全部派生缓存"
          >
            <TrashIcon size={11} />
            <span>{clearing === "all" ? "清空中…" : "一键全清"}</span>
          </button>
        </div>
      </div>

      <div className="px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-meta">
          <span className="tabular-nums text-fg-muted">
            {loading
              ? "计算中…"
              : totalBytes === undefined
                ? "—"
                : `${formatBytes(totalBytes)} · ${totalFileCount ?? 0} 个文件`}
          </span>
          {scannedAt ? (
            <span className="whitespace-nowrap text-fg-subtle tabular-nums">
              {ttlSeconds && ttlSeconds > 0
                ? `${ttlSeconds}s 内复用 · 统计于 ${new Date(
                    scannedAt,
                  ).toLocaleString("zh-CN", { hour12: false })}`
                : `统计于 ${new Date(scannedAt).toLocaleString("zh-CN", {
                    hour12: false,
                  })}`}
            </span>
          ) : null}
        </div>

        <div className="mt-3 grid w-full grid-cols-[repeat(auto-fit,minmax(112px,1fr))] gap-2 text-meta">
          {SCOPES.map((item) => (
            <SubUsageBadge
              key={item.scope}
              label={item.label}
              sub={sub[item.key]}
              onClear={() => onClear(item.scope)}
              clearPending={clearing === item.scope}
            />
          ))}
        </div>

        <details className="group mt-4 border-t border-border-faint pt-4">
          <summary className="cursor-pointer list-none text-meta text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
            重建渲染缓存（缩略图 / 预览图）
          </summary>
          <div className="mt-3">
            <CacheRebuildPanel />
          </div>
        </details>
      </div>
    </section>
  );
}
