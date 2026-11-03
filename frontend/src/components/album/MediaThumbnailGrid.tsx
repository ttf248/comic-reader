import { useMemo, type MouseEvent } from "react";
import VirtualMediaGrid, { type MediaGridSize } from "./VirtualMediaGrid";
import { useMediaGridPagination } from "../../hooks/useMediaGridPagination";
import ThumbImage from "../common/ThumbImage";

interface Props {
  /** 已加载的图片资源 ID，顺序与相册媒体索引一致。 */
  files: string[];
  /** 当前媒体类型的服务端总数。 */
  total: number;
  gridSize: MediaGridSize;
  progressIndex?: number;
  hasNextPage: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onOpen: (index: number) => void;
  onContextMenu: (index: number, event: MouseEvent<HTMLButtonElement>) => void;
}

/**
 * 相册图片缩略图网格。
 *
 * 用轻量占位槽保留服务端总长度，虚拟列表只挂载视口附近的真实
 * 图片；滚动接近已加载边界时由父级继续加载媒体页。这样首屏不需要等待整本
 * 相册，也不会为数千张图片创建完整 DOM 树。
 */
export default function MediaThumbnailGrid({
  files,
  total,
  gridSize,
  progressIndex,
  hasNextPage,
  isLoadingMore,
  onLoadMore,
  onOpen,
  onContextMenu,
}: Props) {
  const rangeChanged = useMediaGridPagination({
    loadedCount: files.length,
    hasNextPage,
    isLoadingMore,
    onLoadMore,
  });
  const slots = useMemo(
    () =>
      Array.from(
        { length: Math.max(total, files.length) },
        (_, index) => files[index] ?? null,
      ),
    [files, total],
  );

  return (
    <VirtualMediaGrid
      data={slots}
      size={gridSize}
      computeItemKey={(index, item) => item ?? `media-placeholder-${index}`}
      rangeChanged={rangeChanged}
      itemContent={(index, file) => {
        if (!file) return <ThumbnailPlaceholder />;
        const isCurrent = progressIndex === index;
        const isPast = progressIndex !== undefined && index < progressIndex;
        return (
          <button
            type="button"
            onClick={() => onOpen(index)}
            onContextMenu={(event) => onContextMenu(index, event)}
            className={`group relative w-full aspect-[3/4] bg-bg-subtle rounded overflow-hidden transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              isCurrent ? "ring-2 ring-accent" : isPast ? "opacity-70" : ""
            }`}
            title={`第 ${index + 1} 张`}
            aria-label={`打开第 ${index + 1} 张`}
          >
            <ThumbImage
              fileId={file}
              alt={`第 ${index + 1} 张`}
              /* 裁切但保留页面上半部分：object-contain 会让横构图照片在
                 竖格里留下大片上下留边，整页网格看起来像一堆灰框；
                 改成 object-cover + 偏上取景（漫画页的标题与人物头部
                 都在上半部分），既有内容又不产生噪音。 */
              className="w-full h-full object-cover object-[50%_25%] transition-transform duration-300 group-hover:scale-[1.03]"
            />
            {isCurrent && (
              <div className="absolute top-1.5 left-1.5 bg-accent text-accent-fg text-[12.5px] font-medium px-1.5 py-0.5 rounded">
                当前
              </div>
            )}
            <div className="absolute bottom-1.5 right-1.5 text-[12.5px] bg-bg-elevated/90 backdrop-blur px-1.5 py-0.5 rounded text-fg tabular-nums">
              {index + 1}
            </div>
          </button>
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
