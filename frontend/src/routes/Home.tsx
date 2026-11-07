import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { useSearchStore } from "../store/searchStore";
import { useScanSSE } from "../hooks/useScanSSE";
import { useFavoritesByMode } from "../hooks/useFavoritesByMode";
import { useMarkAlbumRead, useMarkAlbumsRead } from "../hooks/useImageActivity";
import { useGalleryContextSync } from "../hooks/useGalleryContextSync";
import { scanApi } from "../api/scan";
import { useHistoryCards, useViewedSort } from "../hooks/useHistory";
import { libraryApi } from "../api/library";
import AlbumGrid, { type CardData } from "../components/album/AlbumGrid";
import AlbumGridSkeleton from "../components/album/AlbumGridSkeleton";
import { ListFilterBar } from "../components/common/ListFilterBar";
import EmptyState from "../components/common/EmptyState";
import ViewedSortNotice from "../components/common/ViewedSortNotice";
import YearTimeline from "../components/home/YearTimeline";
import SeriesTimeline from "../components/home/SeriesTimeline";
import { ContinueHero, UnreadHero } from "../components/home/HomeHeroes";
import {
  RecentlyAddedHero,
  SerendipityHero,
} from "../components/home/PhotoHeroes";
import ResumeHero from "../components/home/ResumeHero";
import { useSerendipityAlbum } from "../hooks/useSerendipityAlbum";
import { useUIStore } from "../store/uiStore";
import { useAppMode } from "../hooks/useAppMode";
import { comicCopy, workbenchCopy } from "../utils/workbench";
import {
  albumRoute,
  decodeFavPath,
  favoritesRoute,
  homeRoute,
  recentsRoute,
  unreadRoute,
} from "../utils/path";
import { continueReadingTarget } from "../utils/continueReading";
import { compareDatesDesc } from "../utils/date";
import { compareByAdded } from "../utils/cardSorting";
import type { GalleryContextEntry } from "../utils/galleryContext";
import {
  groupLibraryNodesBySeries,
  groupLibraryNodesByYear,
  type SeriesGroup,
  type YearGroup,
} from "../utils/albumGrouping";
import {
  useLibraryDashboard,
  useLibraryOverview,
  useLibraryRecentAlbums,
} from "../hooks/useLibrary";
import {
  libraryOverviewCards,
  nodeSummaryToCard,
  cardMatchesQuery,
} from "../utils/libraryCard";
import {
  StarIcon,
  ShuffleIcon,
  RefreshIcon,
  LibraryIcon,
  ClockIcon,
  CloseIcon,
  ImageIcon,
  SparkleIcon,
} from "../components/common/Icon";

