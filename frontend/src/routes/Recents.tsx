import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useSearchStore } from "../store/searchStore";
import { useUIStore } from "../store/uiStore";
import type { Prefs } from "../api/prefs";
import { useHistory } from "../hooks/useHistory";
import { useImageActivities } from "../hooks/useImageActivity";
import { useGalleryContextSync } from "../hooks/useGalleryContextSync";
import AlbumGrid, { type CardData } from "../components/album/AlbumGrid";
import { ListFilterBar } from "../components/common/ListFilterBar";
import EmptyState from "../components/common/EmptyState";
import { ClockIcon } from "../components/common/Icon";
import { decodeFavPath } from "../utils/path";
import { compareDatesDesc, formatRelative } from "../utils/date";
import type { GalleryContextEntry } from "../utils/galleryContext";
import { useLibraryNodes } from "../hooks/useLibrary";
import { nodeSummaryToCard } from "../utils/libraryCard";

const EMPTY_HISTORY: Prefs["history"] = [];

// 最近访问：从后端 history 列表中读取。带阅读进度。
export default function Recents() {
  const navigate = useNavigate();
  const viewMode = useUIStore((s) => s.viewMode);
  const query = useSearchStore((s) => s.query);
  const sortBy = useSearchStore((s) => s.sortBy);
  const minImageCount = useSearchStore((s) => s.minImageCount);

  const historyQuery = useHistory();

  // history 顺序:OpenedAt 倒序
  const history = historyQuery.data?.history ?? EMPTY_HISTORY;
  const historyIds = useMemo(
    () => history.map((item) => item.albumId),
    [history],
  );
  const nodesQuery = useLibraryNodes(historyIds);
  const nodesById = useMemo(
    () =>
      new Map((nodesQuery.data?.items ?? []).map((node) => [node.id, node])),
    [nodesQuery.data],
  );

  const cards = useMemo<CardData[]>(() => {
    const out: CardData[] = [];
    for (const h of history) {
      const node = nodesById.get(h.albumId);
      if (!node || node.kind !== "album") continue;
      out.push({ ...nodeSummaryToCard(node), lastSeenAt: h.openedAt });
    }
    return out;
  }, [history, nodesById]);

  const progressPaths = useMemo(
    () => cards.map((c) => decodeFavPath(c.to)).filter(Boolean),
    [cards],
  );
  const { data: progressMap } = useImageActivities(progressPaths);

  const filtered = useMemo(() => {
    const list = cards
      .filter((it) => {
        if (!query) return true;
        const q = query.toLowerCase();
        return `${it.title} ${it.subtitle ?? ""}`.toLowerCase().includes(q);
      })
      // 最小图数过滤(全局 filter)
      .filter((it) => {
        if (minImageCount <= 0) return true;
        if (it.variant !== "album") return true;
        return (it.count ?? 0) >= minImageCount;
      })
      .map((c) => {
        const k = decodeFavPath(c.to);
        const p = progressMap?.[k];
        if (!p) return c;
        return {
          ...c,
          progress: { index: p.pageIndex, total: c.imageCount ?? 0 },
        };
      });
    switch (sortBy) {
      case "count":
        return list.sort((a, b) => b.count - a.count);
      case "name":
        return list.sort((a, b) => a.title.localeCompare(b.title));
      case "recent":
        return list.sort(
          (a, b) =>
            compareDatesDesc(a.modTime, b.modTime) ||
            a.title.localeCompare(b.title),
        );
      case "viewed":
      default:
        // 最近看沿用服务端按 openedAt 倒序的访问记录。
        return list;
    }
  }, [cards, query, sortBy, progressMap, minImageCount]);

  const recentsEntries = useMemo<GalleryContextEntry[]>(
    () =>
      filtered.map((c) => ({
        key: decodeFavPath(c.to),
        to: c.to,
        name: c.title,
      })),
    [filtered],
  );
  useGalleryContextSync({ type: "recents" }, recentsEntries);

  const historyFailed = historyQuery.isError;
  const nodesFailed = history.length > 0 && nodesQuery.isError;
  const loadFailed = historyFailed || nodesFailed;
  const retrying = historyQuery.isFetching || nodesQuery.isFetching;
  const retryLoad = () => {
    if (historyFailed) void historyQuery.refetch();
    if (nodesFailed) void nodesQuery.refetch();
  };

  return (
    <div className="min-h-full">
      <section className="px-6 lg:px-10 pt-10 pb-6 max-w-[1400px] mx-auto w-full">
        <div className="flex items-center gap-2 mb-1">
          <ClockIcon size={13} className="text-fg-muted" />
          <span className="text-[11px] uppercase tracking-[0.14em] text-fg-muted">
            最近
          </span>
        </div>
        <h1 className="font-display text-[32px] leading-[1.1] font-semibold tracking-tight">
          最近阅读
        </h1>
        <p className="text-sm text-fg-muted mt-2 tabular-nums">
          {history.length > 0 ? (
            <>
              <span className="text-fg">{history.length}</span> 个
              <span className="text-fg-subtle/60 mx-1.5">·</span>
              最近打开{" "}
              <span className="text-fg">
                {formatRelative(history[0]?.openedAt)}
              </span>
            </>
          ) : historyQuery.isLoading ? (
            "正在加载记录…"
          ) : historyFailed ? (
            "记录暂不可用"
          ) : (
            "还没有记录"
          )}
        </p>
      </section>

      {loadFailed && (
        <div className="px-6 lg:px-10 max-w-[1400px] mx-auto w-full mb-4">
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger/5 px-4 py-3 text-sm"
          >
            <p>
              {historyFailed
                ? "最近阅读加载失败。"
                : "最近阅读的相册信息加载失败。"}
              {cards.length > 0 ? "仍显示已加载的记录。" : "请重试加载。"}
            </p>
            <button
              type="button"
              onClick={retryLoad}
              disabled={retrying}
              className="shrink-0 text-accent hover:underline disabled:opacity-50"
            >
              {retrying ? "正在重试…" : "重试加载"}
            </button>
          </div>
        </div>
      )}
      {cards.length > 0 && <ListFilterBar totalCount={filtered.length} />}

      {historyQuery.isLoading ? (
        <div
          role="status"
          className="px-6 lg:px-10 max-w-[1400px] mx-auto text-sm text-fg-muted"
        >
          正在加载最近阅读…
        </div>
      ) : history.length > 0 && nodesQuery.isLoading && cards.length === 0 ? (
        <div
          role="status"
          className="px-6 lg:px-10 max-w-[1400px] mx-auto text-sm text-fg-muted"
        >
          正在解析最近浏览…
        </div>
      ) : loadFailed && cards.length === 0 ? null : history.length === 0 ? (
        <EmptyState
          title="还没有最近阅读"
          description="打开任意一个文件夹开始浏览，它会出现在这里。"
          icon={<ClockIcon size={20} />}
          action={
            <button
              onClick={() => navigate("/")}
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-accent text-accent-fg hover:bg-accent-hover text-sm"
            >
              去主页看看
            </button>
          }
        />
      ) : cards.length === 0 ? (
        <EmptyState
          title="最近访问的相册暂不可用"
          description="相册可能已移动，或媒体库尚未完成扫描。"
          action={
            <button
              onClick={() => navigate("/")}
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md border border-border hover:bg-bg-subtle text-sm"
            >
              去主页看看
            </button>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="没有匹配的最近访问"
          description={query ? `没有匹配"${query}"的结果` : ""}
          action={
            <button
              onClick={() => useSearchStore.getState().reset()}
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md border border-border hover:bg-bg-subtle text-sm"
            >
              清除筛选
            </button>
          }
        />
      ) : (
        <section className="max-w-[1400px] mx-auto w-full">
          <div className="px-6 lg:px-10 pb-10">
            <AlbumGrid items={filtered} variant={viewMode} showLastSeen />
          </div>
        </section>
      )}
      <div className="h-12" />
    </div>
  );
}
