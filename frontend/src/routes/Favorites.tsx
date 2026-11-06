import PageHeading from "../components/common/PageHeading";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSearchStore } from "../store/searchStore";
import { useUIStore } from "../store/uiStore";
import { useFavorites } from "../hooks/useFavorites";
import { useImageActivities } from "../hooks/useImageActivity";
import { useAppMode } from "../hooks/useAppMode";
import { workbenchCopy, coverRatioForMode } from "../utils/workbench";
import { useGalleryContextSync } from "../hooks/useGalleryContextSync";
import AlbumGrid, { type CardData } from "../components/album/AlbumGrid";
import AlbumCard from "../components/album/AlbumCard";
import AlbumGridSkeleton from "../components/album/AlbumGridSkeleton";
import { ListFilterBar } from "../components/common/ListFilterBar";
import EmptyState from "../components/common/EmptyState";
import { StarIcon } from "../components/common/Icon";
import { decodeFavPath, homeRoute } from "../utils/path";
import { compareDatesDesc } from "../utils/date";
import type { GalleryContextEntry } from "../utils/galleryContext";
import { useViewedSort } from "../hooks/useHistory";
import {
  useLibraryDashboard,
  useLibraryRecentAlbums,
} from "../hooks/useLibrary";
import { useFavoritesByMode } from "../hooks/useFavoritesByMode";
import { nodeSummaryToCard, cardMatchesQuery } from "../utils/libraryCard";

// 收藏页：合并 albums + smart collections 中的收藏。
// 支持搜索 + 排序 + 阅读进度展示。

/**
 * 空态推荐位的单本宽度。
 *
 * 用 flex-1 铺满整行：条目少时把行填满（不留右侧空白），条目多时
 * 收窄到上限并横向滚动。与首页「未读」货架同一套策略。
 */
const SUGGEST_WIDTH = "flex-1 min-w-[148px] max-w-[240px]";

