import { useStoragePaths, useStorageUsage, useMediaCache } from "../../hooks/useStorage";
import StorageMediaCache from "./StorageMediaCache";
import StorageModuleGrid from "./StorageModuleGrid";
import StoragePaths from "./StoragePaths";
import StorageSummaryTiles from "./StorageSummaryTiles";
import { RefreshIcon } from "../common/Icon";

/**
 * 05 本机存储：派生缓存、AI 模型与分析产物、以及它们各自的位置。
 *
 * 跑一次任务之后磁盘涨了多少、涨在哪、产物落在哪 —— 这些问题的答案都在
 * 这一段里，不必再去设置页找。
 */
export default function StorageSection() {
  const usage = useStorageUsage();
  const paths = useStoragePaths();
  const media = useMediaCache();

  const stats = media.stats;
  const refreshAll = () => {
    void usage.refetch();
    media.refresh();
  };

  return (
    <div className="space-y-4">
      {usage.isLoading ? (
        <div
          role="status"
          className="rounded-xl border border-border bg-bg-elevated p-5 text-body text-fg-muted"
        >
          正在读取本机存储信息…
        </div>
      ) : usage.isError ? (
        <div
          role="alert"
          className="rounded-xl border border-danger/30 bg-danger/5 p-5 text-body text-fg-muted"
        >
          本机存储信息读取失败，请检查后端是否运行，然后刷新页面。
        </div>
      ) : usage.data ? (
        <StorageSummaryTiles
          mediaBytes={stats?.mediaBytes ?? 0}
          mediaFileCount={stats?.mediaFileCount ?? 0}
          outputBytes={usage.data.summary.outputBytes}
          outputFileCount={usage.data.summary.outputFileCount}
          modelBytes={usage.data.summary.modelBytes}
          modelFileCount={usage.data.summary.modelFileCount}
        />
      ) : null}

      <StorageMediaCache
        loading={media.loading}
        refreshing={media.refreshing}
        clearing={media.clearing}
        totalBytes={stats?.mediaBytes}
        totalFileCount={stats?.mediaFileCount}
        scannedAt={stats?.scannedAt}
        ttlSeconds={stats?.cacheTtlSeconds}
        sub={{
          thumbs: stats?.thumbs ?? emptySubUsage,
          converted: stats?.converted ?? emptySubUsage,
          previews: stats?.previews ?? emptySubUsage,
          videoFaststart: stats?.videoFaststart ?? emptySubUsage,
          videoTranscode: stats?.videoTranscode ?? emptySubUsage,
        }}
        onRefresh={media.refresh}
        onClear={media.clear}
        onClearAll={media.clearAll}
      />

      {usage.data ? <StorageModuleGrid modules={usage.data.modules} /> : null}

      <StoragePaths
        relative={usage.data?.paths}
        absolute={paths.data}
        absoluteError={paths.error}
        onRetryAbsolute={() => void paths.refetch()}
      />

      <div className="flex justify-end">
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-faint px-2.5 text-meta text-fg-muted transition-colors hover:bg-bg-subtle disabled:opacity-50"
          onClick={refreshAll}
          disabled={usage.isFetching || media.refreshing}
        >
          {usage.isFetching ? (
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-fg-muted border-t-transparent" />
          ) : (
            <RefreshIcon size={11} />
          )}
          <span>刷新占用</span>
        </button>
      </div>
    </div>
  );
}

const emptySubUsage = {
  path: "",
  bytes: 0,
  fileCount: 0,
  available: false,
};
