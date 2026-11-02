import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchStore } from "../store/searchStore";
import { useFavorites } from "../hooks/useFavorites";
import { useGalleryContextSync } from "../hooks/useGalleryContextSync";
import { historyApi } from "../api/prefs";
import { useViewedSort } from "../hooks/useHistory";
import { ListFilterBar } from "../components/common/ListFilterBar";
import ViewedSortNotice from "../components/common/ViewedSortNotice";
import { syncHistoryCache } from "../utils/historyCache";
import { thumbUrl } from "../api/thumbs";
import { getVideoInfoBatch } from "../api/videos";
import { useUIStore } from "../store/uiStore";
import type { CardData } from "../components/album/AlbumGrid";
import AlbumGrid from "../components/album/AlbumGrid";
import YearTimeline from "../components/home/YearTimeline";
import { groupAlbumsAndCollectionsByYear } from "../utils/albumGrouping";
import EmptyState from "../components/common/EmptyState";
import { decodeFavPath } from "../utils/path";
import { useSafeBack } from "../utils/navigation";
import { compareDatesDesc, formatRelative } from "../utils/date";
import { formatSize } from "../utils/format";
import {
  ChevronLeftIcon,
  ReaderIcon,
  StarIcon,
  FolderIcon,
  PlayFilledIcon,
  CheckIcon,
  MoreHorizontalIcon,
  ClockIcon,
  ImageIcon,
  CopyIcon,
  ArrowUpRightIcon,
  ArrowRightLineIcon,
  InfoIcon,
  CalendarIcon,
} from "../components/common/Icon";
import { useImageActivity } from "../hooks/useImageActivity";
import { useAlbumActions } from "../hooks/useAlbumActions";
import PropertiesDialog from "../components/common/PropertiesDialog";
import ContextMenu, { type AnyMenuItem } from "../components/album/ContextMenu";
import VideoCoverImage from "../components/common/VideoCoverImage";
import MediaThumbnailGrid from "../components/album/MediaThumbnailGrid";
import MixedMediaThumbnailGrid from "../components/album/MixedMediaThumbnailGrid";
import VideoThumbnailGrid from "../components/album/VideoThumbnailGrid";
import { fileManagerErrorMessage } from "../utils/fileManager";
import type { GalleryContextEntry } from "../utils/galleryContext";
import {
  useAlbumMedia,
  useLibraryChildren,
  useLibraryNodes,
} from "../hooks/useLibrary";
import {
  LibraryRevisionChangedError,
  type LibraryMediaItem,
  type LibraryNodeSummary,
} from "../api/library";

interface AlbumDetail {
  type: "album";
  path: string;
  name: string;
  imageFiles: string[];
  videoFiles?: string[];
  mediaItems?: LibraryMediaItem[];
  coverImage: string;
  coverKind?: "image" | "video";
  imageCount: number;
  videoCount?: number;
  tags: string[];
  folderSize: number;
  modTime: string;
  /** 散图（"本目录媒体"）视图：标题用归属目录，name 之外另标类型。 */
  virtual?: boolean;
  /** 散图归属目录相对媒体根的路径。 */
  location?: string;
}

interface CollectionDetail {
  type: "collection";
  path: string;
  name: string;
  displayName?: string;
  sourceRoot?: string;
  sourceName?: string;
  modTime?: string;
  coverImage: string;
  coverImages?: string[];
  imageCount: number;
  videoCount: number;
  folderSize: number;
  albums: AlbumDetail[];
  /** 嵌套子集合（子目录里没有顶层媒体时继续下钻的中间层）。 */
  collections?: CollectionDetail[];
  /** 直属于本层的子相册数(不含嵌套集合) */
  albumCount: number;
}

type Detail = AlbumDetail | CollectionDetail;

function albumDetailFromSummary(
  summary: LibraryNodeSummary,
  media: LibraryMediaItem[] = [],
): AlbumDetail {
  // 散图（"本目录媒体"）的 name 没有区分度，用归属目录当标题。
  const virtual = summary.virtual === true;
  const location = summary.location?.trim();
  return {
    type: "album",
    path: summary.id,
    name:
      virtual && location ? location : summary.displayName || summary.name,
    imageFiles: media
      .filter((item) => item.kind === "image")
      .map((item) => item.id),
    videoFiles: media
      .filter((item) => item.kind === "video")
      .map((item) => item.id),
    mediaItems: media,
    coverImage: summary.coverImage ?? "",
    coverKind: summary.coverKind,
    imageCount: summary.imageCount ?? 0,
    videoCount: summary.videoCount ?? 0,
    tags: summary.tags ?? [],
    folderSize: summary.folderSize ?? 0,
    modTime: summary.modTime ?? "",
    virtual,
    location,
  };
}