export default function Favorites() {
  const navigate = useNavigate();
  const viewMode = useUIStore((s) => s.viewMode);
  const pushToast = useUIStore((s) => s.pushToast);
  const { mode, setMode } = useAppMode();
  const copy = workbenchCopy(mode);
  // 收藏在另一侧时，指向那一侧的库名与切换动作。
  const otherMode = mode === "comic" ? "photo" : "comic";
  const otherLibraryTitle = workbenchCopy(otherMode).libraryTitle;
  const query = useSearchStore((s) => s.query);
  const sortBy = useSearchStore((s) => s.sortBy);
  const minImageCount = useSearchStore((s) => s.minImageCount);
  const favoritesQuery = useFavorites();
  const { favorites } = favoritesQuery;
  const needsHistory =
    sortBy === "viewed" && favorites.some((id) => id.startsWith("a_"));
  const { query: historyQuery, compareViewed } = useViewedSort(needsHistory);

  // 收藏按工作台拆开看：另一个工作台的内容一条都不出现，
  // 「失效」也只看库里是不是真的没有了。
  const {
    cards,
    count: favoritesCount,
    missingIds,
    nodesFailed,
    tagsFailed,
    detailsLoading,
    retry: retryFavorites,
  } = useFavoritesByMode(mode);

  // 空态推荐位：给当前这一侧「现在可以马上收藏的东西」。
  // 漫画侧是还没翻开的漫画；照片侧没有阅读进度，改推最近加入的照片。
  const dashboardQuery = useLibraryDashboard();
  const recentQuery = useLibraryRecentAlbums(mode, 6);
  const suggestions = useMemo<CardData[]>(() => {
    if (mode === "comic") {
      return (dashboardQuery.data?.dashboard?.unread ?? [])
        .slice(0, 6)
        .map((album) => nodeSummaryToCard(album, "u:"));
    }
    return (recentQuery.data?.page.items ?? [])
      .slice(0, 6)
      .map((album) => nodeSummaryToCard(album, "r:"));
  }, [mode, dashboardQuery.data, recentQuery.data]);

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
        // 阅读进度只属于漫画相册。
        if (c.contentKind !== "comic") return c;
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
  }, [
    cards,
    query,
    sortBy,
    progressMap,
    compareViewed,
    minImageCount,
  ]);

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
          contentKind: c.contentKind,
        })),
    [filtered],
  );
  useGalleryContextSync({ type: "favorites" }, favEntries);

  const favoritesFailed = favoritesQuery.isError;
  const historyFailed = needsHistory && historyQuery.isError;
  const loadFailed =
    favoritesFailed || nodesFailed || tagsFailed || historyFailed;
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
    (needsHistory && historyQuery.isFetching);
  const retryLoad = () => {
    retryFavorites();
    if (historyFailed) void historyQuery.refetch();
  };

  return (
    <div className="min-h-full">
      <PageHeading
        title={copy.favoritesTitle}
        eyebrow="值得反复翻看的"
        description={
          <div className="flex items-baseline gap-2.5 mt-2 flex-wrap">
            <p className="text-body text-fg-muted tabular-nums">
              {favoritesQuery.isLoading
                ? "正在加载收藏…"
                : favoritesFailed && favorites.length === 0
                  ? "收藏暂不可用"
                  : `${favoritesCount} 项`}
            </p>
            {missingCount > 0 && (
              <span className="text-meta text-fg-subtle">
                其中 {missingCount} 项暂时找不到
              </span>
            )}
          </div>
        }
      />

      {loadFailed && (
        <div className="page-shell mb-4">
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger/5 px-4 py-3 text-body"
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
        <>
          <EmptyState
            title={copy.favoritesEmpty}
            description="收藏是给相册打星标：点封面右上角的星标，这一本就会出现在这里。下面这几本可以直接点星标试试。"
            icon={<StarIcon size={20} />}
            action={
              <button onClick={() => navigate(homeRoute(mode))} className="btn btn-primary">
                去主页看看
              </button>
            }
            dense={suggestions.length > 0}
          />
          {/* 空态不能只是一句话加一个按钮：整页会剩下一大片无意义的空白。
              这里直接把「可收藏的对象」摆出来 —— 一排真实封面 + 常驻的
              星标，用户点一下就完成收藏，不必先去主页找。 */}
          {suggestions.length > 0 && (
            <section className="page-shell pb-14">
              <div className="flex items-baseline gap-3 flex-wrap mb-4">
                <h2 className="section-title">从这里挑一个收藏</h2>
                <span className="section-meta">点封面右上角的星标</span>
              </div>
              <div className="shelf">
                {suggestions.map((card) => (
                  <div key={card.id} className={SUGGEST_WIDTH}>
                    <AlbumCard
                      data={card}
                      /* 星标常驻：这排封面的作用就是教用户点哪里 */
                      alwaysShowFavorite
                      /* 整排都是未读，"新"角标是噪音 */
                      showUnreadBadge={false}
                      /* 画幅跟着工作台：照片方形，漫画竖版 */
                      coverRatio={coverRatioForMode(mode)}
                    />
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      ) : cards.length === 0 ? (
        missingCount > 0 ? (
          <EmptyState
            title={`收藏的 ${favorites.length} 项内容暂时找不到`}
            description="相册被改名或移动之后，这一条收藏就对不上了。回到主页找到这本相册，重新点一下星标就能再收藏。"
            icon={<StarIcon size={20} />}
            action={
              <div className="flex items-center gap-2.5 flex-wrap justify-center">
                <button
                  onClick={onCleanMissing}
                  disabled={cleaning}
                  className="btn btn-outline"
                  title="移除这些永远渲染不出来的收藏条目"
                >
                  {cleaning ? "清理中…" : `清理 ${missingCount} 项失效收藏`}
                </button>
                <button
                  onClick={() => navigate(homeRoute(mode))}
                  className="btn btn-primary"
                >
                  去主页看看
                </button>
              </div>
            }
          />
        ) : (
          /* 收藏一条都没坏，只是不在这一侧：照片工作台收藏的相册，
             在漫画工作台里当然一条都看不到。这时候说「暂时找不到」
             是冤枉了用户的收藏，还给出「清理失效收藏」的手柄 ——
             点下去会把另一侧好好的一条收藏删掉。
             正确的话是「它们都在那一侧」，并给一个切换过去的入口。 */
          <EmptyState
            title={`收藏都在${otherLibraryTitle}那边`}
            description={`这一侧还没有收藏。已收藏的 ${favorites.length} 项属于${otherLibraryTitle}，切过去就能看到。`}
            icon={<StarIcon size={20} />}
            action={
              <button
                onClick={() => setMode(otherMode)}
                className="btn btn-primary"
              >
                去{otherLibraryTitle}看看
              </button>
            }
          />
        )
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
            {/* 收藏是"精选陈列"，不是"全量浏览"：用更疏的网格，
            与未读 / 最近 / 全部图像的密集清单区分开。 */}
            <AlbumGrid
              items={filtered}
              variant={viewMode}
              cardMinWidth={224}
            />
          </div>
        </section>
      )}
      <div className="h-12" />
    </div>
  );
}
