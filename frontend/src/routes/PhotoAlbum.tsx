import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { LibraryMediaItem, LibraryNodeSummary } from "../api/library";
import { albumsApi } from "../api/albums";
import { useAlbumMedia } from "../hooks/useLibrary";
import { useFavorites } from "../hooks/useFavorites";
import { useAlbumActions } from "../hooks/useAlbumActions";
import { useUIStore } from "../store/uiStore";
import {
  usePhotoStore,
  WALL_DENSITY_HEIGHT,
  WALL_DENSITY_LABEL,
  type WallDensity,
} from "../store/photoStore";
import PhotoWall from "../components/wall/PhotoWall";
import PhotoViewer from "../components/wall/PhotoViewer";
import ContextMenu, { type AnyMenuItem } from "../components/album/ContextMenu";
import PropertiesDialog from "../components/common/PropertiesDialog";
import Popover, {
  PopoverItem,
  PopoverLabel,
} from "../components/common/Popover";
import {
  ArrowUpRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ImageIcon,
  CopyIcon,
  FolderIcon,
  GridIcon,
  InfoIcon,
  MoreHorizontalIcon,
  StarIcon,
} from "../components/common/Icon";
import { fileManagerErrorMessage } from "../utils/fileManager";
import { useSafeBack } from "../utils/navigation";
import { albumRoute, homeRoute } from "../utils/path";
import { mediaCountParts } from "../utils/mediaCount";

interface Props {
  /** 相册摘要（含内容用途与封面）。 */
  album: LibraryNodeSummary;
}

/** 每档密度用多少个小方块示意疏密。 */
const DENSITY_GRID: Record<WallDensity, { cols: number; rows: number }> = {
  compact: { cols: 5, rows: 4 },
  cozy: { cols: 4, rows: 3 },
  large: { cols: 3, rows: 2 },
};

/**
 * 密度示意：方块排得越密，读数就是越紧凑。
 *
 * 原来的 S / M / L 三个字母要求读者先建立「字母 = 档位」的对应关系，
 * 而档位名（密集 / 标准 / 宽松）已经写在提示里；图形直接说出疏密。
 */
function DensityGlyph({ level }: { level: WallDensity }) {
  const { cols, rows } = DENSITY_GRID[level];
  const cell = 16 / cols;
  const gap = 1.2;
  return (
    <svg
      viewBox="0 0 16 16"
      width={15}
      height={15}
      aria-hidden="true"
      focusable="false"
    >
      {Array.from({ length: rows }).map((_, r) =>
        Array.from({ length: cols }).map((__, c) => (
          <rect
            key={`${r}-${c}`}
            x={c * cell}
            y={r * cell}
            width={cell - gap}
            height={cell - gap}
            rx={0.6}
            fill="currentColor"
          />
        )),
      )}
    </svg>
  );
}

/**
 * 照片相册页：打开即是照片墙。
 *
 * 与漫画阅读器是两条完全不同的路径：这里没有页码、没有双页、没有阅读
 * 进度，只做「平铺浏览 → 点开大图」。相册级操作（收藏、封面、类型切换）
 * 收在顶部工具条，不再占用一整屏的封面区。
 */
