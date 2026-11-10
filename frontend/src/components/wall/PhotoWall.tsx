import { useMemo, type MouseEvent } from "react";
import { Virtuoso, type ListRange } from "react-virtuoso";
import type { LibraryMediaItem } from "../../api/library";
import { useElementWidth } from "../../hooks/useElementWidth";
import { useMediaGridPagination } from "../../hooks/useMediaGridPagination";
import ThumbImage from "../common/ThumbImage";
import VideoCoverImage from "../common/VideoCoverImage";
import { CheckIcon, PickIcon, PlayFilledIcon, PlusIcon } from "../common/Icon";
import { layoutJustified, tileRatio, type WallTile } from "./justifiedLayout";

interface Props<T extends LibraryMediaItem = LibraryMediaItem> {
  /** 已加载的媒体项，顺序与服务端媒体索引一致。 */
  items: T[];
  /** 图片与视频合计的服务端总数。 */
  total: number;
  /** 目标行高（像素）。 */
  targetHeight: number;
  hasNextPage: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onOpen: (item: T, index: number) => void;
  onContextMenu?: (
    item: T,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
  /** 是否处于多选模式。多选时点击照片改为勾选，不再打开大图。 */
  selecting?: boolean;
  /** 某张照片是否已被勾选。 */
  isSelected?: (id: string) => boolean;
  /** 勾选 / 取消勾选一张照片。 */
  onToggleSelect?: (item: T) => void;
  /** 某张照片是否在精选里。 */
  isPicked?: (id: string) => boolean;
  /** 把一张照片加入 / 移出精选。 */
  onTogglePick?: (item: T) => void;
}

const GAP = 10;

/**
 * 窄屏上把目标行高压下来。
 *
 * 桌面宽度下这个上限远大于密度设定值，不生效；手机上却差别很大：
 * 容器只有三百多像素宽，「标准」的行高放得下一张就放不下第二张，
 * 一百多张照片排下来要滚几十屏 —— 手机相册该是一屏两三张。
 * 取容器的三分之一左右，一行正好排下两张常见比例的照片。
 */
export function effectiveTargetHeight(
  targetHeight: number,
  width: number,
): number {
  if (width <= 0) return targetHeight;
  return Math.min(targetHeight, Math.max(96, Math.round(width / 3.2)));
}

/**
 * 照片墙：按每张图真实宽高比排布的自适应网格。
 *
 * 与漫画阅读器彻底分开：这里没有页码、没有双页、没有阅读进度，
 * 只有「平铺浏览 → 点开大图」这一条路径。
 */
export default function PhotoWall<T extends LibraryMediaItem = LibraryMediaItem>({
  items,
  total,
  targetHeight,
  hasNextPage,
  isLoadingMore,
  onLoadMore,
  onOpen,
  onContextMenu,
  selecting = false,
  isSelected,
  onToggleSelect,
  isPicked,
  onTogglePick,
}: Props<T>) {
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
        targetHeight: effectiveTargetHeight(targetHeight, width),
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
                const picked = isPicked?.(item.id) ?? false;
                const selected = isSelected?.(item.id) ?? false;
                return (
                  // 触发层是覆盖在封面之上的独立按钮：视频封面自带「重试」
                  // 按钮，把它包进 <button> 会产生嵌套按钮（无效 HTML，
                  // 键盘与读屏都会失灵）。
                  <div
                    key={tile.id}
                    /* 墙上挂的是一张张照片：它们之间留一道缝、角上带一点
                       圆，彼此分开而不是糊成一张大图。 */
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
                      onClick={() => {
                        // 多选模式下点击是勾选，不是打开：那一轮用户在做
                        // 「挑出几张」，不是在「看这一张」。
                        if (selecting && onToggleSelect) onToggleSelect(item);
                        else onOpen(item, index);
                      }}
                      onContextMenu={(event) => onContextMenu?.(item, event)}
                      className="absolute inset-0 z-0 block h-full w-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                      title={item.name}
                      aria-label={
                        isVideo ? `播放 ${item.name}` : `查看 ${item.name}`
                      }
                    />
                    {/* 视频角标：光靠一枚 10px 的三角不够 —— 形状与颜色都
                        说不清这是什么，带上「视频」两个字才不依赖颜色辨认。
                        角标带汉字，因此用 --text-meta 而不是 --text-badge：
                        徽章字号是拉丁字母与数字的下限，中文压不住。 */}
                    {isVideo && (
                      <span className="pointer-events-none absolute right-1.5 top-1.5 z-0 inline-flex items-center gap-1 rounded-md bg-black/65 px-1.5 py-0.5 text-meta font-medium text-white/90 backdrop-blur">
                        <PlayFilledIcon size={10} />
                        <span>视频</span>
                      </span>
                    )}
                    {/* 精选角标：黑底白勾，与相册级收藏的琥珀色星标
                        形状与颜色都不同 —— 一个说「这张要留」，一个说
                        「这本要留」，两件事不该看着像一件。

                        未精选时不常驻：满墙都是圆点会把照片本身挤掉，
                        悬停才浮出来加号。已精选的则一直挂着。

                        按钮本身有 28px 见方，视觉上的圆点仍是 20px：
                        角标再小也得够得着，触摸设备上 20px 的目标
                        几乎点不中。 */}
                    {onTogglePick && !selecting && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onTogglePick(item);
                        }}
                        aria-pressed={picked}
                        aria-label={picked ? `把 ${item.name} 移出精选` : `把 ${item.name} 加入精选`}
                        title={picked ? "移出精选" : "加入精选"}
                        className={`absolute left-0 top-0 z-10 grid h-7 w-7 place-items-center rounded-full transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${
                          picked ? "opacity-100" : "wall-pick-reveal"
                        }`}
                      >
                        <span className="grid h-5 w-5 place-items-center rounded-full bg-black/70 text-white ring-1 ring-white/25 backdrop-blur">
                          {picked ? (
                            <PickIcon size={12} />
                          ) : (
                            <PlusIcon size={11} />
                          )}
                        </span>
                      </button>
                    )}
                    {/* 多选时的勾选框占同一个角：那一轮用户在做批量操作，
                        精选角标让位，避免两个圆点叠在一起。

                        形状刻意用方框：精选角标是圆的（那是照片的常驻
                        标记），勾选框是方的（那是这一轮的操作状态）。
                        形状与配色都分开，用户不会把「这张在精选里」和
                        「这张被勾上了」看成同一件事。 */}
                    {selecting && onToggleSelect && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onToggleSelect(item);
                        }}
                        role="checkbox"
                        aria-checked={selected}
                        aria-label={`选择「${item.name}」`}
                        title={selected ? "取消选择" : "选择"}
                        className="absolute left-0 top-0 z-10 grid h-7 w-7 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                      >
                        <span
                          className={`grid h-5 w-5 place-items-center rounded-sm ring-1 transition-colors ${
                            selected
                              ? "bg-brand text-brand-contrast ring-brand"
                              : "bg-black/25 text-white ring-white/60"
                          }`}
                        >
                          {selected && <CheckIcon size={12} />}
                        </span>
                      </button>
                    )}
                    {/* 悬停信息层：文件名与像素尺寸。
                        照片墙是浏览页，光靠缩略图看不出「这是什么」；
                        尺寸来自服务端已带的 width / height，不用另发请求。

                        背板用共享的 .scrim-bottom：文字所在的整段保持
                        88% 黑，往上才淡出。原先那层 from-black/85 的渐变
                        在明亮封面上只压到约 52%，白字对比度掉到 4.3:1
                        （AA 要 4.5:1）—— 亮度不可控的封面必须按最坏情况算。 */}
                    <div
                      data-testid="wall-tile-info"
                      className="pointer-events-none absolute inset-x-0 bottom-0 z-0 flex items-end justify-between gap-2 px-2.5 pb-2 pt-9 scrim-bottom opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                    >
                      <span className="truncate text-meta text-white">
                        {item.name}
                      </span>
                      {hasSize && (
                        <span className="shrink-0 text-badge tabular-nums text-white/80">
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
