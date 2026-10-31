import type { useHistory } from "../../hooks/useHistory";

export default function ViewedSortNotice({
  query,
}: {
  query: ReturnType<typeof useHistory>;
}) {
  if (query.isError) {
    return (
      <div className="px-6 lg:px-10 max-w-[1400px] mx-auto w-full mb-4">
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger/5 px-4 py-3 text-sm"
        >
          <p>
            最近访问加载失败。
            {query.data ? "仍使用已加载的访问记录。" : "暂按名称排序。"}
          </p>
          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            className="shrink-0 text-accent hover:underline disabled:opacity-50"
          >
            {query.isFetching ? "正在重试…" : "重试加载"}
          </button>
        </div>
      </div>
    );
  }
  if (query.isLoading) {
    return (
      <div
        role="status"
        className="px-6 lg:px-10 max-w-[1400px] mx-auto w-full mb-4 text-sm text-fg-muted"
      >
        正在加载最近访问…
      </div>
    );
  }
  return null;
}
