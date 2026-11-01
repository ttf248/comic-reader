import { useEffect, useMemo, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { useSearchStore } from "../store/searchStore";
import { useScanSSE } from "../hooks/useScanSSE";
import { useFavorites } from "../hooks/useFavorites";
import { useMarkAlbumRead, useMarkAlbumsRead } from "../hooks/useImageActivity";
import { useGalleryContextSync } from "../hooks/useGalleryContextSync";
import { scanApi } from "../api/scan";
import { useViewedSort } from "../hooks/useHistory";
import { libraryApi } from "../api/library";
import AlbumGrid, { type CardData } from "../components/album/AlbumGrid";
import { ListFilterBar } from "../components/common/ListFilterBar";
import EmptyState from "../components/common/EmptyState";
import ViewedSortNotice from "../components/common/ViewedSortNotice";
import YearTimeline from "../components/home/YearTimeline";
import { ContinueReadingHero, UnreadHero } from "../components/home/HomeHeroes";
import { useUIStore } from "../store/uiStore";
import { albumRoute, decodeFavPath } from "../utils/path";
import { compareDatesDesc } from "../utils/date";
import type { GalleryContextEntry } from "../utils/galleryContext";
import {
  groupLibraryNodesByYear,
  type YearGroup,
} from "../utils/albumGrouping";
import { useLibraryDashboard, useLibraryOverview } from "../hooks/useLibrary";
import {
  libraryOverviewCards,
  nodeSummaryToCard,
  cardMatchesQuery,
} from "../utils/libraryCard";
import {
  PlayFilledIcon,
  StarIcon,
  ShuffleIcon,
  RefreshIcon,
  LibraryIcon,
  ClockIcon,
  CloseIcon,
  ImageIcon,
  CalendarIcon,
} from "../components/common/Icon";

export default function Home() {
  const navigate = useNavigate();
  const overview = useLibraryOverview();
  const manifest = overview.manifest;
  const dashboardQuery = useLibraryDashboard();
  const dashboard = dashboardQuery.data?.dashboard;
  const sse = useScanSSE();
  const pushToast = useUIStore((s) => s.pushToast);

  // "全部图像" section 的 ref：年份筛选触发后自动滚到这里
  const gridRef = useRef<HTMLDivElement>(null);

  const query = useSearchStore((s) => s.query);
  const sortBy = useSearchStore((s) => s.sortBy);
  const view = useSearchStore((s) => s.view);
  const setView = useSearchStore((s) => s.setView);
  const yearFilter = useSearchStore((s) => s.yearFilter);
  const setYearFilter = useSearchStore((s) => s.setYearFilter);
  const viewMode = useUIStore((s) => s.viewMode);

  const { favorites } = useFavorites();
  // 首页只展示服务端预先限制为六本的未读预览；完整未读库交给 /unread 分页加载。
  const unreadCards = useMemo<CardData[]>(
    () =>
      (dashboard?.unread ?? []).map((album) => ({
        ...nodeSummaryToCard(album, "u:"),
        progress: { index: 0, total: album.imageCount ?? 0 },
      })),
    [dashboard],
  );
  const unreadCount = dashboard?.unreadCount ?? 0;
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
    mutationFn: (scope: "all" | "unread") => libraryApi.randomAlbum(scope),
    onSuccess: ({ album }) => navigate(albumRoute(album.id)),
    onError: (_error, scope) =>
      pushToast({
        kind: "info",
        message: scope === "unread" ? "没有未读相册可跳" : "尚未加载图像库",
      }),
  });
  const onShuffle = () => randomAlbum.mutate("all");
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
    () => libraryOverviewCards(overview.nodes, overview.tags),
    [overview.nodes, overview.tags],
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
        .map((c) => ({ key: decodeFavPath(c.to), to: c.to, name: c.title })),
    [filtered],
  );
  useGalleryContextSync({ type: "home" }, homeEntries);

  const counts = useMemo(() => {
    const c = { all: cards.length, album: 0, collection: 0, smart: 0 };
    for (const it of cards) c[it.variant]++;
    return c;
  }, [cards]);

  const favCount = favorites.length;
  const isLoadingInitial =
    overview.isLoading ||
    dashboardQuery.isLoading ||
    (!manifest && !!(sse.isRunning || sse.scanId));
  const hasContent = !!manifest && cards.length > 0;

  // 主 CTA：有进度 → 继续上次；否则 → 随机翻翻
  const primaryAlbum = inProgressAll[0];
  const scanLabel = sse.isRunning
    ? "扫描中…"
    : startScan.isPending
      ? "启动中…"
      : "重新扫描";

  // 「继续上次」直跳画廊：进首页最大的目的是「接着看」，
  // 中转 Album 详情会多一次点击，对随手翻翻的场景不友好。
  //
  // type 推断：
  //  - imageCount > 0（混合 / 纯图）→ type=image（Gallery 缺省值，显式传更稳）
  //  - imageCount === 0 && videoCount > 0（纯视频相册）→ type=video
  // 不传 type 时 Gallery 把当前相册当图库,纯视频相册会显示「这个文件夹没有图片」。
  const onContinue = (card: CardData) => {
    if (card.variant !== "album") {
      navigate(card.to);
      return;
    }
    const idx = card.progress?.index ?? 0;
    const imgs = card.imageCount ?? 0;
    const vids = card.videoCount ?? 0;
    const galleryType: "image" | "video" =
      imgs > 0 ? "image" : vids > 0 ? "video" : "image";
    const qs = new URLSearchParams({
      path: decodeFavPath(card.to),
      index: String(idx),
      name: card.title,
      type: galleryType,
    });
    navigate(`/gallery?${qs.toString()}`);
  };

  // 年份筛选的"全部图像"section 顶部 chip
  const yearFilterLabel = yearFilter === "other" ? "其他" : String(yearFilter);

  return (
    <div className="min-h-full">
      {/* ScanProgress 已提升到 AppShell，跨路由常驻显示 */}

      {/* === Hero: 标题 + 统计 + 4 动作卡 + 重新扫描 === */}
      <section className="px-6 lg:px-10 pt-12 pb-8 max-w-[1400px] mx-auto w-full">
        <div className="flex items-end justify-between gap-8 flex-wrap mb-6">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.18em] text-fg-subtle font-medium">
              库 · Library
            </div>
            <h1 className="font-display text-[44px] leading-[1.04] font-semibold tracking-[-0.02em] mt-2.5">
              图像库
            </h1>
            <p className="text-sm text-fg-muted mt-3.5">
              {manifest ? (
                <>
                  {/* 标题描述整个库，而不是当前根目录下的条目数：
                      下面的标签页已经区分「文件夹 / 集合」，这里再叫
                      「N 个文件夹」既不准确也容易和标签页打架。 */}
                  <span className="tabular-nums text-fg">
                    {manifest.statistics.albumCount}
                  </span>{" "}
                  本相册
                  {manifest.statistics.collectionCount > 0 && (
                    <>
                      {" · "}
                      <span className="tabular-nums text-fg">
                        {manifest.statistics.collectionCount}
                      </span>{" "}
                      个集合
                    </>
                  )}
                  {manifest.scannedAt && (
                    <span className="text-fg-subtle ml-1.5">
                      · 上次更新 {formatTime(manifest.scannedAt)}
                    </span>
                  )}
                </>
              ) : (
                "尚未加载图像库"
              )}
            </p>
          </div>
          <button
            onClick={() => startScan.mutate()}
            disabled={startScan.isPending || sse.isRunning}
            className="inline-flex items-center gap-1.5 h-11 px-3.5 rounded-lg text-[13px] text-fg-muted hover:text-fg hover:bg-bg-subtle border border-border-faint transition-colors disabled:opacity-50"
            title="扫描 (Ctrl+S)"
          >
            <RefreshIcon size={13} />
            <span>{scanLabel}</span>
          </button>
        </div>

        {/* === 4 动作卡（核心入口） === */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {/* 1. 主 CTA：继续上次（如果有进度）or 随机翻翻 */}
          {primaryAlbum ? (
            <ActionCard
              icon={<PlayFilledIcon size={14} />}
              title="继续上次"
              subtitle={primaryAlbum.title}
              meta={
                primaryAlbum.progress
                  ? `${primaryAlbum.progress.index + 1}/${primaryAlbum.progress.total}`
                  : ""
              }
              variant="primary"
              onClick={() => onContinue(primaryAlbum)}
            />
          ) : (
            <ActionCard
              icon={<ShuffleIcon size={14} />}
              title="随机翻翻"
              subtitle="随便看一本"
              meta="(R)"
              variant="primary"
              disabled={!hasContent}
              onClick={onShuffle}
            />
          )}

          {/* 2. 随机翻翻（如果主 CTA 是继续上次，则并排展示） */}
          {primaryAlbum && (
            <ActionCard
              icon={<ShuffleIcon size={14} />}
              title="随机翻翻"
              subtitle="随便看一本"
              meta="(R)"
              variant="secondary"
              disabled={!hasContent}
              onClick={onShuffle}
            />
          )}

          {/* 3. 最近打开 */}
          <ActionCard
            icon={<ClockIcon size={14} />}
            title="最近打开"
            subtitle="按时间倒序"
            variant="secondary"
            onClick={() => navigate("/recents")}
          />

          {/* 4. 收藏（仅当有收藏时） */}
          {favCount > 0 && (
            <ActionCard
              icon={<StarIcon size={13} filled className="text-warning" />}
              title="收藏"
              subtitle={`${favCount} 项`}
              variant="secondary"
              onClick={() => navigate("/favorites")}
            />
          )}
        </div>
      </section>

      {/* === 视图筛选 === */}
      {hasContent && needsHistory && <ViewedSortNotice query={historyQuery} />}
      {hasContent && (
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

      {/* === 未读 hero(有未读时置顶 6 张,直接引导用户进下一本)== */}
      {hasContent && unreadCards.length > 0 && (
        <UnreadHero
          cards={unreadCards}
          count={unreadCount}
          onShuffle={onShuffleUnread}
          onMarkRead={onMarkReadUnread}
        />
      )}

      {/* === 继续阅读 hero(有进行中的相册时,展示前 6 张)== */}
      {hasContent && inProgressAll.length > 0 && (
        <ContinueReadingHero
          cards={inProgressAll}
          onContinue={onContinue}
          onRemove={onRemoveContinue}
          onClearAll={onClearContinue}
        />
      )}

      {/* === 时间线（仅当有内容时显示） === */}
      {hasContent && yearGroups.length > 0 && (
        <div className="py-6">
          <SectionHeader
            title="时间线"
            subtitle="按年份浏览 — 点击海报打开该年份,点右上漏斗可筛选下方网格"
            icon={<CalendarIcon size={13} />}
          />
          <YearTimeline groups={yearGroups} gridRef={gridRef} />
        </div>
      )}

      {/* === 全部图像 === */}
      {hasContent && (
        <section
          ref={gridRef}
          className="max-w-[1400px] mx-auto w-full pt-8 pb-4 scroll-mt-6"
        >
          <div className="px-6 lg:px-10 flex items-center gap-2 flex-wrap">
            <LibraryIcon size={12} className="text-fg-muted" />
            <h2 className="text-[11px] uppercase tracking-[0.18em] text-fg-muted font-medium">
              {yearFilterActive ? "该年份的图像" : "全部图像"}
            </h2>
            <span className="text-[11px] text-fg-subtle tabular-nums">
              {filtered.length}
            </span>
            {yearFilterActive && (
              <button
                onClick={() => setYearFilter(null)}
                className="inline-flex items-center gap-1.5 h-6 px-2 rounded-md bg-accent-soft text-accent text-[11px] font-medium hover:bg-accent-soft/70 transition-colors"
                title="清除年份筛选"
              >
                <span>{yearFilterLabel}</span>
                <CloseIcon size={10} />
              </button>
            )}
            {favCount > 0 && !yearFilterActive && (
              <>
                <span className="text-fg-subtle/40 mx-1">·</span>
                <button
                  onClick={() => navigate("/favorites")}
                  className="inline-flex items-center gap-1 text-[11px] text-warning/90 hover:text-warning transition-colors"
                >
                  <StarIcon size={10} filled />
                  <span>{favCount} 收藏</span>
                </button>
              </>
            )}
          </div>

          {isLoadingInitial ? (
            <EmptyState
              title="正在加载图像库"
              description="首次启动可能需要几秒钟。"
              icon={
                <div className="w-10 h-10 border-2 border-fg-subtle border-t-accent rounded-full animate-spin" />
              }
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
                      className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md border border-border hover:bg-bg-subtle text-sm"
                    >
                      清除年份筛选
                    </button>
                  )}
                  <button
                    onClick={() => useSearchStore.getState().reset()}
                    className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md border border-border hover:bg-bg-subtle text-sm"
                  >
                    清除筛选
                  </button>
                </div>
              }
            />
          ) : (
            <div className="px-6 lg:px-10 pb-10">
              <AlbumGrid items={filtered} variant={viewMode} />
            </div>
          )}
        </section>
      )}

      {/* 空状态 — 尚未扫描 */}
      {!hasContent && !isLoadingInitial && (
        <section className="px-6 lg:px-10 max-w-[1400px] mx-auto w-full">
          <EmptyState
            title="欢迎使用本地画廊"
            description="首次使用请先设置媒体目录，再开始扫描。目录离线时可在设置中修复。"
            icon={<LibraryIcon size={20} />}
            action={
              <div className="flex items-center gap-3">
                <Link
                  to="/settings"
                  className="inline-flex items-center h-9 px-4 rounded-md border border-border text-sm hover:bg-bg-hover"
                >
                  设置媒体目录
                </Link>
                <button
                  onClick={() => startScan.mutate()}
                  disabled={startScan.isPending}
                  className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-accent text-accent-contrast hover:bg-accent-hover text-sm disabled:opacity-50"
                >
                  {startScan.isPending ? "启动中…" : "开始扫描"}
                </button>
              </div>
            }
          />
        </section>
      )}

      <div className="h-12" />
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

