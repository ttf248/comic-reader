import { useMemo, type MouseEvent } from "react";
import { Virtuoso, type ListRange } from "react-virtuoso";
import type { LibraryMediaItem } from "../../api/library";
import { useElementWidth } from "../../hooks/useElementWidth";
import { useMediaGridPagination } from "../../hooks/useMediaGridPagination";
import ThumbImage from "../common/ThumbImage";
import VideoCoverImage from "../common/VideoCoverImage";
import { PlayFilledIcon } from "../common/Icon";
import {
  layoutJustified,
  tileRatio,
  type WallTile,
} from "./justifiedLayout";

interface Props {
  /** 已加载的媒体项，顺序与服务端媒体索引一致。 */
  items: LibraryMediaItem[];
  /** 图片与视频合计的服务端总数。 */
  total: number;
  /** 目标行高（像素）。 */
  targetHeight: number;
  hasNextPage: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onOpen: (item: LibraryMediaItem, index: number) => void;
  onContextMenu?: (
    item: LibraryMediaItem,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
}

const GAP = 8;

/**
 * 照片墙：按每张图真实宽高比排布的自适应网格。
 *
 * 与漫画阅读器彻底分开：这里没有页码、没有双页、没有阅读进度，
 * 只有「平铺浏览 → 点开大图」这一条路径。
 */
export default function PhotoWall({
  items,
  total,
  targetHeight,
  hasNextPage,
  isLoadingMore,
  onLoadMore,
  onOpen,
  onContextMenu,
}: Props) {
  const { ref: containerRef, width } = useElementWidth<HTMLDivElement>();

  const rangeChanged = useMediaGridPagination({
    loadedCount: items.length,
    hasNextPage,
    isLoadingMore,
    onLoadMore,
  });

  // 未加载的条目也占位，保证滚动长度与整本相册一致；它们的比例是估算值，
  // 真实尺寸到达后会重排，但重排只发生在视口之外的行。
  const tiles = useMemo<WallTile[]>(() => {
    const count = Math.max(total, items.length);
    const list: WallTile[] = [];
    for (let index = 0; index < count; index += 1) {
      const item = items[index];
      list.push({
        id: item?.id ?? `wall-placeholder-${index}`,
        ratio: tileRatio(item),
      });
    }
    return list;
  }, [items, total]);

  const rows = useMemo(
    () =>
      layoutJustified(tiles, {
        containerWidth: width,
        targetHeight,
        gap: GAP,
      }),
    [tiles, width, targetHeight],
  );

  const itemIndex = useMemo(() => {
    const map = new Map<string, number>();
    tiles.forEach((tile, index) => map.set(tile.id, index));
    return map;
  }, [tiles]);

  const handleRangeChanged = (range: ListRange) => {
    const start = rows[range.startIndex]?.tiles[0]?.id;
    const end = rows[range.endIndex]?.tiles.at(-1)?.id;
    if (!start || !end) return;
    const startIndex = itemIndex.get(start) ?? 0;
    const endIndex = itemIndex.get(end) ?? 0;
    rangeChanged({ startIndex, endIndex });
  };

  return (
    <div ref={containerRef} className="h-full min-h-0">
      {width > 0 && (
        <Virtuoso
          data={rows}
          style={{ height: "100%" }}
          overscan={600}
          increaseViewportBy={{ top: 600, bottom: 600 }}
          defaultItemHeight={targetHeight + GAP}
          computeItemKey={(_index, row) => row.key}
          rangeChanged={handleRangeChanged}
          itemContent={(_index, row) => (
            <div
              className="flex items-start"
              style={{
                height: row.height,
                gap: GAP,
                paddingBottom: GAP,
              }}
            >
              {row.tiles.map((tile) => {
                const index = itemIndex.get(tile.id) ?? 0;
                const item = items[index];
                if (!item) {
                  return (
                    <div
                      key={tile.id}
                      className="shrink-0 rounded bg-bg-subtle animate-pulse"
                      style={{ width: tile.width, height: row.tileHeight }}
                      aria-hidden="true"
                    />
                  );
                }
                const isVideo = item.kind === "video";
                const hasSize =
                  typeof item.width === "number" &&
                  typeof item.height === "number" &&
                  item.width > 0 &&
                  item.height > 0;
                return (
                  // 触发层是覆盖在封面之上的独立按钮：视频封面自带「重试」
                  // 按钮，把它包进 <button> 会产生嵌套按钮（无效 HTML，
                  // 键盘与读屏都会失灵）。
                  <div
                    key={tile.id}
                    className="group relative shrink-0 overflow-hidden rounded-sm bg-bg-subtle"
                    style={{ width: tile.width, height: row.tileHeight }}
                  >
                    {isVideo ? (
                      <VideoCoverImage
                        videoPath={item.id}
                        alt={item.name}
                        loading="lazy"
                      />
                    ) : (
                      <ThumbImage
                        fileId={item.id}
                        alt={item.name}
                        loading="lazy"
                        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => onOpen(item, index)}
                      onContextMenu={(event) => onContextMenu?.(item, event)}
                      className="absolute inset-0 z-0 block h-full w-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                      title={item.name}
                      aria-label={isVideo ? `播放 ${item.name}` : `查看 ${item.name}`}
                    />
                    {/* 视频角标：光靠一枚 10px 的三角不够 —— 形状与颜色都
                        说不清这是什么，带上「视频」两个字才不依赖颜色辨认。 */}
                    {isVideo && (
                      <span className="pointer-events-none absolute right-1.5 top-1.5 z-0 inline-flex items-center gap-1 rounded-md bg-black/65 px-1.5 py-0.5 text-badge font-medium text-white/90 backdrop-blur">
                        <PlayFilledIcon size={10} />
                        <span>视频</span>
                      </span>
                    )}
                    {/* 悬停信息层：文件名与像素尺寸。
                        照片墙是浏览页，光靠缩略图看不出「这是什么」；
                        尺寸来自服务端已带的 width / height，不用另发请求。 */}
                    <div
                      data-testid="wall-tile-info"
                      className="pointer-events-none absolute inset-x-0 bottom-0 z-0 flex items-end justify-between gap-2 px-2.5 pb-2 pt-9 bg-gradient-to-t from-black/85 via-black/40 to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                    >
                      <span className="truncate text-meta text-white/90">
                        {item.name}
                      </span>
                      {hasSize && (
                        <span className="shrink-0 text-badge tabular-nums text-white/70">
                          {item.width}×{item.height}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        />
      )}
    </div>
  );
}
