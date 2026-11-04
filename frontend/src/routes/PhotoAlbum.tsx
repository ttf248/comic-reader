import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { LibraryMediaItem, LibraryNodeSummary } from "../api/library";
import { albumsApi } from "../api/albums";
import { useAlbumMedia } from "../hooks/useLibrary";
import { useFavorites } from "../hooks/useFavorites";
import { usePhotoActivity } from "../hooks/usePhotoActivity";
import { useAlbumActions } from "../hooks/useAlbumActions";
import { useUIStore } from "../store/uiStore";
import {
  usePhotoStore,
  WALL_DENSITY_HEIGHT,
  WALL_DENSITY_LABEL,
} from "../store/photoStore";
import PhotoWall from "../components/wall/PhotoWall";
import PhotoViewer from "../components/wall/PhotoViewer";
import ContentKindSwitch from "../components/common/ContentKindSwitch";
import Popover, {
  PopoverItem,
  PopoverLabel,
} from "../components/common/Popover";
import {
  ChevronLeftIcon,
  CopyIcon,
  FolderIcon,
  GridIcon,
  MoreHorizontalIcon,
  StarIcon,
} from "../components/common/Icon";
import { fileManagerErrorMessage } from "../utils/fileManager";
import { useSafeBack } from "../utils/navigation";
import { readerRoute } from "../utils/path";

interface Props {
  /** 相册摘要（含内容用途与封面）。 */
  album: LibraryNodeSummary;
}

/**
 * 照片相册页：打开即是照片墙。
 *
 * 与漫画阅读器是两条完全不同的路径：这里没有页码、没有双页、没有阅读
 * 进度，只做「平铺浏览 → 点开大图」。相册级操作（收藏、封面、类型切换）
 * 收在顶部工具条，不再占用一整屏的封面区。
 */
export default function PhotoAlbum({ album }: Props) {
  const navigate = useNavigate();
  const goBack = useSafeBack("/");
  const queryClient = useQueryClient();
  const pushToast = useUIStore((s) => s.pushToast);
  const density = usePhotoStore((s) => s.density);
  const setDensity = usePhotoStore((s) => s.setDensity);
  const { toggle: toggleFav, favorites } = useFavorites();
  const isFavorite = favorites.includes(album.id);

  const mediaQuery = useAlbumMedia(album.id);
  const mediaItems = useMemo<LibraryMediaItem[]>(
    () => mediaQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [mediaQuery.data],
  );
  const total = mediaQuery.data?.pages[0]?.total ?? mediaItems.length;

  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const { record } = usePhotoActivity(album.id);

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
    to: `/albums/${encodeURIComponent(album.id)}`,
    isFavorite,
  });

  // 打开照片墙就算「翻过」这本相册：未读统计需要一个明确的起点。
  useEffect(() => {
    if (total > 0) record(0, total);
  }, [record, total]);

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
      record(index, total);
    },
    [record, total],
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

  const switchKind = useCallback(
    (kind: "photo" | "comic") => {
      if (kind === "comic") {
        navigate(readerRoute(album.id));
      }
    },
    [album.id, navigate],
  );

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
      <header className="shrink-0 border-b border-border-faint bg-bg">
        <div className="flex items-center gap-3 px-3 py-2.5 sm:px-5">
          <button
            type="button"
            onClick={goBack}
            className="btn btn-sm btn-ghost -ml-2 shrink-0"
            aria-label="返回"
          >
            <ChevronLeftIcon size={13} />
            <span className="hidden sm:inline">返回</span>
          </button>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-medium text-fg">
              {title}
            </h1>
            <div className="text-[12px] tabular-nums text-fg-muted">
              {album.imageCount ?? 0} 张
              {(album.videoCount ?? 0) > 0 && ` · ${album.videoCount} 个视频`}
            </div>
          </div>

          <div className="hidden items-center gap-1 md:flex">
            <span className="text-[12px] text-fg-subtle">密度</span>
            <div className="flex items-center overflow-hidden rounded-md border border-border-faint text-[12.5px]">
              {(["compact", "cozy", "large"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setDensity(key)}
                  className={`h-7 px-2.5 transition-colors ${
                    density === key
                      ? "bg-bg-subtle text-fg"
                      : "text-fg-muted hover:text-fg"
                  }`}
                  title={WALL_DENSITY_LABEL[key]}
                  aria-label={WALL_DENSITY_LABEL[key]}
                  aria-pressed={density === key}
                >
                  {key === "compact" ? "S" : key === "cozy" ? "M" : "L"}
                </button>
              ))}
            </div>
          </div>

          <ContentKindSwitch
            albumId={album.id}
            kind="photo"
            defaultKind={album.contentKindDefault ?? "photo"}
            overridden={album.contentKindOverridden === true}
            onChanged={switchKind}
          />

          <button
            type="button"
            onClick={toggleFavorite}
            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors ${
              isFavorite
                ? "text-warning hover:bg-warning/10"
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
            <PopoverItem onClick={() => void setCover()}>
              <GridIcon size={13} />
              <span>用当前查看的图片设为封面</span>
            </PopoverItem>
          </Popover>
        </div>
      </header>

      <div className="min-h-0 flex-1 px-2 pb-2 sm:px-3">
        {mediaQuery.isError ? (
          <div className="flex h-full items-center justify-center text-[13px] text-fg-muted">
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
          />
        )}
      </div>

      {viewerIndex !== null && (
        <PhotoViewer
          items={mediaItems}
          index={viewerIndex}
          albumName={title}
          onIndexChange={(index) => {
            setViewerIndex(index);
            record(index, total);
          }}
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
