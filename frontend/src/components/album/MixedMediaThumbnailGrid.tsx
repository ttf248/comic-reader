import { useMemo, type MouseEvent } from "react";
import { VirtuosoGrid } from "react-virtuoso";
import type { LibraryMediaItem } from "../../api/library";
import type { VideoInfo } from "../../api/videos";
import { formatDuration } from "../../utils/format";
import { PlayFilledIcon } from "../common/Icon";
import VideoCoverImage from "../common/VideoCoverImage";
import { useMediaGridPagination } from "../../hooks/useMediaGridPagination";
import ThumbImage from "../common/ThumbImage";

interface Props {
  /** 已加载的混合媒体项，顺序与服务端媒体索引一致。 */
  items: LibraryMediaItem[];
  /** 图片与视频合计的服务端总数。 */
  total: number;
  /** Tailwind grid-cols 类名。 */
  gridClassName: string;
  /** 图片阅读进度使用 kindIndex，而不是混合媒体 index。 */
  progressIndex?: number;
  videoInfos: Record<string, VideoInfo>;
  hasNextPage: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onOpen: (item: LibraryMediaItem) => void;
  onContextMenu?: (
    item: LibraryMediaItem,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
}

/** 混合媒体相册的虚拟网格；图片和视频沿用服务端的统一媒体序号。 */
export default function MixedMediaThumbnailGrid({
  items,
  total,
  gridClassName,
  progressIndex,
  videoInfos,
  hasNextPage,
  isLoadingMore,
  onLoadMore,
  onOpen,
  onContextMenu,
}: Props) {
  const rangeChanged = useMediaGridPagination({
    loadedCount: items.length,
    hasNextPage,
    isLoadingMore,
    onLoadMore,
  });
  const slots = useMemo(
    () =>
      Array.from(
        { length: Math.max(total, items.length) },
        (_, index) => items[index] ?? null,
      ),
    [items, total],
  );

  return (
    <VirtuosoGrid
      style={{ height: "100%" }}
      data={slots}
      overscan={720}
      /* 多渲染一截虚拟窗口：Virtuoso 估算的整段滚动长度比真实布局高约两行，
         "拖到最底"时最后一行落在估算窗口之外，只剩占位块（图片渲染不出来）。
         把窗口下沿多留 1600px（约 6 行），估算误差就被覆盖住了。 */
      increaseViewportBy={{ top: 720, bottom: 1600 }}
      listClassName={`grid gap-2 px-6 lg:px-10 pb-10 max-w-[1400px] mx-auto ${gridClassName}`}
      itemClassName="min-w-0"
      computeItemKey={(index, item) =>
        item?.id ?? `mixed-media-placeholder-${index}`
      }
      rangeChanged={rangeChanged}
      itemContent={(_, item) => {
        if (!item) return <ThumbnailPlaceholder />;

        const isImage = item.kind === "image";
        const imageIndex = isImage ? item.kindIndex : undefined;
        const isCurrent =
          imageIndex !== undefined && progressIndex === imageIndex;
        const isPast =
          imageIndex !== undefined &&
          progressIndex !== undefined &&
          imageIndex < progressIndex;
        const info = isImage ? undefined : videoInfos[item.id];
        const name = isImage
          ? `第 ${item.kindIndex + 1} 张`
          : (info?.name ?? item.name ?? `视频 ${item.kindIndex + 1}`);
        const duration = info?.duration;

        return (
          <div
            /* 混合网格里图片与视频共用一个格子：图片用浅底，
               视频用深色媒体画布，让宽银幕的上下留边读成"电影画幅"
               而不是"缺图"。 */
            className={`group relative w-full aspect-[3/4] rounded overflow-hidden ${
              isImage ? "bg-bg-subtle" : "bg-bg-media"
            } ${
              isCurrent ? "ring-2 ring-accent" : isPast ? "opacity-70" : ""
            }`}
          >
            {isImage ? (
              <ThumbImage
                fileId={item.id}
                alt={name}
                className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
              />
            ) : (
              <VideoCoverImage videoPath={item.id} alt={name} loading="lazy" />
            )}
            <button
              type="button"
              onClick={() => onOpen(item)}
              onContextMenu={(event) => onContextMenu?.(item, event)}
              className="absolute inset-0 rounded transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
              title={name}
              aria-label={isImage ? `打开${name}` : `播放${name}`}
            >
              {!isImage && (
                <div className="absolute top-1.5 right-1.5 bg-bg-elevated/90 backdrop-blur rounded-md p-1 shadow-sm group-hover:scale-110 transition-transform">
                  <PlayFilledIcon size={10} className="text-accent" />
                </div>
              )}
              {isCurrent && (
                <div className="absolute top-1.5 left-1.5 bg-accent text-accent-fg text-[12.5px] font-medium px-1.5 py-0.5 rounded">
                  当前
                </div>
              )}
              <div className="absolute bottom-1.5 right-1.5 text-[12.5px] bg-bg-elevated/85 backdrop-blur px-1.5 py-0.5 rounded text-fg-muted tabular-nums">
                {isImage ? item.kindIndex + 1 : `视频 ${item.kindIndex + 1}`}
              </div>
              {!isImage && (
                <div className="absolute bottom-0 inset-x-0 px-1.5 pt-1.5 pb-1 bg-gradient-to-t from-black/85 from-80% to-transparent">
                  <div className="text-[12.5px] text-white/90 truncate flex items-center gap-1.5">
                    <span className="truncate">{name}</span>
                    {duration !== undefined && duration > 0 && (
                      <span className="shrink-0 text-white/70 tabular-nums">
                        {formatDuration(duration)}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </button>
          </div>
        );
      }}
    />
  );
}

function ThumbnailPlaceholder() {
  return (
    <div
      className="w-full aspect-[3/4] rounded bg-bg-subtle animate-pulse"
      aria-hidden="true"
    />
  );
}