function ActionCard({
  icon,
  title,
  subtitle,
  meta,
  variant,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  meta?: string;
  variant: "primary" | "secondary";
  disabled?: boolean;
  onClick: () => void;
}) {
  const base =
    "group relative flex flex-col gap-2 rounded-xl border p-4 sm:p-5 text-left transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
  const primaryCls =
    "bg-accent text-accent-contrast border-transparent hover:bg-accent-hover shadow-sm hover:shadow-md";
  const secondaryCls =
    "bg-bg-elevated text-fg border-border hover:border-border-strong hover:-translate-y-0.5 hover:shadow-md";
  const disabledCls =
    "opacity-40 cursor-not-allowed hover:!translate-y-0 hover:!shadow-sm";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${variant === "primary" ? primaryCls : secondaryCls} ${
        disabled ? disabledCls : ""
      }`}
    >
      <div
        className={`inline-flex items-center justify-center w-7 h-7 rounded-md ${
          variant === "primary"
            ? "bg-accent-contrast/15 text-accent-contrast"
            : "bg-bg-subtle text-fg-muted group-hover:text-fg"
        }`}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div
          className={`text-[14px] font-medium leading-tight ${
            variant === "primary" ? "text-accent-contrast" : "text-fg"
          }`}
        >
          {title}
        </div>
        {subtitle && (
          <div
            className={`text-[11.5px] mt-0.5 truncate ${
              variant === "primary"
                ? "text-accent-contrast/70"
                : "text-fg-muted"
            }`}
            title={subtitle}
          >
            {subtitle}
          </div>
        )}
      </div>
      {meta && (
        <div
          className={`absolute top-3 right-3 text-[10px] tabular-nums ${
            variant === "primary" ? "text-accent-contrast/60" : "text-fg-subtle"
          }`}
        >
          {meta}
        </div>
      )}
    </button>
  );
}

function SectionHeader({
  title,
  subtitle,
  icon,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="px-6 lg:px-10 max-w-[1400px] mx-auto w-full flex items-center gap-3 mb-4">
      {icon}
      <h2 className="text-[11px] uppercase tracking-[0.18em] text-fg-muted font-medium">
        {title}
      </h2>
      {subtitle && (
        <span className="text-[11.5px] text-fg-subtle">{subtitle}</span>
      )}
    </div>
  );
}
