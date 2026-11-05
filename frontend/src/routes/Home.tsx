import { useEffect, useMemo, useRef } from "react";
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
import { albumRoute, decodeFavPath, favoritesRoute, recentsRoute, unreadRoute } from "../utils/path";
import { continueReadingTarget } from "../utils/continueReading";
import { compareDatesDesc } from "../utils/date";
import type { GalleryContextEntry } from "../utils/galleryContext";
import {
  groupLibraryNodesBySeries,
  groupLibraryNodesByYear,
  type SeriesGroup,
  type YearGroup,
} from "../utils/albumGrouping";
import { useLibraryDashboard, useLibraryOverview, useLibraryRecentAlbums } from "../hooks/useLibrary";
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
  const sortBy = useSearchStore((s) => s.sortBy);
  const view = useSearchStore((s) => s.view);
  const setView = useSearchStore((s) => s.setView);
  const yearFilter = useSearchStore((s) => s.yearFilter);
  const setYearFilter = useSearchStore((s) => s.setYearFilter);
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
      libraryApi.randomAlbum(mode, scope),
    onSuccess: ({ album }) => navigate(albumRoute(mode, album.id)),
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
      pushToast({ kind: "error", message: "该相册为空,无法标记" });
      return;
    }
    markReadContinue.mutate(
      { albumId, total },
      {
        onSuccess: () =>
          pushToast({
            kind: "info",
            message: `已将「${card.title}」标记为已读`,
          }),
        onError: () => pushToast({ kind: "error", message: "标记失败,请重试" }),
      },
    );
  };
  const onClearContinue = () => {
    if (!inProgressAll.length) return;
    const ok = window.confirm(
      `将 ${inProgressAll.length} 本相册全部标记为已读？\n\n操作不会删除文件,只是把阅读进度推到末尾。`,
    );
    if (!ok) return;
    const items = inProgressAll.map((c) => ({
      albumId: decodeFavPath(c.to),
      total: c.progress?.total ?? 0,
    }));
    markReadAllContinue.mutate(items, {
      onSuccess: (r) => {
        if (r.failed === 0) {
          pushToast({ kind: "info", message: `已将 ${r.ok} 本标记为已读` });
        } else {
          pushToast({
            kind: "error",
            message: `已标记 ${r.ok} 本,失败 ${r.failed} 本`,
          });
        }
      },
      onError: () => pushToast({ kind: "error", message: "标记失败,请重试" }),
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
      pushToast({ kind: "error", message: "该相册为空,无法标记" });
      return;
    }
    markReadOne.mutate(
      { albumId, total },
      {
        onSuccess: () =>
          pushToast({
            kind: "info",
            message: `已将「${card.title}」标记为已读`,
          }),
        onError: () => pushToast({ kind: "error", message: "标记失败,请重试" }),
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
  const filtered = useMemo(() => {
    const list = cards.filter((it) => {
      if (view !== "all" && it.variant !== view) return false;
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
  }, [
    cards,
    query,
    sortBy,
    view,
    yearFilter,
    yearFilterActive,
    dashboardProgressByID,
    compareViewed,
    minImageCount,
  ]);

  const homeEntries = useMemo<GalleryContextEntry[]>(
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
  useGalleryContextSync({ type: "home" }, homeEntries);

  const counts = useMemo(() => {
    const c = { all: cards.length, album: 0, collection: 0, smart: 0 };
    for (const it of cards) c[it.variant]++;
    return c;
  }, [cards]);

  const isLoadingInitial =
    overview.isLoading ||
    dashboardQuery.isLoading ||
    (!manifest && !!(sse.isRunning || sse.scanId));
  const hasContent = !!manifest && cards.length > 0;
  // 漫画侧多一条「作品」索引，章节序号因此往后挪一位。
  const hasSeriesIndex = hasContent && isComic && seriesGroups.length > 0;

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

  // 「继续上次」直跳画廊：进首页最大的目的是「接着看」，
  // 中转 Album 详情会多一次点击，对随手翻翻的场景不友好。
  // 跳转目标的拼装集中在 utils/continueReading.ts，侧栏的迷你卡复用同一份逻辑。
  const onContinue = (card: CardData) => {
    navigate(continueReadingTarget(card));
  };

  // 年份筛选的"全部图像"section 顶部 chip
  const yearFilterLabel = yearFilter === "other" ? "其他" : String(yearFilter);

  return (
    <div className="home-page min-h-full">
      {/* ScanProgress 已提升到 AppShell，跨路由常驻显示 */}

      {/* === 页头：标题 + 库统计 + 次级入口 === */}
      <section className="page-shell page-heading">
        <div className="flex items-end justify-between gap-6 flex-wrap">
          <div className="min-w-0">
            <p className="page-eyebrow">{copy.libraryEyebrow}</p>
            <h1 className="page-title">{copy.libraryTitle}</h1>
            <p className="text-[13px] text-fg-muted mt-2">
              {manifest ? (
                <>
                  <span>{copy.libraryDescription}</span>
                  <span className="mx-2 text-fg-subtle">·</span>
                  {manifest.scannedAt && (
                    <span className="text-fg-subtle">
                      上次更新 {formatTime(manifest.scannedAt)}
                    </span>
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
            >
              <RefreshIcon size={13} />
              <span>{scanLabel}</span>
            </button>
          </div>
        </div>

        {/* 次级入口：没有在读内容时，「随机一本」升为主操作。
            有在读内容时它退到次级，避免和「继续阅读」抢主位。
            照片侧的对应物是「接着看」。 */}
        {!hasPrimaryEntry && (
          <div className="mt-5 flex items-center gap-2 flex-wrap">
            <button
              onClick={onShuffle}
              disabled={!hasContent}
              className="btn btn-primary"
            >
              <ShuffleIcon size={14} />
              {copy.randomLabel}
              <span className="text-[12.5px] opacity-70">R</span>
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

      {hasContent && isComic && (inProgressAll.length > 0 || unreadCards.length > 0) && (
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
          内容却是照片自己的 —— 接着看、最近加入与随手看看。 */}
      {hasContent &&
        !isComic &&
        (resumeCards.length > 0 ||
          recentItems.length > 0 ||
          serendipity.album !== null) && (
          <div className="page-shell">
            <div
              className={`home-overview${
                resumeCards.length > 0 ? " home-overview--with-resume" : ""
              }`}
            >
              {resumeCards.length > 0 && <ResumeHero cards={resumeCards} />}
              {recentItems.length > 0 && (
                <RecentlyAddedHero items={recentItems} total={recentTotal} />
              )}
              <SerendipityHero
                album={serendipity.album}
                isLoading={serendipity.isLoading}
                onReshuffle={serendipity.reshuffle}
              />
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
            <span className="section-index">01</span>
            <h2 className="section-title">作品</h2>
            <span className="section-meta">按作品浏览</span>
          </div>
          <SeriesTimeline groups={seriesGroups} />
        </section>
      )}
      {hasContent && yearGroups.length > 0 && (
        <section className="page-shell pt-9">
          <div className="section-heading">
            <span className="section-index">{isComic ? "02" : "01"}</span>
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
            <span className="section-index">{hasSeriesIndex ? "03" : "02"}</span>
            <h2 className="section-title">
              {yearFilterActive ? copy.yearSectionTitle : copy.sectionTitle}
            </h2>
            {!isLoadingInitial && (
              <span className="section-meta tabular-nums">
                {filtered.length}
              </span>
            )}
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
              <button onClick={() => navigate(favoritesRoute(mode))} className="chip">
                <StarIcon size={11} filled className="text-warning" />
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
                { key: "album", label: "文件夹", count: counts.album },
                { key: "collection", label: "集合", count: counts.collection },
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
                  : yearFilterActive
                    ? "尝试切换到其他年份或清除筛选"
                    : "当前视图下没有内容"
              }
              icon={<ImageIcon size={20} />}
              action={
                <div className="flex items-center gap-2">
                  {yearFilterActive && (
                    <button
                      onClick={() => setYearFilter(null)}
                      className="btn btn-outline"
                    >
                      清除年份筛选
                    </button>
                  )}
                  <button
                    onClick={() => useSearchStore.getState().reset()}
                    className="btn btn-outline"
                  >
                    清除筛选
                  </button>
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

      {/* 空状态 — 尚未扫描 */}
      {!hasContent && !isLoadingInitial && (
        <section className="page-shell">
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