export default function PhotoAlbum({ album }: Props) {
  const goBack = useSafeBack(homeRoute("photo"));
  const queryClient = useQueryClient();
  const pushToast = useUIStore((s) => s.pushToast);
  const density = usePhotoStore((s) => s.density);
  const setDensity = usePhotoStore((s) => s.setDensity);
  const { toggle: toggleFav, favorites } = useFavorites();
  const isFavorite = favorites.includes(album.id);
  // 媒体根数量：单根时不必在页头上重复来源。
  const multiRoot = useUIStore((s) => s.multiRoot);

  const mediaQuery = useAlbumMedia(album.id);
  const mediaItems = useMemo<LibraryMediaItem[]>(
    () => mediaQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [mediaQuery.data],
  );
  const total = mediaQuery.data?.pages[0]?.total ?? mediaItems.length;

  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  // 右键菜单：照片墙上的图片同样能查看属性、在资源管理器中定位。
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: LibraryMediaItem;
  } | null>(null);
  const [propertiesFileId, setPropertiesFileId] = useState<string | null>(null);

  const title = album.virtual
    ? album.location || album.displayName || album.name
    : album.displayName || album.name;

  const actions = useAlbumActions({
    id: "a:" + album.id,
    variant: "album",
    title,
    subtitle: (album.tags ?? []).join(" · "),
    count: album.imageCount ?? 0,
    coverPath: album.coverImage ?? "",
    coverKind: album.coverKind ?? "image",
    to: albumRoute("photo", album.id),
    isFavorite,
  });

  // 照片墙的帮助浮层多一组大图预览的操作；离开本页时复位。
  const setHelpContext = useUIStore((s) => s.setHelpContext);
  useEffect(() => {
    setHelpContext("photo");
    return () => setHelpContext("library");
  }, [setHelpContext]);

  const loadMore = useCallback(() => {
    void mediaQuery.fetchNextPage({ cancelRefetch: false });
  }, [mediaQuery]);

  const onOpen = useCallback(
    (item: LibraryMediaItem, index: number) => {
      if (item.kind === "video") {
        // 视频在大图预览里播放，位置与图片共用同一套切换逻辑。
        setViewerIndex(index);
        return;
      }
      setViewerIndex(index);
    },
    [],
  );

  const setCover = useCallback(async () => {
    const item = viewerIndex === null ? undefined : mediaItems[viewerIndex];
    if (!item) return;
    try {
      await albumsApi.setCover(album.id, item.id);
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      pushToast({ kind: "success", message: "已设为封面" });
    } catch {
      pushToast({ kind: "error", message: "设置封面失败" });
    }
  }, [album.id, mediaItems, pushToast, queryClient, viewerIndex]);

  const copyLink = useCallback(async () => {
    try {
      await actions.copyLink();
      pushToast({ kind: "success", message: "已复制链接", ttl: 1200 });
    } catch {
      pushToast({ kind: "error", message: "复制失败，请检查浏览器权限" });
    }
  }, [actions, pushToast]);

  const openInExplorer = useCallback(async () => {
    try {
      await actions.openInExplorer();
      pushToast({ kind: "success", message: "已请求打开目录", ttl: 1200 });
    } catch (error: unknown) {
      pushToast({ kind: "error", message: fileManagerErrorMessage(error) });
    }
  }, [actions, pushToast]);

  const toggleFavorite = useCallback(() => {
    void toggleFav(album.id)
      .then(() =>
        pushToast({
          kind: "success",
          message: isFavorite ? "已取消收藏" : "已加入收藏",
        }),
      )
      .catch(() => pushToast({ kind: "error", message: "操作失败" }));
  }, [album.id, isFavorite, pushToast, toggleFav]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {mediaQuery.isFetchNextPageError && (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-3 bg-warning/10 px-4 py-2.5 text-body text-fg sm:px-6"
        >
          <span>后续媒体加载失败，已加载内容仍可浏览。</span>
          <button
            type="button"
            onClick={loadMore}
            disabled={mediaQuery.isFetchingNextPage}
            className="shrink-0 text-accent hover:underline disabled:opacity-50"
          >
            {mediaQuery.isFetchingNextPage ? "正在重试…" : "重试加载"}
          </button>
        </div>
      )}
      <header className="shrink-0 border-b border-border-faint bg-bg">
        {/* 照片墙与其它页面的内容左缘保持一致：留白用同一套 gutter，
            宽屏时照片铺满但边缘不跑掉。 */}
        <div className="px-[clamp(20px,3vw,48px)]">
          <div className="album-bar">
            <button
              type="button"
              onClick={goBack}
              className="btn btn-sm btn-ghost -ml-2 shrink-0"
              aria-label="返回"
            >
              <ChevronLeftIcon size={13} />
              <span className="hidden sm:inline">返回</span>
            </button>

            {/* 标题行：集合 › 相册 › 计数。
                照片墙是浏览页，页头要薄 —— 它占的每一行都是照片的位置。
                身份信息摊在同一行上（左）比堆成两行更省高度，
                也让「这一本在库里的哪个位置」一眼可读。 */}
            <div className="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              {/* 这一本在库里的位置：所属集合。散图相册的标题本身就是
                  归属目录，没有第二层可说，就不重复报。
                  集合名是一段路径，不是一段文字：点它回到那个集合，
                  否则从相册里找不到回去的路。 */}
              {album.parentName && (
                <>
                  {album.parentId ? (
                    <Link
                      to={albumRoute("photo", album.parentId)}
                      className="album-bar__crumb inline-flex items-center gap-1 truncate hover:text-brand-ink transition-colors"
                      title={`回到集合「${album.parentName}」`}
                    >
                      <FolderIcon size={11} className="shrink-0" />
                      {album.parentName}
                    </Link>
                  ) : (
                    <span className="album-bar__crumb inline-flex items-center gap-1 truncate">
                      <FolderIcon size={11} className="shrink-0" />
                      {album.parentName}
                    </span>
                  )}
                  <ChevronRightIcon size={12} className="shrink-0 text-fg-subtle" />
                </>
              )}
              <h1 className="album-bar__title truncate">{title}</h1>
              <div className="album-bar__meta tabular-nums">
                {/* 计数口径与其它地方一致：纯视频相册说「2 个视频」，
                    不再写「0 张 · 2 个视频」。 */}
                <span>
                  <span className="text-fg font-medium">
                    {mediaCountParts(album).lead}
                  </span>
                  {mediaCountParts(album).rest && (
                    <>
                      {" "}
                      <span className="text-fg-subtle">·</span>{" "}
                      <span className="text-fg font-medium">
                        {mediaCountParts(album).rest}
                      </span>
                    </>
                  )}
                </span>
                {/* 媒体根：只有配置了多个根才值得说，否则每本都挂一句
                    同样的来源，是噪音。 */}
                {multiRoot && album.sourceName && (
                  <>
                    <span className="text-fg-subtle">·</span>
                    <span className="truncate">来自 {album.sourceName}</span>
                  </>
                )}
              </div>
            </div>

            {/* 右侧操作收成一组：密度切换、收藏、更多。
                组内用 hairline 分隔，读起来是一个工具条而不是三个孤立按钮。 */}
            <div className="hidden items-center gap-2 md:flex">
              <span className="text-meta text-fg-subtle">密度</span>
              <div className="flex items-center overflow-hidden rounded-md border border-border-faint text-meta">
                {(["compact", "cozy", "large"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setDensity(key)}
                    className={`inline-flex h-7 w-8 items-center justify-center transition-colors ${
                      density === key
                        ? "bg-bg-subtle text-fg"
                        : "text-fg-muted hover:text-fg"
                    }`}
                    title={WALL_DENSITY_LABEL[key]}
                    aria-label={WALL_DENSITY_LABEL[key]}
                    aria-pressed={density === key}
                  >
                    {/* 密度用排布示意，不写 S/M/L 三个字母：
                        字母要读者先知道它对应哪一档，图形直接说「疏 / 密」。 */}
                    <DensityGlyph level={key} />
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={toggleFavorite}
              className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors ${
                isFavorite
                  ? "text-favorite hover:bg-favorite/10"
                  : "text-fg-muted hover:bg-bg-subtle hover:text-fg"
              }`}
              title={isFavorite ? "取消收藏" : "收藏"}
              aria-label={isFavorite ? "取消收藏" : "收藏"}
            >
              <StarIcon size={15} filled={isFavorite} />
            </button>

            <Popover
              align="end"
              aria-label="相册更多操作"
              trigger={
                <button
                  type="button"
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-bg-subtle hover:text-fg"
                  title="更多"
                  aria-label="更多操作"
                >
                  <MoreHorizontalIcon size={15} />
                </button>
              }
            >
              <PopoverLabel>相册</PopoverLabel>
              <PopoverItem
                onClick={() => void openInExplorer()}
                disabled={!actions.canOpenInExplorer}
              >
                <FolderIcon size={13} />
                <span>在资源管理器中打开</span>
              </PopoverItem>
              <PopoverItem onClick={() => void copyLink()}>
                <CopyIcon size={13} />
                <span>复制相册链接</span>
              </PopoverItem>
              {/* 「用当前查看的图片设为封面」原先在这里，但它是个死动作：
                  查看器是一层全屏浮层，打开时根本够不到这个菜单；
                  关掉查看器后 viewerIndex 已经清空，点了也不会有任何反应。
                  真正可用的两个入口是查看器里的「设为封面」按钮，
                  以及照片墙上右键单张照片时的「设为封面」。 */}
            </Popover>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 px-[clamp(20px,3vw,48px)] pb-2">
        {/* 只有第一页就没加载出来才整页报错：后续分页失败时已加载的内容
            仍然能翻，页头的提示条已经说明了失败与重试。 */}
        {mediaQuery.isError && mediaItems.length === 0 ? (
          <div className="flex h-full items-center justify-center text-body text-fg-muted">
            媒体加载失败，请重试。
          </div>
        ) : (
          <PhotoWall
            items={mediaItems}
            total={total}
            targetHeight={WALL_DENSITY_HEIGHT[density]}
            hasNextPage={mediaQuery.hasNextPage ?? false}
            isLoadingMore={mediaQuery.isFetchingNextPage}
            onLoadMore={loadMore}
            onOpen={onOpen}
            onContextMenu={(item, event) => {
              event.preventDefault();
              event.currentTarget.focus({ preventScroll: true });
              setContextMenu({ x: event.clientX, y: event.clientY, item });
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
              label: "查看大图",
              icon: <GridIcon size={12} />,
            },
            {
              id: "cover",
              label: "设为封面",
              icon: <ImageIcon size={12} />,
            },
            { id: "sep1", separator: true } as AnyMenuItem,
            {
              id: "properties",
              label: "属性",
              icon: <InfoIcon size={12} />,
            },
            {
              id: "explorer",
              label: "在资源管理器中打开",
              icon: <ArrowUpRightIcon size={12} />,
              disabled: !actions.canOpenInExplorer,
            },
          ]}
          onSelect={(id) => {
            const item = contextMenu.item;
            setContextMenu(null);
            if (id === "open") {
              const index = mediaItems.findIndex((it) => it.id === item.id);
              if (index >= 0) onOpen(item, index);
              return;
            }
            if (id === "cover") {
              setPropertiesFileId(null);
              void albumsApi
                .setCover(album.id, item.id)
                .then(() => {
                  void queryClient.invalidateQueries({ queryKey: ["library"] });
                  pushToast({ kind: "success", message: "已设为封面" });
                })
                .catch(() =>
                  pushToast({ kind: "error", message: "设置封面失败" }),
                );
              return;
            }
            if (id === "properties") {
              setPropertiesFileId(item.id);
            }
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

      {viewerIndex !== null && (
        <PhotoViewer
          items={mediaItems}
          index={viewerIndex}
          albumName={title}
          onIndexChange={(index) => setViewerIndex(index)}
          onClose={() => setViewerIndex(null)}
          isFavorite={isFavorite}
          onToggleFavorite={toggleFavorite}
          onSetCover={() => void setCover()}
          hasCustomCover={album.hasCustomCover}
        />
      )}
    </div>
  );
}
