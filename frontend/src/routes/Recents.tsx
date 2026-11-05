import PageHeading from "../components/common/PageHeading";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useSearchStore } from "../store/searchStore";
import { useUIStore } from "../store/uiStore";
import { useHistoryCards } from "../hooks/useHistory";
import { useImageActivities } from "../hooks/useImageActivity";
import { useAppMode } from "../hooks/useAppMode";
import { workbenchCopy } from "../utils/workbench";
import { useGalleryContextSync } from "../hooks/useGalleryContextSync";
import AlbumGrid from "../components/album/AlbumGrid";
import AlbumGridSkeleton from "../components/album/AlbumGridSkeleton";
import { ListFilterBar } from "../components/common/ListFilterBar";
import EmptyState from "../components/common/EmptyState";
import { ClockIcon } from "../components/common/Icon";
import { decodeFavPath, homeRoute } from "../utils/path";
import { compareDatesDesc, formatRelative } from "../utils/date";
import type { GalleryContextEntry } from "../utils/galleryContext";
import { cardMatchesQuery } from "../utils/libraryCard";

// 最近访问：从后端 history 列表中读取。带阅读进度。
export default function Recents() {
  const navigate = useNavigate();
  const viewMode = useUIStore((s) => s.viewMode);
  const query = useSearchStore((s) => s.query);
  const sortBy = useSearchStore((s) => s.sortBy);
  const minImageCount = useSearchStore((s) => s.minImageCount);

  const { mode } = useAppMode();
  const copy = workbenchCopy(mode);

  // 访问历史按当前工作台收敛：照片侧只列照片相册。
  const { history, cards, resolvedCount, historyQuery, nodesQuery } =
    useHistoryCards(mode);

  const progressPaths = useMemo(
    () => cards.map((c) => decodeFavPath(c.to)).filter(Boolean),
    [cards],
  );
  // 阅读进度只属于漫画相册。
  const { data: imageProgressMap } = useImageActivities(progressPaths);

  const filtered = useMemo(() => {
    const list = cards
      .filter((it) => {
        if (!query) return true;
        const q = query.toLowerCase();
        return cardMatchesQuery(it, q);
      })
      // 最小图数过滤(全局 filter)
      .filter((it) => {
        if (minImageCount <= 0) return true;
        if (it.variant !== "album") return true;
        return (it.count ?? 0) >= minImageCount;
      })
      .map((c) => {
        const k = decodeFavPath(c.to);
        // 阅读进度只属于漫画相册。
        if (c.contentKind !== "comic") return c;
        const p = imageProgressMap?.[k];
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
  }, [cards, query, sortBy, imageProgressMap, minImageCount]);

  const recentsEntries = useMemo<GalleryContextEntry[]>(
    () =>
      filtered.map((c) => ({
        key: decodeFavPath(c.to),
        to: c.to,
        name: c.title,
        imageCount: c.imageCount,
        videoCount: c.videoCount,
        contentKind: c.contentKind,
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
      <PageHeading
        title={copy.recentsTitle}
        eyebrow={copy.recentsEyebrow}
        description={
          <p className="text-body text-fg-muted mt-2 tabular-nums">
            {cards.length > 0 ? (
              <>
                <span className="text-fg font-medium">{cards.length}</span> 个
                <span className="text-fg-subtle mx-1.5">·</span>
                最近打开{" "}
                <span className="text-fg">
                  {formatRelative(cards[0]?.lastSeenAt)}
                </span>
              </>
            ) : historyQuery.isLoading ||
            (history.length > 0 && nodesQuery.isLoading) ? (
              // 记录已经在手、只是相册摘要还没到：这时说「还没有记录」
              // 是把「还没加载完」说成了「没有」。
              "正在加载记录…"
            ) : historyFailed ? (
              "记录暂不可用"
            ) : (
              "还没有记录"
            )}
          </p>
        }
      />

      {loadFailed && (
        <div className="page-shell mb-4">
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-body"
          >
            <p>
              {historyFailed
                ? copy.recentsLoadError
                : copy.recentsAlbumsLoadError}
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
        <AlbumGridSkeleton variant={viewMode} label={`正在加载${copy.recentsTitle}…`} />
      ) : history.length > 0 && nodesQuery.isLoading && cards.length === 0 ? (
        <AlbumGridSkeleton variant={viewMode} label={`正在加载${copy.recentsTitle}…`} />
      ) : loadFailed && cards.length === 0 ? null : cards.length === 0 ? (
        // 这一侧没有记录。两种成因给两种说法：访问过的相册全被移出
        // 媒体库了，说「可能已移动」；这些记录全都属于另一侧，就只说
        // 「还没有记录」——照片侧不该知道漫画那边有人翻过书。
        history.length > 0 && resolvedCount === 0 ? (
          <EmptyState
            title="最近访问的相册暂不可用"
            description="相册可能已移动，或媒体库尚未完成扫描。"
            action={
              <button onClick={() => navigate(homeRoute(mode))} className="btn btn-outline">
                去主页看看
              </button>
            }
          />
        ) : (
          <EmptyState
            title={copy.recentsEmpty}
            description="打开任意一个文件夹开始浏览，它会出现在这里。"
            icon={<ClockIcon size={20} />}
            action={
              <button onClick={() => navigate(homeRoute(mode))} className="btn btn-primary">
                去主页看看
              </button>
            }
          />
        )
      ) : filtered.length === 0 ? (
        <EmptyState
          title="没有匹配的最近访问"
          description={query ? `没有匹配"${query}"的结果` : ""}
          action={
            <button
              onClick={() => useSearchStore.getState().reset()}
              className="btn btn-outline"
            >
              清除筛选
            </button>
          }
        />
      ) : (
        <section className="page-shell">
          <div className="pb-10">
            <AlbumGrid items={filtered} variant={viewMode} showLastSeen />
          </div>
        </section>
      )}
      <div className="h-8" />
    </div>
  );
}