function collectionDetailFromSummary(
  summary: LibraryNodeSummary,
): CollectionDetail {
  return {
    type: "collection",
    path: summary.id,
    name: summary.name,
    displayName: summary.displayName,
    sourceRoot: summary.sourceRoot,
    sourceName: summary.sourceName,
    modTime: summary.modTime,
    coverImage: summary.coverImage ?? "",
    coverImages: summary.coverImages,
    imageCount: summary.imageCount ?? 0,
    videoCount: summary.videoCount ?? 0,
    folderSize: summary.folderSize ?? 0,
    albums: [],
    collections: [],
    albumCount: summary.albumCount ?? 0,
  };
}

// 相册视图：
//   - 相册 → 图片网格，点击进入画廊
//   - 集合 → 嵌套相册列表
//   - 缺数据时给出明确引导
export default function Album() {
  const params = useParams();
  const navigate = useNavigate();
  // 返回：应用内还有历史就回退，否则回主页（直接打开相册链接时
  // navigate(-1) 会一路退出应用，停在空白页）。
  const goBack = useSafeBack("/");
  const queryClient = useQueryClient();
  const resourceID = decodeFavPath("/albums/" + (params["*"] ?? ""));

  const query = useSearchStore((s) => s.query);
  const sortBy = useSearchStore((s) => s.sortBy);
  const viewMode = useUIStore((s) => s.viewMode);
  const { toggle: toggleFav, favorites } = useFavorites();
  const pushToast = useUIStore((s) => s.pushToast);

  const nodeIds = useMemo(() => (resourceID ? [resourceID] : []), [resourceID]);
  const nodeQuery = useLibraryNodes(nodeIds);
  const refetchNode = nodeQuery.refetch;
  const node = nodeQuery.data?.items[0];
  const childrenQuery = useLibraryChildren(
    node?.kind === "collection" ? node.id : "",
    nodeQuery.data?.revision,
  );
  const mediaQuery = useAlbumMedia(
    node?.kind === "album" ? node.id : "",
    nodeQuery.data?.revision,
  );
  const fetchNextMediaPage = mediaQuery.fetchNextPage;
  const loadMoreMedia = useCallback(() => {
    void fetchNextMediaPage({ cancelRefetch: false });
  }, [fetchNextMediaPage]);
  const revisionChanged =
    childrenQuery.error instanceof LibraryRevisionChangedError ||
    mediaQuery.error instanceof LibraryRevisionChangedError;

  useEffect(() => {
    if (revisionChanged) void refetchNode();
  }, [refetchNode, revisionChanged]);

  const mediaItems = useMemo<LibraryMediaItem[]>(
    () => mediaQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [mediaQuery.data],
  );

  const detail = useMemo<Detail | null>(() => {
    if (!node) return null;
    if (node.kind === "album") {
      if (!mediaQuery.data) return null;
      return albumDetailFromSummary(node, mediaItems);
    }
    if (!childrenQuery.data) return null;
    const albums: AlbumDetail[] = [];
    const collections: CollectionDetail[] = [];
    for (const child of childrenQuery.data.items) {
      if (child.kind === "album") albums.push(albumDetailFromSummary(child));
      else collections.push(collectionDetailFromSummary(child));
    }
    return {
      ...collectionDetailFromSummary(node),
      albums,
      collections,
    };
  }, [childrenQuery.data, mediaItems, mediaQuery.data, node]);

  const isDetailLoading =
    revisionChanged ||
    nodeQuery.isLoading ||
    (node?.kind === "album" && mediaQuery.isLoading) ||
    (node?.kind === "collection" && childrenQuery.isLoading);

  const historyAlbumId = detail?.type === "album" ? detail.path : "";
  const historyAlbumName = detail?.type === "album" ? detail.name : "";
  const historyImageCount = detail?.type === "album" ? detail.imageCount : 0;
  useEffect(() => {
    if (!historyAlbumId) return;
    historyApi
      .add({
        albumId: historyAlbumId,
        name: historyAlbumName,
        imageCount: historyImageCount,
      })
      .then(({ history }) => syncHistoryCache(queryClient, history))
      .catch(() => {});
    // 分页会重建 detail；访问记录只依赖相册标识和摘要，不能跟随媒体页重复写入。
  }, [historyAlbumId, historyAlbumName, historyImageCount, queryClient]);

  if (isDetailLoading) {
    return (
      <EmptyState
        title="正在加载文件夹"
        description="正在读取节点与媒体摘要…"
      />
    );
  }

  if (!detail) {
    return (
      <EmptyState
        title="找不到此文件夹"
        description="资源可能已移动，或者媒体库尚未完成扫描。"
        action={
          <button
            onClick={() => navigate("/")}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md border border-border hover:bg-bg-subtle text-sm"
          >
            返回主页
          </button>
        }
      />
    );
  }

  if (detail.type === "collection") {
    const isFav = favorites.includes(detail.path);
    return (
      <CollectionView
        detail={detail}
        query={query}
        sortBy={sortBy}
        viewMode={viewMode}
        onBack={goBack}
        isFavorite={isFav}
        onToggleFav={async () => {
          try {
            await toggleFav(detail.path);
            pushToast({
              kind: "success",
              message: isFav ? "已取消收藏" : "已加入收藏",
            });
          } catch {
            pushToast({ kind: "error", message: "操作失败" });
          }
        }}
      />
    );
  }

  const canLoadMore =
    (mediaQuery.hasNextPage ?? false) && !mediaQuery.isFetchNextPageError;
  return (
    <div className="flex flex-col h-full min-h-0">
      {mediaQuery.isFetchNextPageError && (
        <div
          role="alert"
          className="shrink-0 flex items-center justify-between gap-3 px-6 lg:px-10 py-3 bg-warning/10 text-fg text-sm"
        >
          <span>后续媒体加载失败，已加载内容仍可浏览。</span>
          <button
            type="button"
            onClick={loadMoreMedia}
            disabled={mediaQuery.isFetchingNextPage}
            className="shrink-0 text-accent hover:underline disabled:opacity-50"
          >
            {mediaQuery.isFetchingNextPage ? "正在重试…" : "重试加载"}
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0">
        {detail.imageCount === 0 && (detail.videoCount ?? 0) > 0 ? (
          <VideoAlbumView
            detail={detail}
            onBack={goBack}
            hasNextPage={canLoadMore}
            isLoadingMore={mediaQuery.isFetchingNextPage}
            onLoadMore={loadMoreMedia}
          />
        ) : (
          <AlbumView
            detail={detail}
            onBack={goBack}
            hasNextPage={canLoadMore}
            isLoadingMore={mediaQuery.isFetchingNextPage}
            onLoadMore={loadMoreMedia}
          />
        )}
      </div>
    </div>
  );
}

// Album 详情页:大封面 hero + 进度条 + 动态 CTA + 缩略图网格
function AlbumView({
  detail,
  onBack,
  hasNextPage,
  isLoadingMore,
  onLoadMore,
}: {
  detail: AlbumDetail;
  onBack: () => void;
  hasNextPage: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
}) {
  const navigate = useNavigate();
  const [gridSize, setGridSize] = useState<"sm" | "md" | "lg">("md");
  const pushToast = useUIStore((s) => s.pushToast);
  const { data: progress } = useImageActivity(detail.path);
  const { add: addFav, toggle: toggleFav, favorites } = useFavorites();
  const isFav = favorites.includes(detail.path);
  const startIndex =
    progress && progress.pageIndex > 0 && progress.pageIndex < detail.imageCount
      ? progress.pageIndex
      : 0;

  const [moreOpen, setMoreOpen] = useState(false);
  const [propertiesFileId, setPropertiesFileId] = useState<string | null>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const wasMoreOpenRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    index: number;
  } | null>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const onClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node))
        setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    // 下一 tick 注册，避免本次点击事件冒泡到 window 后立即关闭
    const id = window.setTimeout(() => {
      window.addEventListener("mousedown", onClick);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  useEffect(() => {
    if (!moreOpen) {
      if (wasMoreOpenRef.current) moreButtonRef.current?.focus();
      wasMoreOpenRef.current = false;
      return;
    }
    wasMoreOpenRef.current = true;
    const firstItem = moreMenuRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    );
    firstItem?.focus();
  }, [moreOpen]);

  const openGallery = (idx: number) => {
    const qs = new URLSearchParams({
      path: detail.path,
      index: String(idx),
      name: detail.name,
    });
    navigate(`/gallery?${qs.toString()}`);
  };

  const openMedia = (item: LibraryMediaItem) => {
    const qs = new URLSearchParams({
      path: detail.path,
      index: String(item.kindIndex),
      name: detail.name,
    });
    if (item.kind === "video") qs.set("type", "video");
    navigate(`/gallery?${qs.toString()}`);
  };

  // 用 AlbumActions 钩子实现菜单里的复制链接与资源管理器操作。
  const actions = useAlbumActions({
    id: detail.path,
    variant: "album",
    title: detail.name,
    subtitle: detail.tags.join(" · "),
    count: detail.imageCount,
    coverPath: detail.coverImage,
    to: `/albums/${encodeURIComponent(detail.path)}`,
    isFavorite: isFav,
  });

  const openInExplorer = () => {
    void actions
      .openInExplorer()
      .then(() =>
        pushToast({ kind: "success", message: "已请求打开目录", ttl: 1200 }),
      )
      .catch((error: unknown) =>
        pushToast({ kind: "error", message: fileManagerErrorMessage(error) }),
      );
  };

  const copyLink = () => {
    void actions
      .copyLink()
      .then(() =>
        pushToast({ kind: "success", message: "已复制链接", ttl: 1200 }),
      )
      .catch(() =>
        pushToast({ kind: "error", message: "复制失败，请检查浏览器权限" }),
      );
  };

  const toggleFavorite = () => {
    if (isFav) {
      toggleFav(detail.path)
        .then(() => pushToast({ kind: "success", message: "已取消收藏" }))
        .catch(() => pushToast({ kind: "error", message: "操作失败" }));
    } else {
      addFav(detail.path)
        .then(() => pushToast({ kind: "success", message: "已加入收藏" }))
        .catch(() => pushToast({ kind: "error", message: "操作失败" }));
    }
  };

  // 防御：API 可能返回 null
  const imageFiles = detail.imageFiles ?? [];
  const mediaItems = useMemo(
    () => detail.mediaItems ?? [],
    [detail.mediaItems],
  );
  const videoCount = detail.videoCount ?? 0;
  const videoIds = useMemo(
    () =>
      mediaItems.filter((item) => item.kind === "video").map((item) => item.id),
    [mediaItems],
  );
  const videoInfos = useQuery({
    queryKey: ["video-infos", detail.path, videoIds],
    queryFn: () => getVideoInfoBatch(videoIds),
    enabled: videoIds.length > 0,
    staleTime: 5 * 60_000,
  });

  if (detail.imageCount === 0) {
    return (
      <div className="p-6">
        <EmptyState
          title="该文件夹暂无图片"
          description="可能扫描时尚未加载到图片列表，请重新扫描。"
        />
      </div>
    );
  }

  const gridCls =
    gridSize === "sm"
      ? "grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10"
      : gridSize === "lg"
        ? "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
        : "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6";

  const currentPageCount = detail.imageCount;
  const progressPct =
    progress && currentPageCount > 0
      ? currentPageCount === 1
        ? 100
        : Math.min(
            100,
            Math.round((progress.pageIndex / (currentPageCount - 1)) * 100),
          )
      : null;
  const isFinished =
    !!progress &&
    currentPageCount > 0 &&
    progress.pageIndex >= currentPageCount - 1;

  return (
    <div className="flex flex-col h-full">
      {/* Hero: 大封面 + 渐变叠加 + 标题 + CTA */}
      <section className="relative bg-bg-elevated border-b border-border-faint">
        <div className="absolute inset-0 overflow-hidden">
          <img
            src={thumbUrl(detail.coverImage)}
            alt=""
            className="w-full h-full object-cover scale-110 blur-2xl opacity-25"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-bg-elevated/40 to-bg-elevated" />
        </div>

        <div className="relative px-6 lg:px-10 pt-6 pb-8 max-w-[1400px] mx-auto w-full">
          <div className="flex items-center gap-3 mb-5">
            <button
              onClick={onBack}
              className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg transition-colors"
            >
              <ChevronLeftIcon size={12} />
              <span>返回</span>
            </button>
            <span className="text-fg-subtle/50 text-xs">/</span>
            <span className="text-xs text-fg-muted truncate">
              {detail.name}
            </span>
          </div>

          <div className="flex items-end gap-8 flex-wrap">
            {/* 大封面缩略图 */}
            <div className="relative w-32 h-44 sm:w-40 sm:h-56 rounded-lg overflow-hidden border border-border shadow-md shrink-0 bg-bg-subtle">
              <img
                src={thumbUrl(detail.coverImage)}
                alt={detail.name}
                className="w-full h-full object-cover"
              />
              {progressPct !== null && progressPct > 0 && (
                <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/30">
                  <div
                    className="h-full bg-accent"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              )}
            </div>

            {/* 标题 + 元信息 + CTA */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="font-display text-2xl sm:text-[28px] font-semibold tracking-[-0.01em] leading-tight">
                  {detail.name}
                </h1>
                {/* 散图视图：标题已是归属目录，这里标明它是「目录内散图」 */}
                {detail.virtual && (
                  <span className="inline-flex items-center gap-1 h-6 px-2 rounded-md bg-bg-subtle text-fg-muted text-[11px] shrink-0">
                    <FolderIcon size={11} />
                    本目录媒体
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-sm text-fg-muted mt-2 flex-wrap">
                {detail.tags.length > 0 && (
                  <>
                    <span className="text-fg">{detail.tags.join(" · ")}</span>
                    <span className="text-fg-subtle/50">·</span>
                  </>
                )}
                <span className="tabular-nums">
                  {detail.imageCount > 0 ? `${detail.imageCount} 张` : ""}
                  {detail.imageCount > 0 && videoCount > 0 ? " · " : ""}
                  {videoCount > 0 ? `${videoCount} 个视频` : ""}
                  {detail.imageCount === 0 && videoCount === 0 ? "0 张" : ""}
                </span>
                {detail.folderSize > 0 && (
                  <>
                    <span className="text-fg-subtle/50">·</span>
                    <span className="tabular-nums">
                      {formatSize(detail.folderSize)}
                    </span>
                  </>
                )}
                {detail.modTime && (
                  <>
                    <span className="text-fg-subtle/50">·</span>
                    <span className="text-fg-subtle inline-flex items-center gap-1">
                      <ClockIcon size={11} />
                      {formatRelative(detail.modTime)}
                    </span>
                  </>
                )}
                {isFinished && (
                  <>
                    <span className="text-fg-subtle/50">·</span>
                    <span className="inline-flex items-center gap-1 text-success text-[12px]">
                      <CheckIcon size={11} />
                      已读完
                    </span>
                  </>
                )}
              </div>

              {/* 阅读进度条: 显眼 */}
              {progressPct !== null && progressPct > 0 && (
                <div className="mt-4 max-w-md">
                  <div className="flex items-center justify-between text-[11px] text-fg-muted mb-1.5 tabular-nums">
                    <span>阅读进度</span>
                    <span>
                      {Math.min(progress!.pageIndex + 1, currentPageCount)} /{" "}
                      {currentPageCount} · {progressPct}%
                    </span>
                  </div>
                  <div className="h-1.5 bg-bg-strong rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent transition-all"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                </div>
              )}

              {/* CTA 行 */}
              <div className="mt-5 flex items-center gap-2 flex-wrap">
                {progressPct !== null && progressPct > 0 ? (
                  <button
                    onClick={() => openGallery(startIndex)}
                    className="inline-flex items-center gap-2 h-10 px-5 rounded-lg bg-accent text-accent-contrast hover:bg-accent-hover transition-colors text-sm font-medium shadow-sm"
                  >
                    <PlayFilledIcon size={13} />
                    <span>继续上次</span>
                    <span className="text-[11px] opacity-70 tabular-nums">
                      {Math.min(progress!.pageIndex + 1, currentPageCount)}/
                      {currentPageCount}
                    </span>
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      openGallery(0);
                      pushToast({ kind: "info", message: "开始浏览" });
                    }}
                    className="inline-flex items-center gap-2 h-10 px-5 rounded-lg bg-accent text-accent-contrast hover:bg-accent-hover transition-colors text-sm font-medium shadow-sm"
                  >
                    <ReaderIcon size={13} />
                    <span>开始浏览</span>
                  </button>
                )}

                <button
                  onClick={toggleFavorite}
                  className={`inline-flex items-center gap-1.5 h-10 px-3.5 rounded-lg text-[13px] transition-colors ${
                    isFav
                      ? "bg-warning/10 text-warning border border-warning/30"
                      : "border border-border-faint text-fg-muted hover:text-fg hover:bg-bg-subtle"
                  }`}
                >
                  <StarIcon size={13} filled={isFav} />
                  <span>{isFav ? "已收藏" : "收藏"}</span>
                </button>

                <div ref={moreRef} className="relative">
                  <button
                    ref={moreButtonRef}
                    type="button"
                    onClick={() => setMoreOpen((v) => !v)}
                    className="inline-flex items-center justify-center w-10 h-10 rounded-lg text-fg-muted hover:text-fg hover:bg-bg-subtle border border-border-faint transition-colors"
                    title="更多"
                    aria-label="更多操作"
                    aria-haspopup="menu"
                    aria-expanded={moreOpen}
                  >
                    <MoreHorizontalIcon size={15} />
                  </button>
                  {moreOpen && (
                    <div
                      ref={moreMenuRef}
                      role="menu"
                      aria-label="相册更多操作"
                      className="absolute right-0 top-full mt-1.5 min-w-[180px] bg-bg-elevated border border-border rounded-lg shadow-lg py-1 z-40 fade-up"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMoreOpen(false);
                          openInExplorer();
                        }}
                        disabled={!actions.canOpenInExplorer}
                        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[13px] text-fg-muted hover:bg-bg-subtle hover:text-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <FolderIcon size={12} />
                        <span>在资源管理器中打开</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMoreOpen(false);
                          copyLink();
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[13px] text-fg-muted hover:bg-bg-subtle hover:text-fg transition-colors"
                      >
                        <CopyIcon size={12} />
                        <span>复制链接</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 缩略图网格 */}
      <div className="px-6 lg:px-10 pt-5 pb-3 flex items-center gap-3 max-w-[1400px] mx-auto w-full">
        <ImageIcon size={12} className="text-fg-muted" />
        <h2 className="text-[11px] uppercase tracking-[0.18em] text-fg-muted font-medium">
          {videoCount > 0 ? "全部媒体" : "所有页面"}
        </h2>
        <span className="text-[11px] text-fg-subtle tabular-nums">
          {videoCount > 0
            ? `${detail.imageCount} 张 · ${videoCount} 个视频`
            : `${detail.imageCount} 张`}
        </span>
        <span className="text-fg-subtle/40">·</span>
        <div className="flex items-center border border-border-faint rounded-md overflow-hidden text-xs ml-auto">
          {(["sm", "md", "lg"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setGridSize(k)}
              className={`h-7 px-2.5 transition-colors ${
                gridSize === k
                  ? "bg-bg-subtle text-fg"
                  : "text-fg-muted hover:text-fg"
              }`}
              title={k === "sm" ? "密集" : k === "md" ? "标准" : "宽松"}
              aria-label={k === "sm" ? "密集" : k === "md" ? "标准" : "宽松"}
            >
              {k === "sm" ? "S" : k === "md" ? "M" : "L"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {videoCount > 0 ? (
          <MixedMediaThumbnailGrid
            items={mediaItems}
            total={detail.imageCount + videoCount}
            gridClassName={gridCls}
            progressIndex={progress?.pageIndex}
            videoInfos={videoInfos.data ?? {}}
            hasNextPage={hasNextPage}
            isLoadingMore={isLoadingMore}
            onLoadMore={onLoadMore}
            onOpen={openMedia}
            onContextMenu={(item, event) => {
              if (item.kind !== "image") return;
              event.preventDefault();
              event.currentTarget.focus({ preventScroll: true });
              setContextMenu({
                x: event.clientX,
                y: event.clientY,
                index: item.kindIndex,
              });
            }}
          />
        ) : (
          <MediaThumbnailGrid
            files={imageFiles}
            total={detail.imageCount}
            gridClassName={gridCls}
            progressIndex={progress?.pageIndex}
            hasNextPage={hasNextPage}
            isLoadingMore={isLoadingMore}
            onLoadMore={onLoadMore}
            onOpen={openGallery}
            onContextMenu={(index, event) => {
              event.preventDefault();
              event.currentTarget.focus({ preventScroll: true });
              setContextMenu({ x: event.clientX, y: event.clientY, index });
            }}
          />
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={[
            {
              id: "open",
              label: "打开此页",
              icon: <ArrowRightLineIcon size={12} />,
            },
            {
              id: "favorite",
              label: isFav ? "取消收藏" : "收藏",
              icon: <StarIcon size={12} />,
            },
            { id: "sep1", separator: true } as AnyMenuItem,
            {
              id: "explorer",
              label: "在资源管理器中打开",
              icon: <ArrowUpRightIcon size={12} />,
              disabled: !actions.canOpenInExplorer,
            },
            { id: "copy", label: "复制相册链接", icon: <CopyIcon size={12} /> },
            { id: "sep2", separator: true } as AnyMenuItem,
            { id: "properties", label: "属性", icon: <InfoIcon size={12} /> },
          ]}
          onSelect={(id) => {
            switch (id) {
              case "open":
                openGallery(contextMenu.index);
                break;
              case "favorite":
                toggleFavorite();
                break;
              case "explorer":
                openInExplorer();
                break;
              case "copy":
                copyLink();
                break;
              case "properties": {
                const img = imageFiles[contextMenu.index];
                if (img) {
                  setPropertiesFileId(img);
                }
                break;
              }
            }
            setContextMenu(null);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      <PropertiesDialog
        target={
          propertiesFileId ? { kind: "image", id: propertiesFileId } : null
        }
        onClose={() => setPropertiesFileId(null)}
      />
    </div>
  );
}

function CollectionView({
  detail,
  query,
  sortBy,
  viewMode,
  onBack,
  onToggleFav,
  isFavorite,
}: {
  detail: CollectionDetail;
  query: string;
  // 复用全局 SortKey:Album 详情也支持「最近看」('viewed' 用 history 排序)
  sortBy: "name" | "count" | "recent" | "viewed";
  viewMode: "grid" | "list";
  onBack: () => void;
  onToggleFav: () => void;
  isFavorite: boolean;
}) {
  // 集合:把直属于本层的 Albums + 嵌套子集合 Collections 都展平成统一
  // 的 CardData 列表渲染。子集合(5 层嵌套的中间层)用 variant=
  // 'collection' 区分,点击继续下钻。
  const allCards: CardData[] = useMemo(() => {
    const albums = detail.albums ?? [];
    const albumCards: CardData[] = albums.map((a) => ({
      id: "a:" + a.path,
      variant: "album",
      // 散图在集合内已有父目录做上下文，标题回到语义名：否则 "2011年"
      // 集合里会出现一张同样叫 "2011年" 的卡片（location 就是父目录名）。
      title: a.virtual ? "本目录媒体" : a.name,
      subtitle: a.virtual ? "" : a.tags.join(" · "),
      count: a.imageCount,
      imageCount: a.imageCount,
      videoCount: a.videoCount ?? 0,
      modTime: a.modTime,
      coverPath: a.coverImage,
      coverKind: a.coverKind,
      to: `/albums/${encodeURIComponent(a.path)}`,
    }));
    const collCards: CardData[] = (detail.collections ?? []).map((sub) => {
      return {
        id: "c:" + sub.path,
        variant: "collection",
        title: sub.name,
        displayTitle: sub.displayName,
        subtitle: "子集合",
        count: sub.albumCount,
        coverPath: sub.coverImage,
        covers: sub.coverImages,
        to: `/albums/${encodeURIComponent(sub.path)}`,
        sourceRoot: sub.sourceRoot,
        sourceName: sub.sourceName,
        modTime: sub.modTime,
      };
    });
    return [...albumCards, ...collCards];
  }, [detail]);
  const needsHistory = sortBy === "viewed" && detail.albums.length > 0;
  const { query: historyQuery, compareViewed } = useViewedSort(needsHistory);

  const filtered = useMemo(() => {
    const items = allCards.filter(
      (c) => !query || c.title.toLowerCase().includes(query.toLowerCase()),
    );
    switch (sortBy) {
      case "count":
        return items.sort((a, b) => b.count - a.count);
      case "recent":
        return items.sort(
          (a, b) =>
            compareDatesDesc(a.modTime, b.modTime) ||
            a.title.localeCompare(b.title),
        );
      case "viewed":
        return items.sort(
          (a, b) =>
            compareViewed(decodeFavPath(a.to), decodeFavPath(b.to)) ||
            a.title.localeCompare(b.title),
        );
      default:
        return items.sort((a, b) => a.title.localeCompare(b.title));
    }
  }, [allCards, query, sortBy, compareViewed]);

  const cards = filtered;

  // 子集合页时间线:对当前集合下的子 album/子 collection 重新分桶,跟首页视觉一致。
  const yearGroups = useMemo(() => {
    return groupAlbumsAndCollectionsByYear(
      detail.albums ?? [],
      detail.collections ?? [],
    );
  }, [detail]);

  // 集合页面作为上下文源
  const collEntries = useMemo<GalleryContextEntry[]>(
    () =>
      cards.map((c) => ({
        key: c.to,
        to: c.to,
        name: c.title,
        // 集合下是子相册，不能直接翻页：跳本时要跳过它。
        kind: c.variant === "collection" ? "collection" : "album",
        imageCount: c.imageCount,
        videoCount: c.videoCount,
      })),
    [cards],
  );
  useGalleryContextSync(
    { type: "collection", parentPath: detail.path },
    collEntries,
  );

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 lg:px-10 pt-8 pb-5">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1 text-xs text-fg-subtle hover:text-fg mb-4 transition-colors"
        >
          <ChevronLeftIcon size={12} />
          <span>返回</span>
        </button>
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <FolderIcon size={13} className="text-fg-muted" />
              <span className="text-[11px] uppercase tracking-[0.14em] text-fg-muted">
                集合
              </span>
            </div>
            <h1 className="font-display text-2xl font-semibold tracking-tight truncate">
              {detail.name}
            </h1>
            <div className="text-sm text-fg-muted mt-1.5">
              <span className="tabular-nums">{detail.albumCount} 卷</span>
            </div>
          </div>
          <button
            onClick={onToggleFav}
            className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs transition-colors ${
              isFavorite
                ? "bg-warning/10 text-warning hover:bg-warning/15"
                : "border border-border-faint hover:bg-bg-subtle text-fg-muted"
            }`}
          >
            <StarIcon size={12} filled={isFavorite} />
            <span>{isFavorite ? "已收藏" : "收藏"}</span>
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {needsHistory && <ViewedSortNotice query={historyQuery} />}
        <ListFilterBar totalCount={cards.length} showMinImageFilter={false} />
        {/* 时间线只在 ≥2 个年份桶时才有意义:
            - 大多数子集合(如 2023年、B站、散图)子相册基本不带 4 位年份,
              全部进「其他」桶,1 张大年卡独享一整行,视觉比例严重失衡。
            - 只有用户刻意把子相册命名成「2024国庆」之类,时间线才能
              真正按年分组,这时显示时间线才有用。 */}
        {yearGroups.length >= 2 && (
          <div className="py-6">
            <div className="px-6 lg:px-10 max-w-[1400px] mx-auto w-full flex items-center gap-3 mb-4">
              <CalendarIcon size={13} className="text-fg-muted" />
              <h2 className="text-[11px] uppercase tracking-[0.18em] text-fg-muted font-medium">
                时间线
              </h2>
              <span className="text-[11.5px] text-fg-subtle">
                按年份浏览 — 当前集合下的子相册/子集合
              </span>
            </div>
            <YearTimeline groups={yearGroups} />
          </div>
        )}
        {cards.length === 0 ? (
          <EmptyState
            title="无匹配结果"
            description="试试修改搜索条件或排序。"
          />
        ) : (
          <AlbumGrid items={cards} variant={viewMode} />
        )}
      </div>
    </div>
  );
}

// 纯视频专辑视图：与 AlbumView 视觉骨架一致（hero + 元信息 + CTA），
// 主体用 3:4 网格展示视频文件，每格用 VideoCoverImage（自动抽帧）。
// 点击 → /gallery?type=video&path=<album>&index=<n>&name=<file>。
function VideoAlbumView({
  detail,
  onBack,
  hasNextPage,
  isLoadingMore,
  onLoadMore,
}: {
  detail: AlbumDetail;
  onBack: () => void;
  hasNextPage: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
}) {
  const navigate = useNavigate();
  const { add: addFav, toggle: toggleFav, favorites } = useFavorites();
  const pushToast = useUIStore((s) => s.pushToast);
  const isFav = favorites.includes(detail.path);
  const videos = detail.videoFiles ?? [];

  // 解析 file ID → 真实文件名（视频列表项展示需要）
  //
  // 后端把扫描到的所有文件统一改成 "f_XXX" 这种外部资源 ID,前端拿不到
  // 原文件名。`videos[i]` 就是这种 ID,直接 `split('/').pop()` 还是 ID 本身,
  // UI 上就会出现 "f_abc123..." 这种"乱码"标题。
  //
  // 走 /api/videos/:id/info 一次拿全元数据(name / dir / 时长 / 码率),
  // 顺带在卡片上展示时长,而不是只有"视频 1 / 视频 2"序号。
  const videoInfos = useQuery({
    queryKey: ["video-infos", detail.path, videos],
    queryFn: () => getVideoInfoBatch(videos),
    enabled: videos.length > 0,
    staleTime: 5 * 60_000,
  });

  const openVideo = (idx: number) => {
    const qs = new URLSearchParams({
      path: detail.path,
      index: String(idx),
      name: detail.name,
      type: "video",
    });
    navigate(`/gallery?${qs.toString()}`);
  };

  const toggleFavorite = () => {
    if (isFav) {
      toggleFav(detail.path)
        .then(() => pushToast({ kind: "success", message: "已取消收藏" }))
        .catch(() => pushToast({ kind: "error", message: "操作失败" }));
    } else {
      addFav(detail.path)
        .then(() => pushToast({ kind: "success", message: "已加入收藏" }))
        .catch(() => pushToast({ kind: "error", message: "操作失败" }));
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Hero：大封面 + 标题 + CTA（与 AlbumView 视觉一致） */}
      <section className="relative bg-bg-elevated border-b border-border-faint">
        <div className="absolute inset-0 overflow-hidden">
          <div className="w-full h-full bg-bg-subtle scale-110 blur-2xl opacity-25" />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-bg-elevated/40 to-bg-elevated" />
        </div>
        <div className="relative px-6 lg:px-10 pt-6 pb-8 max-w-[1400px] mx-auto w-full">
          <div className="flex items-center gap-3 mb-5">
            <button
              onClick={onBack}
              className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg transition-colors"
            >
              <ChevronLeftIcon size={12} />
              <span>返回</span>
            </button>
            <span className="text-fg-subtle/50 text-xs">/</span>
            <span className="text-xs text-fg-muted truncate">
              {detail.name}
            </span>
          </div>

          <div className="flex items-end gap-8 flex-wrap">
            {/* 大封面（视频时由 VideoCoverImage 处理抽帧） */}
            <div className="relative w-32 h-44 sm:w-40 sm:h-56 rounded-lg overflow-hidden border border-border shadow-md shrink-0 bg-bg-subtle">
              <VideoCoverImage
                videoPath={detail.coverImage}
                alt={detail.name}
                loading="eager"
              />
            </div>

            <div className="min-w-0 flex-1">
              <h1 className="font-display text-2xl sm:text-[28px] font-semibold tracking-[-0.01em] leading-tight">
                {detail.name}
              </h1>
              <div className="flex items-center gap-2 text-sm text-fg-muted mt-2 flex-wrap">
                {detail.tags.length > 0 && (
                  <>
                    <span className="text-fg">{detail.tags.join(" · ")}</span>
                    <span className="text-fg-subtle/50">·</span>
                  </>
                )}
                <span className="tabular-nums">
                  {detail.videoCount ?? videos.length} 个视频
                </span>
                {detail.folderSize > 0 && (
                  <>
                    <span className="text-fg-subtle/50">·</span>
                    <span className="tabular-nums">
                      {formatSize(detail.folderSize)}
                    </span>
                  </>
                )}
                {detail.modTime && (
                  <>
                    <span className="text-fg-subtle/50">·</span>
                    <span className="text-fg-subtle inline-flex items-center gap-1">
                      <ClockIcon size={11} />
                      {formatRelative(detail.modTime)}
                    </span>
                  </>
                )}
              </div>

              <div className="mt-5 flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => openVideo(0)}
                  className="inline-flex items-center gap-2 h-10 px-5 rounded-lg bg-accent text-accent-contrast hover:bg-accent-hover transition-colors text-sm font-medium shadow-sm"
                >
                  <PlayFilledIcon size={13} />
                  <span>开始播放</span>
                </button>

                <button
                  onClick={toggleFavorite}
                  className={`inline-flex items-center gap-1.5 h-10 px-3.5 rounded-lg text-[13px] transition-colors ${
                    isFav
                      ? "bg-warning/10 text-warning border border-warning/30"
                      : "border border-border-faint text-fg-muted hover:text-fg hover:bg-bg-subtle"
                  }`}
                >
                  <StarIcon size={13} filled={isFav} />
                  <span>{isFav ? "已收藏" : "收藏"}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 视频网格 */}
      <div className="px-6 lg:px-10 pt-5 pb-3 flex items-center gap-3 max-w-[1400px] mx-auto w-full">
        <ImageIcon size={12} className="text-fg-muted" />
        <h2 className="text-[11px] uppercase tracking-[0.18em] text-fg-muted font-medium">
          全部视频
        </h2>
        <span className="text-[11px] text-fg-subtle tabular-nums">
          {detail.videoCount ?? videos.length} 个
        </span>
      </div>

      <div className="flex-1 overflow-auto">
        <VideoThumbnailGrid
          videos={videos}
          total={detail.videoCount ?? videos.length}
          infos={videoInfos.data ?? {}}
          hasNextPage={hasNextPage}
          isLoadingMore={isLoadingMore}
          onLoadMore={onLoadMore}
          onOpen={openVideo}
        />
      </div>
    </div>
  );
}
