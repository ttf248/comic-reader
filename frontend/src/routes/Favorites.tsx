import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSearchStore } from "../store/searchStore";
import { useUIStore } from "../store/uiStore";
import { useFavorites } from "../hooks/useFavorites";
import { useImageActivities } from "../hooks/useImageActivity";
import { useGalleryContextSync } from "../hooks/useGalleryContextSync";
import AlbumGrid, { type CardData } from "../components/album/AlbumGrid";
import AlbumGridSkeleton from "../components/album/AlbumGridSkeleton";
import { ListFilterBar } from "../components/common/ListFilterBar";
import EmptyState from "../components/common/EmptyState";
import { StarIcon } from "../components/common/Icon";
import { decodeFavPath } from "../utils/path";
import { compareDatesDesc } from "../utils/date";
import type { GalleryContextEntry } from "../utils/galleryContext";
import { useViewedSort } from "../hooks/useHistory";
import { useLibraryNodes, useLibraryTags } from "../hooks/useLibrary";
import {
  nodeSummaryToCard,
  tagSummaryToCard,
  cardMatchesQuery,
} from "../utils/libraryCard";

// 收藏页：合并 albums + smart collections 中的收藏。
// 支持搜索 + 排序 + 阅读进度展示。
export default function Favorites() {
  const navigate = useNavigate();
  const viewMode = useUIStore((s) => s.viewMode);
  const pushToast = useUIStore((s) => s.pushToast);
  const query = useSearchStore((s) => s.query);
  const sortBy = useSearchStore((s) => s.sortBy);
  const minImageCount = useSearchStore((s) => s.minImageCount);
  const favoritesQuery = useFavorites();
  const { favorites } = favoritesQuery;
  const needsHistory =
    sortBy === "viewed" && favorites.some((id) => id.startsWith("a_"));
  const { query: historyQuery, compareViewed } = useViewedSort(needsHistory);

  const nodeIds = useMemo(
    () => favorites.filter((id) => !id.startsWith("smart:")),
    [favorites],
  );
  const smartNames = useMemo(
    () =>
      favorites
        .filter((id) => id.startsWith("smart:"))
        .map((id) => id.slice(6)),
    [favorites],
  );
  const nodesQuery = useLibraryNodes(nodeIds);
  const tagsQuery = useLibraryTags(smartNames.length > 0);
  const nodesById = useMemo(
    () =>
      new Map((nodesQuery.data?.items ?? []).map((node) => [node.id, node])),
    [nodesQuery.data],
  );
  const tagsByName = useMemo(
    () => new Map((tagsQuery.data?.items ?? []).map((tag) => [tag.tag, tag])),
    [tagsQuery.data],
  );

  const cards = useMemo<CardData[]>(() => {
    const out: CardData[] = [];
    for (const f of favorites) {
      if (f.startsWith("smart:")) {
        const tagName = f.slice(6);
        const tag = tagsByName.get(tagName);
        if (!tag) continue;
        out.push({ ...tagSummaryToCard(tag), isFavorite: true });
        continue;
      }
      const node = nodesById.get(f);
      if (node) out.push({ ...nodeSummaryToCard(node), isFavorite: true });
    }
    return out;
  }, [favorites, nodesById, tagsByName]);

  const progressPaths = useMemo(
    () =>
      cards
        .filter((c) => c.variant === "album")
        .map((c) => decodeFavPath(c.to))
        .filter(Boolean),
    [cards],
  );
  const { data: progressMap } = useImageActivities(progressPaths);

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
        if (c.variant !== "album") return c;
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
      case "viewed":
        return list.sort(
          (a, b) =>
            compareViewed(decodeFavPath(a.to), decodeFavPath(b.to)) ||
            a.title.localeCompare(b.title),
        );
      case "recent":
        return list.sort(
          (a, b) =>
            compareDatesDesc(a.modTime, b.modTime) ||
            a.title.localeCompare(b.title),
        );
      default:
        return list.sort((a, b) => a.title.localeCompare(b.title));
    }
  }, [cards, query, sortBy, progressMap, compareViewed, minImageCount]);

  // 收藏页的上下文：只让真正的相册参与上一本/下一本（智能合集不是「可翻页」对象）
  const favEntries = useMemo<GalleryContextEntry[]>(
    () =>
      filtered
        .filter((c) => c.variant === "album")
        .map((c) => ({
          key: decodeFavPath(c.to),
          to: c.to,
          name: c.title,
          imageCount: c.imageCount,
          videoCount: c.videoCount,
        })),
    [filtered],
  );
  useGalleryContextSync({ type: "favorites" }, favEntries);

  const favoritesFailed = favoritesQuery.isError;
  const nodesFailed = nodeIds.length > 0 && nodesQuery.isError;
  const tagsFailed = smartNames.length > 0 && tagsQuery.isError;
  const historyFailed = needsHistory && historyQuery.isError;
  const loadFailed =
    favoritesFailed || nodesFailed || tagsFailed || historyFailed;
  const detailsLoading =
    (nodeIds.length > 0 && nodesQuery.isLoading) ||
    (smartNames.length > 0 && tagsQuery.isLoading);
  // 收藏里指向已不存在资源的 id（改名 / 移动过的相册）。
  // 详情还没查完时不能算：那时的 cards 为空只是"还没加载"，不是"找不到"。
  const missingIds = useMemo(() => {
    if (detailsLoading) return [];
    return favorites.filter((f) =>
      f.startsWith("smart:")
        ? !tagsByName.has(f.slice(6))
        : !nodesById.has(f),
    );
  }, [detailsLoading, favorites, nodesById, tagsByName]);
  const missingCount = missingIds.length;

  // 清理失效收藏：这些条目永远渲染不出来，留着只会让收藏页一直空着。
  const [cleaning, setCleaning] = useState(false);
  const onCleanMissing = async () => {
    if (!missingIds.length) return;
    setCleaning(true);
    try {
      for (const id of missingIds) await favoritesQuery.remove(id);
      pushToast({
        kind: "success",
        message: `已清理 ${missingIds.length} 项失效收藏`,
      });
    } catch {
      pushToast({ kind: "error", message: "清理失败，请稍后重试" });
    } finally {
      setCleaning(false);
    }
  };
  const retrying =
    favoritesQuery.isFetching ||
    (nodeIds.length > 0 && nodesQuery.isFetching) ||
    (smartNames.length > 0 && tagsQuery.isFetching) ||
    (needsHistory && historyQuery.isFetching);
  const retryLoad = () => {
    if (favoritesFailed) void favoritesQuery.refetch();
    if (nodesFailed) void nodesQuery.refetch();
    if (tagsFailed) void tagsQuery.refetch();
    if (historyFailed) void historyQuery.refetch();
  };

  return (
    <div className="min-h-full">
      <section className="page-shell pt-9 pb-6">
        <h1 className="page-title">
          我收藏的图像
        </h1>
        {/* 条数说的是"收藏了多少"，与网格里能显示几张无关：失效的收藏
            也是用户收藏过的。失效数量另起一行说明，避免出现"1 项"配一
            张空网格这种自相矛盾的读数。 */}
        <div className="flex items-baseline gap-2.5 mt-2 flex-wrap">
          <p className="text-[13px] text-fg-muted tabular-nums">
            {favoritesQuery.isLoading
              ? "正在加载收藏…"
              : favoritesFailed && favorites.length === 0
                ? "收藏暂不可用"
                : `${favorites.length} 项`}
          </p>
          {missingCount > 0 && (
            <span className="text-[12.5px] text-fg-subtle">
              其中 {missingCount} 项暂时找不到
            </span>
          )}
        </div>
      </section>

      {loadFailed && (
        <div className="page-shell mb-4">
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger/5 px-4 py-3 text-sm"
          >
            <p>
              {favoritesFailed
                ? "收藏加载失败。"
                : nodesFailed || tagsFailed
                  ? "收藏详情加载失败。"
                  : "最近访问加载失败，无法更新最近看排序。"}
              {cards.length > 0 ? "仍显示已加载的收藏。" : "请重试加载。"}
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

      {favoritesQuery.isLoading ? (
        <AlbumGridSkeleton variant={viewMode} label="正在加载收藏…" />
      ) : detailsLoading && cards.length === 0 ? (
        <AlbumGridSkeleton variant={viewMode} label="正在加载收藏…" />
      ) : loadFailed && cards.length === 0 ? null : favorites.length === 0 ? (
        <EmptyState
          title="还没有收藏"
          description="在主页或文件夹页点击卡片右上角的星标收藏，或右键点击卡片选择「收藏」。"
          icon={<StarIcon size={20} />}
          action={
            <button
              onClick={() => navigate("/")}
              className="btn btn-primary"
            >
              去主页看看
            </button>
          }
        />
      ) : cards.length === 0 ? (
        <EmptyState
          title={`收藏的 ${favorites.length} 项内容暂时找不到`}
          description="收藏记录的是相册的路径标识：相册被改名或移动后标识会变，旧收藏就找不到对应的内容了。回到主页重新点星标即可重新收藏。"
          icon={<StarIcon size={20} />}
          action={
            <div className="flex items-center gap-2.5 flex-wrap justify-center">
              {missingCount > 0 && (
                <button
                  onClick={onCleanMissing}
                  disabled={cleaning}
                  className="btn btn-outline"
                  title="移除这些永远渲染不出来的收藏条目"
                >
                  {cleaning ? "清理中…" : `清理 ${missingCount} 项失效收藏`}
                </button>
              )}
              <button onClick={() => navigate("/")} className="btn btn-primary">
                去主页看看
              </button>
            </div>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="没有匹配的收藏"
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
            {/* 收藏是"精选陈列"，不是"全量浏览"：用 2:3 海报比例 + 更疏的网格，
            与未读 / 最近 / 全部图像的密集 4:5 清单区分开。 */}
            <AlbumGrid
              items={filtered}
              variant={viewMode}
              coverRatio="2/3"
              cardMinWidth={224}
            />
          </div>
        </section>
      )}
      <div className="h-12" />
    </div>
  );
}