export default function Home() {
  const navigate = useNavigate();
  const overview = useLibraryOverview();
  const manifest = overview.manifest;
  const dashboardQuery = useLibraryDashboard();
  const dashboard = dashboardQuery.data?.dashboard;
  const sse = useScanSSE();
  const pushToast = useUIStore((s) => s.pushToast);
  const { mode } = useAppMode();
  const copy = workbenchCopy(mode);

  // "全部图像" section 的 ref：年份筛选触发后自动滚到这里
  const gridRef = useRef<HTMLDivElement>(null);

  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const sortBy = useSearchStore((s) => s.sortBy);
  const view = useSearchStore((s) => s.view);
  const setView = useSearchStore((s) => s.setView);
  const yearFilter = useSearchStore((s) => s.yearFilter);
  const setYearFilter = useSearchStore((s) => s.setYearFilter);
  const setMinImageCount = useSearchStore((s) => s.setMinImageCount);
  const setSortBy = useSearchStore((s) => s.setSortBy);
  const viewMode = useUIStore((s) => s.viewMode);

  // 收藏数按当前工作台算：照片工作台的「N 收藏」不该把漫画收藏算进去。
  const { count: favCount } = useFavoritesByMode(mode);
  // 未读与继续阅读只属于漫画工作台：照片这边不出现这两个区。
  const isComic = mode === "comic";
  // 首页只展示服务端预先限制为六本的未读预览；完整未读库交给 /unread 分页加载。
  const unreadCards = useMemo<CardData[]>(
    () =>
      isComic
        ? (dashboard?.unread ?? []).map((album) => ({
            ...nodeSummaryToCard(album, "u:"),
            progress: { index: 0, total: album.imageCount ?? 0 },
          }))
        : [],
    [dashboard, isComic],
  );
  const unreadCount = isComic ? (dashboard?.unreadCount ?? 0) : 0;
  // 照片侧的首屏专区：接着看 + 最近加入 + 随手看看。它们与漫画侧的
  // 「继续阅读 / 未读」一一对应，但内容完全不同：漫画有进度与已读，
  // 照片只有「上次打开过哪本」。
  const recentAlbums = useLibraryRecentAlbums(mode, 8, !isComic);
  const serendipity = useSerendipityAlbum(!isComic);
  // 「接着看」的数据是访问历史：照片相册其实一直在记，只是原先只有
  // 「最近浏览」页在用。
  const resumeCards = useHistoryCards(mode, !isComic).cards;
  const recentItems = useMemo(
    () => recentAlbums.data?.page.items ?? [],
    [recentAlbums.data],
  );
  const recentTotal = recentAlbums.data?.page.total ?? recentItems.length;
  // 「最近加入」的「全部」：把首页网格按加入时间排好并滚过去。
  // 这一区讲的是「最近加入」，点进去却是「最近看」，说的与做的不一致；
  // 现在它落到同一个口径的排序上 —— 排序条上也会显示「按加入时间」。
  const showAllRecent = useCallback(() => {
    setSortBy("added");
    requestAnimationFrame(() =>
      gridRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      }),
    );
  }, [setSortBy]);
  const dashboardProgressByID = useMemo(
    () =>
      new Map(
        (dashboard?.inProgress ?? []).map((progress) => [
          progress.album.id,
          progress,
        ]),
      ),
    [dashboard],
  );
  const needsHistory =
    sortBy === "viewed" && overview.nodes.some((node) => node.kind === "album");
  const { query: historyQuery, compareViewed } = useViewedSort(needsHistory);

  const startScan = useMutation({
    mutationFn: () => scanApi.start(),
    onSuccess: (r) => {
      sse.startWith(r.scanId);
      pushToast({ kind: "info", message: "扫描已开始" });
    },
    onError: () => pushToast({ kind: "error", message: "启动扫描失败" }),
  });

  const randomAlbum = useMutation({
    mutationFn: (scope: "any" | "unread") =>
      libraryApi.randomAlbums(mode, scope),
    onSuccess: ({ albums }) => {
      const album = albums[0];
      if (album) navigate(albumRoute(mode, album.id));
    },
    onError: (_error, scope) =>
      pushToast({
        kind: "info",
        message: scope === "unread" ? "没有未读相册可跳" : "尚未加载图像库",
      }),
  });
  const onShuffle = () => randomAlbum.mutate("any");
  const onShuffleUnread = () => randomAlbum.mutate("unread");

  // 「继续阅读」管理：单本标记已读 / 一键全部标记已读。
  //
  // 关键决策：这里也走 mark-as-read（与「未读」一致），不走 DELETE。
  // 原因：DELETE 删完 record 会变成「无 record」状态，立刻被「未读」判定
  // 收编，给人「清空换皮出现」的错觉。mark-as-read 把 progress 推到 total，
  // 配合 isInProgress 过滤（index < total 才算在读），这本就直接从首页两
  // 个 hero 都消失。
  //
  // 真要「忘记这本」时仍可调 DELETE（后端保留），但 UI 上不再用。
  const markReadContinue = useMarkAlbumRead();
  const markReadAllContinue = useMarkAlbumsRead();
  const onRemoveContinue = (card: CardData) => {
    const albumId = decodeFavPath(card.to);
    const total = card.progress?.total ?? 0;
    if (total <= 0) {
      pushToast({ kind: "error", message: "该相册为空，无法标记" });
      return;
    }
    markReadContinue.mutate(
      { albumId, total },
      {
        onSuccess: () =>
          pushToast({
            kind: "info",
            message: `已将「${card.title}」标记为已读完`,
          }),
        onError: () =>
          pushToast({ kind: "error", message: "标记失败，请重试" }),
      },
    );
  };
  const onClearContinue = () => {
    if (!inProgressAll.length) return;
    const ok = window.confirm(
      `将 ${inProgressAll.length} 本相册全部标记为已读完？\n\n操作不会删除文件，只是把阅读进度推到末尾。`,
    );
    if (!ok) return;
    const items = inProgressAll.map((c) => ({
      albumId: decodeFavPath(c.to),
      total: c.progress?.total ?? 0,
    }));
    markReadAllContinue.mutate(items, {
      onSuccess: (r) => {
        if (r.failed === 0) {
          pushToast({ kind: "info", message: `已将 ${r.ok} 本标记为已读完` });
        } else {
          pushToast({
            kind: "error",
            message: `已标记 ${r.ok} 本，失败 ${r.failed} 本`,
          });
        }
      },
      onError: () => pushToast({ kind: "error", message: "标记失败，请重试" }),
    });
  };

  // 「未读」管理：单本标记已读。
  // 语义上「标记已读」= 把 progress 推到 index=total（与 AlbumCard 右键
  // 「标记为已读」一致）。不是删除 record — 保留"已读完"的痕迹，未来
  // Recents / Favorites / 历史面板能继续看到。
  const markReadOne = useMarkAlbumRead();
  const onMarkReadUnread = (card: CardData) => {
    const albumId = decodeFavPath(card.to);
    const total = card.progress?.total ?? 0;
    if (total <= 0) {
      pushToast({ kind: "error", message: "该相册为空，无法标记" });
      return;
    }
    markReadOne.mutate(
      { albumId, total },
      {
        onSuccess: () =>
          pushToast({
            kind: "info",
            message: `已将「${card.title}」标记为已读完`,
          }),
        onError: () =>
          pushToast({ kind: "error", message: "标记失败，请重试" }),
      },
    );
  };
  const cards = useMemo(
    () => libraryOverviewCards(overview.nodes, overview.tags, mode),
    [overview.nodes, overview.tags, mode],
  );

  // 在读列表由首页仪表盘提供，按最后阅读时间倒序且包含任意层级的相册。
  const inProgressAll = useMemo<CardData[]>(() => {
    return (dashboard?.inProgress ?? []).map((progress) => ({
      ...nodeSummaryToCard(progress.album),
      progress: { index: progress.pageIndex, total: progress.pageCount },
    }));
  }, [dashboard]);

  // 时光轴：按年份分组（画廊模式，替代早期"全新/重温/最近加入"的分区）
  const yearGroups = useMemo<YearGroup[]>(
    () => groupLibraryNodesByYear(overview.nodes),
    [overview.nodes],
  );

  // 漫画侧按连载分组：漫画常常不以年份命名，按年份分会把同一部作品
  // 拆散在好几处。照片侧不分组 —— 照片的天然维度是时间。
  const seriesGroups = useMemo<SeriesGroup[]>(
    () => (isComic ? groupLibraryNodesBySeries(overview.nodes) : []),
    [overview.nodes, isComic],
  );

  // 切换视图到 collection/smart 时清掉 yearFilter（年份只对 album 有意义）
  useEffect(() => {
    if (yearFilter !== null && view !== "all" && view !== "album") {
      setYearFilter(null);
    }
  }, [view, yearFilter, setYearFilter]);

  // 全部图像 filter（视图 + 搜索 + 年份筛选 + 最小图数 + 排序）
  const yearFilterActive =
    yearFilter !== null && (view === "all" || view === "album");
  const minImageCount = useSearchStore((s) => s.minImageCount);
  // 除「视图」以外的所有筛选（搜索 / 年份 / 最少图数）。
  // 视图 chip 上的计数按这一层算：年份筛选生效时，chip 上的「相册 14」
  // 与屏幕上剩下的两件对不上号 —— 数字要回答「点它会得到几件」。
  const filteredByScope = useMemo(() => {
    return cards.filter((it) => {
      // 最小图数过滤:仅对 album 变体生效;collection / smart 走 albumCount 概念,
      // 不参与图数过滤(它们的「张数」语义不同)。
      if (
        minImageCount > 0 &&
        it.variant === "album" &&
        (it.count ?? 0) < minImageCount
      ) {
        return false;
      }
      // 年份筛选：用 item 自身的 title 提取年份来匹配。
      // collection/smart 自身也可能没有年份（或有），让 extractYear 自然处理，
      // 避免把"萍乡中学"这种没年份的 collection 因为不是 album 就被误删。
      if (yearFilterActive) {
        if (yearFilter === "other") {
          if (extractYearOrNull(it.title) !== null) return false;
        } else if (typeof yearFilter === "number") {
          if (extractYearOrNull(it.title) !== yearFilter) return false;
        }
      }
      if (query) {
        if (!cardMatchesQuery(it, query)) return false;
      }
      return true;
    });
  }, [cards, query, yearFilter, yearFilterActive, minImageCount]);
  const filtered = useMemo(() => {
    const list = filteredByScope.filter((it) => {
      if (view !== "all" && it.variant !== view) return false;
      return true;
    });
    const withProgress = list.map((c) => {
      if (c.variant !== "album") return c;
      const k = decodeFavPath(c.to);
      const p = dashboardProgressByID.get(k);
      if (!p) return c;
      return {
        ...c,
        progress: { index: p.pageIndex, total: p.pageCount },
      };
    });
    switch (sortBy) {
      case "count":
        return withProgress.sort((a, b) => b.count - a.count);
      case "added":
        return withProgress.sort(
          (a, b) => compareByAdded(a, b) || a.title.localeCompare(b.title),
        );
      case "recent":
        return withProgress.sort(
          (a, b) =>
            compareDatesDesc(a.modTime, b.modTime) ||
            a.title.localeCompare(b.title),
        );
      case "viewed":
        return withProgress.sort(
          (a, b) =>
            compareViewed(decodeFavPath(a.to), decodeFavPath(b.to)) ||
            a.title.localeCompare(b.title),
        );
      default:
        return withProgress.sort((a, b) => a.title.localeCompare(b.title));
    }
  }, [filteredByScope, sortBy, view, dashboardProgressByID, compareViewed]);

  const homeEntries = useMemo<GalleryContextEntry[]>(
    () =>
      filtered
        .filter((c) => c.variant === "album")
        .map((c) => ({
          key: decodeFavPath(c.to),
          to: c.to,
          name: c.title,
          parentName: c.parentName,
          imageCount: c.imageCount,
          videoCount: c.videoCount,
          contentKind: c.contentKind,
        })),
    [filtered],
  );
  useGalleryContextSync({ type: "home" }, homeEntries);

  const counts = useMemo(() => {
    // 视图 chip 上的数字要跟着当前筛选走：年份筛选生效时，「相册 14」
    // 与屏幕上剩下的两件对不上号。数字按「除视图以外的所有筛选」来算，
    // 于是每一枚 chip 报的都是「点它会得到几件」。
    const c = {
      all: filteredByScope.length,
      album: 0,
      collection: 0,
      smart: 0,
    };
    for (const it of filteredByScope) c[it.variant]++;
    return c;
  }, [filteredByScope]);

  const isLoadingInitial =
    overview.isLoading ||
    dashboardQuery.isLoading ||
    (!manifest && !!(sse.isRunning || sse.scanId));
  const hasContent = !!manifest && cards.length > 0;
  // 「这一侧没有内容」和「整个库还没内容」是两回事：媒体根可能全被设成
  // 漫画属性，照片工作台就一部都没有，但库本身是扫过的。
  // 两种情况给的引导不一样：前者该把人送去设置里改属性或去另一侧看看，
  // 后者才是「去设置媒体目录」。
  const libraryHasContent = (manifest?.statistics.albumCount ?? 0) > 0;
  const sideHasContent = isComic
    ? (manifest?.statistics.comicAlbumCount ?? 0) > 0
    : (manifest?.statistics.photoAlbumCount ?? 0) > 0;
  const otherSideHasContent = isComic
    ? (manifest?.statistics.photoAlbumCount ?? 0) > 0
    : (manifest?.statistics.comicAlbumCount ?? 0) > 0;
  // 漫画侧多一条「作品」索引，章节序号因此往后挪一位。
  const hasSeriesIndex = hasContent && isComic && seriesGroups.length > 0;
  // 年份时间线：照片侧是这一侧的主索引（按年份浏览），有内容就摆；
  // 漫画侧的主索引是「作品」，年份只是一条附带的筛选 —— 只剩「其他」
  // 一桶时它筛不出任何东西，是装饰不是索引（漫画的卷常常不以年份
  // 命名，全落进「其他」）。
  const realYearBuckets = yearGroups.filter((g) => g.year !== null).length;
  const hasYearIndex =
    hasContent && (isComic ? realYearBuckets >= 2 : yearGroups.length > 0);
  // 章节序号跟着实际出现的索引走：少一段，后面的序号要往前挪。
  const sectionNo = {
    series: hasSeriesIndex ? 1 : 0,
    year: hasSeriesIndex ? 2 : 1,
    library: (hasSeriesIndex ? 1 : 0) + (hasYearIndex ? 1 : 0) + 1,
  };
  const pad = (n: number) => String(n).padStart(2, "0");

  // 主 CTA：有进度 → 继续上次；否则 → 随机翻翻
  //
  // 照片侧没有进度，但有「上次打开过的那本」：它就是照片侧的主 CTA，
  // 与漫画侧的「继续阅读」位置对等。
  const primaryAlbum = inProgressAll[0];
  const hasPrimaryEntry = isComic ? !!primaryAlbum : resumeCards.length > 0;
  const scanLabel = sse.isRunning
    ? "扫描中…"
    : startScan.isPending
      ? "启动中…"
      : "重新扫描";

  // 库规模：按当前工作台算，这一侧只有多少相册、多少集合。
  // 库规模的说法跟着侧走：漫画侧是「卷」与「作品」，照片侧是「本相册」
  // 与「集合」—— 两侧的词不统一，用户读到「0 本漫画」会以为漫画也按
  // 相册计数。
  //
  // 前缀「全库」是必要的：下面的网格只列媒体根的直属子项（顶层相册、
  // 集合与标签），页头这个数却把各层集合里的相册都算上了。两个数摆在
  // 同一屏却各说各话时，用户只会以为其中一个是错的 —— 说清口径，
  // 「全库 116 本」与下面的「38 项」就不再打架。
  const librarySize = manifest
    ? isComic
      ? `全库 ${manifest.statistics.comicAlbumCount ?? 0} 卷、${manifest.statistics.comicCollectionCount ?? 0} 个作品`
      : `全库 ${manifest.statistics.photoAlbumCount ?? 0} 本相册、${manifest.statistics.photoCollectionCount ?? 0} 个集合`
    : "";

  // 「继续上次」直跳画廊：进首页最大的目的是「接着看」，
  // 中转 Album 详情会多一次点击，对随手翻翻的场景不友好。
  // 跳转目标的拼装集中在 utils/continueReading.ts，侧栏的迷你卡复用同一份逻辑。
  const onContinue = (card: CardData) => {
    navigate(continueReadingTarget(card));
  };

  // 年份筛选的"全部图像"section 顶部 chip
  const yearFilterLabel = yearFilter === "other" ? "其他" : String(yearFilter);

  // 当前视图的名字（空结果时要说清是哪个筛选把内容筛没了）。
  const viewLabel =
    view === "album"
      ? copy.albumTypeLabel
      : view === "collection"
        ? copy.collectionTypeLabel
        : "标签";
  // 真正生效的筛选有几条：空结果时每条都给一个单独的手柄。
  const activeFilterCount =
    (yearFilterActive ? 1 : 0) +
    (view !== "all" ? 1 : 0) +
    (query ? 1 : 0) +
    (minImageCount > 0 ? 1 : 0);

  return (
    <div className="home-page min-h-full">
      {/* ScanProgress 已提升到 AppShell，跨路由常驻显示 */}

      {/* === 页头：标题 + 库统计 + 次级入口 === */}
      <section className="page-shell page-heading">
        <div className="flex items-end justify-between gap-6 flex-wrap">
          <div className="min-w-0">
            <p className="page-eyebrow">{copy.libraryEyebrow}</p>
            <h1 className="page-title">{copy.libraryTitle}</h1>
            <p className="text-body text-fg-muted mt-2">
              {manifest ? (
                <>
                  {/* 分隔用中文标点，不用「·」：西文间隔号在换行时不受
                      行首禁则约束，窄屏上会孤零零地站在行头。中文的
                      「，」「、」由浏览器按行首禁则处理，不会被甩到
                      下一行行首。 */}
                  <span>{copy.libraryDescription}</span>
                  <span className="text-fg-subtle">，</span>
                  {/* 库规模属于当前工作台：这一侧只有多少相册、多少集合。
                      它原来常驻顶栏，与这里、以及状态栏的「上次扫描」
                      是同一组上下文散在三处 —— 收进页头，只说一次。 */}
                  <span className="tabular-nums">{librarySize}</span>
                  {manifest.scannedAt && (
                    <>
                      <span className="text-fg-subtle">，</span>
                      <span className="text-fg-subtle">
                        上次更新 {formatTime(manifest.scannedAt)}
                      </span>
                    </>
                  )}
                </>
              ) : (
                "尚未加载图像库"
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => startScan.mutate()}
              disabled={startScan.isPending || sse.isRunning}
              className="btn btn-sm btn-outline"
              title="扫描 (Ctrl+S)"
              aria-label={scanLabel}
            >
              <RefreshIcon size={13} />
              {/* 窄屏上按钮独占一行、与标题分开，字数多反而更占地方：
                  收成一枚图标，靠 title 与无障碍名称说清它是什么。 */}
              <span className="hidden sm:inline">{scanLabel}</span>
            </button>
          </div>
        </div>

        {/* 次级入口：没有在读内容时，「随机一卷」升为主操作。
            有在读内容时它退到次级，避免和「继续阅读」抢主位。
            照片侧的对应物是「接着看」。
            这一侧一部都没有时整块不出现：那里放着一枚点不动的按钮，
            读起来像坏了。 */}
        {!hasPrimaryEntry && hasContent && (
          <div className="mt-5 flex items-center gap-2 flex-wrap">
            <button
              onClick={onShuffle}
              disabled={!hasContent}
              className="btn btn-primary"
            >
              <ShuffleIcon size={14} />
              {copy.randomLabel}
              <span className="text-meta opacity-70">R</span>
            </button>
            {isComic && (
              <QuickLink
                to={unreadRoute()}
                icon={<SparkleIcon size={14} />}
                count={unreadCount > 0 ? unreadCount : undefined}
              >
                {comicCopy().unreadTitle}
              </QuickLink>
            )}
            <QuickLink to={recentsRoute(mode)} icon={<ClockIcon size={14} />}>
              {copy.recentsTitle}
            </QuickLink>
            {favCount > 0 && (
              <QuickLink
                to={favoritesRoute(mode)}
                icon={<StarIcon size={13} filled />}
                count={favCount}
              >
                {copy.favoritesTitle}
              </QuickLink>
            )}
          </div>
        )}
      </section>

      {hasContent &&
        isComic &&
        (inProgressAll.length > 0 || unreadCards.length > 0) && (
          <div className="page-shell">
            <div className="home-overview">
              {inProgressAll.length > 0 && (
                <ContinueHero
                  cards={inProgressAll}
                  onContinue={onContinue}
                  onRemove={onRemoveContinue}
                  onClearAll={onClearContinue}
                />
              )}
              {unreadCards.length > 0 && (
                <UnreadHero
                  cards={unreadCards}
                  count={unreadCount}
                  onShuffle={onShuffleUnread}
                  onMarkRead={onMarkReadUnread}
                />
              )}
            </div>
          </div>
        )}

      {/* 照片侧的首屏专区：与漫画侧的「继续阅读 / 未读」位置对齐，
          内容却是照片自己的 —— 接着看、最近加入与随手看看。

          文档顺序就是阅读顺序，宽屏与窄屏一致：
          有浏览记录时是「接着看 → 随手看看 → 最近加入」（宽屏第一行
          两块、第二行最近加入通栏）；没有记录时换成「最近加入 →
          随手看看」，同样是先宽后窄。此前两者的顺序在宽窄屏之间
          会翻转，同一份内容换个宽度就读法不同。 */}
      {hasContent &&
        !isComic &&
        (resumeCards.length > 0 ||
          recentItems.length > 0 ||
          serendipity.albums.length > 0) && (
          <div className="page-shell">
            <div
              className={`home-overview${
                resumeCards.length > 0 ? " home-overview--with-resume" : ""
              }`}
            >
              {resumeCards.length > 0 ? (
                <>
                  <ResumeHero cards={resumeCards} />
                  <SerendipityHero
                    albums={serendipity.albums}
                    isLoading={serendipity.isLoading}
                    onReshuffle={serendipity.reshuffle}
                  />
                  {recentItems.length > 0 && (
                    <RecentlyAddedHero
                      items={recentItems}
                      total={recentTotal}
                      onShowAll={showAllRecent}
                    />
                  )}
                </>
              ) : (
                <>
                  {recentItems.length > 0 && (
                    <RecentlyAddedHero
                      items={recentItems}
                      total={recentTotal}
                      onShowAll={showAllRecent}
                    />
                  )}
                  <SerendipityHero
                    albums={serendipity.albums}
                    isLoading={serendipity.isLoading}
                    onReshuffle={serendipity.reshuffle}
                  />
                </>
              )}
            </div>
          </div>
        )}

      {/* === 索引条 ===
          漫画多一条「作品」索引：漫画常常不以年份命名，一部作品横跨
          好几年，按年份分会把同一部作品拆散。年份索引两边都留着 ——
          它筛的是下方网格，不只服务索引条本身。 */}
      {hasContent && isComic && seriesGroups.length > 0 && (
        <section className="page-shell pt-9">
          <div className="section-heading">
            <span className="section-index">{pad(sectionNo.series)}</span>
            <h2 className="section-title">作品</h2>
            <span className="section-meta">按作品浏览</span>
          </div>
          <SeriesTimeline groups={seriesGroups} />
        </section>
      )}
      {hasYearIndex && (
        <section className="page-shell pt-9">
          <div className="section-heading">
            <span className="section-index">{pad(sectionNo.year)}</span>
            <h2 className="section-title">时间线</h2>
            <span className="section-meta">按年份浏览</span>
          </div>
          <YearTimeline groups={yearGroups} gridRef={gridRef} />
        </section>
      )}

      {/* === 全部图像 ===
          初次加载时也渲染这一段（内容换成骨架）：否则首屏只有标题和
          四个动作按钮，数据到达后整页内容一次性长出来，视线要重新找
          一次位置。骨架占住网格的位置，数据回来时是"填满"而不是"重排"。 */}
      {(hasContent || isLoadingInitial) && (
        <section ref={gridRef} className="page-shell pt-10 pb-4 scroll-mt-6">
          <div className="section-heading">
            <span className="section-index">{pad(sectionNo.library)}</span>
            <h2 className="section-title">
              {yearFilterActive ? copy.yearSectionTitle : copy.sectionTitle}
            </h2>
            {yearFilterActive && (
              <button
                onClick={() => setYearFilter(null)}
                className="chip bg-accent-soft text-accent"
                title="清除年份筛选"
              >
                <span>{yearFilterLabel}</span>
                <CloseIcon size={11} />
              </button>
            )}
            {favCount > 0 && !yearFilterActive && (
              <button
                onClick={() => navigate(favoritesRoute(mode))}
                className="chip"
              >
                <StarIcon size={11} filled className="text-favorite" />
                <span>{favCount} 收藏</span>
              </button>
            )}
          </div>

          {/* 筛选 / 排序 / 视图切换只作用于下面这张网格，因此放在
              「全部图像」标题正下方贴着网格；不要提到未读 / 继续阅读 /
              时间线这些区块前面 —— 那里离网格有两千多像素，用户滚到
              网格时控件早已不在视野里。 */}
          {!isLoadingInitial && needsHistory && (
            <ViewedSortNotice query={historyQuery} />
          )}
          {!isLoadingInitial && (
            <ListFilterBar
              viewChips={[
                { key: "all", label: "全部", count: counts.all },
                {
                  key: "album",
                  label: copy.albumTypeLabel,
                  count: counts.album,
                },
                {
                  key: "collection",
                  label: copy.collectionTypeLabel,
                  count: counts.collection,
                },
                { key: "smart", label: "标签", count: counts.smart },
              ]}
              activeViewKey={view}
              onChangeView={(k) => setView(k as typeof view)}
              totalCount={filtered.length}
            />
          )}

          {isLoadingInitial ? (
            <AlbumGridSkeleton
              variant={viewMode}
              bare
              label="正在加载图像库…"
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              title={
                yearFilterActive
                  ? `「${yearFilterLabel}」没有匹配的图像`
                  : "没有匹配的图像"
              }
              description={
                query
                  ? `没有匹配"${query}"的结果`
                  : yearFilterActive && view !== "all"
                    ? `当前视图是「${viewLabel}」，${yearFilterLabel} 这一年下没有${viewLabel}。换成「全部」再看看。`
                    : yearFilterActive
                      ? "尝试切换到其他年份或清除筛选"
                      : "当前视图下没有内容"
              }
              icon={<ImageIcon size={20} />}
              /* 筛选条就在上面：空态不必再撑满半屏。 */
              dense
              action={
                <div className="flex items-center gap-2 flex-wrap justify-center">
                  {/* 每一条真正生效的筛选给一个手柄。
                      早先只有一个笼统的「清除筛选」：用户同时用了年份与
                      视图两个筛选时，空结果说不清是哪一个造成的，
                      按一下还会把排序与视图一起重置。 */}
                  {yearFilterActive && (
                    <button
                      onClick={() => setYearFilter(null)}
                      className="btn btn-outline"
                    >
                      清除年份筛选
                    </button>
                  )}
                  {view !== "all" && (
                    <button
                      onClick={() => setView("all")}
                      className="btn btn-outline"
                    >
                      看全部
                    </button>
                  )}
                  {query && (
                    <button
                      onClick={() => setQuery("")}
                      className="btn btn-outline"
                    >
                      清除搜索
                    </button>
                  )}
                  {minImageCount > 0 && (
                    <button
                      onClick={() => setMinImageCount(0)}
                      className="btn btn-outline"
                    >
                      清除最少张数
                    </button>
                  )}
                  {activeFilterCount === 0 && (
                    <button
                      onClick={() => useSearchStore.getState().reset()}
                      className="btn btn-outline"
                    >
                      清除筛选
                    </button>
                  )}
                </div>
              }
            />
          ) : (
            <div className="pb-10">
              <AlbumGrid items={filtered} variant={viewMode} />
            </div>
          )}
        </section>
      )}

      {/* 空状态 — 分两种：整个库都还没内容（首次使用），和这一侧没有内容
          （媒体根全被设成了另一种属性）。后者的引导要是「去设置媒体目录」，
          就把人指到了错误的地方。 */}
      {!hasContent && !isLoadingInitial && (
        <section className="page-shell">
          {libraryHasContent && !sideHasContent ? (
            <EmptyState
              title={`${copy.libraryTitle}这边还没有内容`}
              description={
                otherSideHasContent
                  ? "媒体目录都被设成了另一种内容属性。可以在设置里改属性，或者先去另一边看看。"
                  : "媒体目录的内容属性与这一侧对不上。可以在设置里改属性。"
              }
              icon={<LibraryIcon size={20} />}
              action={
                <div className="flex items-center gap-3">
                  <Link to="/settings" className="btn btn-outline">
                    去设置里改属性
                  </Link>
                  {otherSideHasContent && (
                    <Link
                      to={homeRoute(isComic ? "photo" : "comic")}
                      className="btn btn-primary"
                    >
                      去{isComic ? "照片" : "漫画"}库看看
                    </Link>
                  )}
                </div>
              }
            />
          ) : (
            <EmptyState
              title="欢迎使用本地画廊"
              description="首次使用请先设置媒体目录，再开始扫描。目录离线时可在设置中修复。"
              icon={<LibraryIcon size={20} />}
              action={
                <div className="flex items-center gap-3">
                  <Link to="/settings" className="btn btn-outline">
                    设置媒体目录
                  </Link>
                  <button
                    onClick={() => startScan.mutate()}
                    disabled={startScan.isPending}
                    className="btn btn-primary"
                  >
                    {startScan.isPending ? "启动中…" : "开始扫描"}
                  </button>
                </div>
              }
            />
          )}
        </section>
      )}

      <div className="h-8" />
    </div>
  );
}

// ===== helpers =====

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

// 同 albumGrouping.extractYear 但本组件独立调用，避免循环依赖
function extractYearOrNull(name: string): number | null {
  const m = name.match(/(\d{4})/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  if (y < 1900 || y > 2100) return null;
  return y;
}

// ===== 复用组件 =====

// 次级入口：轻量的幽灵按钮 + 计数。取代旧版"动作卡"——
// 旧版四张大卡占据大量面积却只承载极少信息，还会和内容区争夺注意力。
function QuickLink({
  to,
  icon,
  children,
  count,
}: {
  to: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <Link to={to} className="btn btn-sm btn-ghost border border-border-faint">
      {icon}
      <span>{children}</span>
      {count !== undefined && (
        <span className="tabular-nums text-fg-subtle">{count}</span>
      )}
    </Link>
  );
}
