import { useMemo } from "react";
import type { LibraryMediaItem } from "../../api/library";
import { useElementSize } from "../../hooks/useElementSize";
import ThumbImage from "../common/ThumbImage";
import VideoCoverImage from "../common/VideoCoverImage";
import { layoutJustified, tileRatio, type WallTile } from "./justifiedLayout";

interface Props<T extends LibraryMediaItem = LibraryMediaItem> {
  /** 要铺的照片。 */
  items: T[];
  /** 目标行高（像素）。 */
  targetHeight: number;
  /** 最多铺几张；多了就截掉。 */
  limit?: number;
  /**
   * 最多铺几行。
   *
   * 首页的照片墙要的是「一屏看得完的一面墙」：给定行数，宽度决定每行
   * 放几张，照片多的库也不会把首页撑长。
   */
  maxRows?: number;
  /** 点照片。 */
  onOpen?: (item: T, index: number) => void;
  /** 照片的出处标签：跨相册的墙用它说明这张出自哪本。 */
  albumLabel?: (item: T) => string | undefined;
  className?: string;
}

const GAP = 8;

/**
 * 静态照片条：把有限的几张照片按真实宽高比铺成几行。
 *
 * 与照片墙的区别是它不滚动：只铺给定的那几张，铺完就结束。
 * 首页的「随手看看」与集合页的预览条要的都是这个 ——
 * 一面看得完的墙，而不是一个可以一直往下翻的列表。
 */
export default function PhotoStrip<T extends LibraryMediaItem = LibraryMediaItem>({
  items,
  targetHeight,
  limit,
  maxRows,
  onOpen,
  albumLabel,
  className = "",
}: Props<T>) {
  const { ref, width } = useElementSize<HTMLDivElement>();

  const shown = useMemo(
    () => (limit === undefined ? items : items.slice(0, limit)),
    [items, limit],
  );
  const tiles = useMemo<WallTile[]>(
    () =>
      shown.map((item) => ({ id: item.id, ratio: tileRatio(item) })),
    [shown],
  );
  const rows = useMemo(() => {
    const laid = layoutJustified(tiles, {
      containerWidth: width,
      targetHeight,
      gap: GAP,
    });
    return maxRows === undefined ? laid : laid.slice(0, maxRows);
  }, [tiles, width, targetHeight, maxRows]);

  return (
    <div ref={ref} className={className}>
      {width > 0 &&
        rows.map((row) => (
          <div
            key={row.key}
            className="flex items-start"
            style={{ gap: GAP, paddingBottom: GAP }}
          >
            {row.tiles.map((tile) => {
              const index = shown.findIndex((item) => item.id === tile.id);
              const item = shown[index];
              if (!item) return null;
              const isVideo = item.kind === "video";
              const source = albumLabel?.(item);
              return (
                <div
                  key={tile.id}
                  className="group relative shrink-0 overflow-hidden rounded-md bg-bg-subtle shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-shadow duration-200 hover:shadow-[0_6px_18px_rgba(0,0,0,0.28)]"
                  style={{ width: tile.width, height: row.tileHeight }}
                >
                  {isVideo ? (
                    <VideoCoverImage
                      videoPath={item.id}
                      version={item.version}
                      displayWidth={tile.width}
                      alt={item.name}
                      loading="lazy"
                    />
                  ) : (
                    <ThumbImage
                      fileId={item.id}
                      alt={item.name}
                      loading="lazy"
                      version={item.version}
                      displayWidth={tile.width}
                      undecodable={item.undecodable}
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => onOpen?.(item, index)}
                    className="absolute inset-0 z-0 block h-full w-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                    title={source ? `${source} · ${item.name}` : item.name}
                    aria-label={
                      isVideo ? `播放 ${item.name}` : `查看 ${item.name}`
                    }
                  />
                  {/* 出处标签：跨相册的照片带上，用户先要知道自己看的是
                      哪一本里的哪一张。背板用共享的 .scrim-bottom，
                      文字所在的整段保持足够黑，白字才站得住。 */}
                  {source && (
                    <span className="pointer-events-none absolute inset-x-0 bottom-0 z-0 flex items-end px-2.5 pb-1.5 pt-8 scrim-bottom opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                      <span className="truncate text-meta text-white">
                        {source}
                      </span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
    </div>
  );
}
