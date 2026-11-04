import { useEffect, useMemo } from "react";
import { Virtuoso } from "react-virtuoso";
import { thumbUrl } from "../../api/thumbs";
import { CloseIcon } from "../common/Icon";
import { useMediaQuery } from "../../hooks/useMediaQuery";

interface Props {
  /** 相册内的图片文件 ID（顺序与页码一致）。 */
  images: string[];
  /** 当前页（0 基）。 */
  index: number;
  /** 跳到指定页。 */
  onJump: (index: number) => void;
  onClose: () => void;
}

const COLUMNS = {
  narrow: 3,
  medium: 5,
  wide: 7,
  huge: 9,
};

/**
 * 漫画目录：整本缩略图网格，点一下直接跳到那一页。
 *
 * 长篇漫画动辄几百页，底部进度条只能拖着刮擦，找不到具体某一页；
 * 目录提供「按页定位」的入口。它是按需打开的浮层，不打断连续阅读。
 */
export default function PageOverview({
  images,
  index,
  onJump,
  onClose,
}: Props) {
  const small = useMediaQuery("(min-width: 640px)");
  const medium = useMediaQuery("(min-width: 1024px)");
  const wide = useMediaQuery("(min-width: 1440px)");
  const columns = wide
    ? COLUMNS.huge
    : small
      ? COLUMNS.wide
      : medium
        ? COLUMNS.medium
        : COLUMNS.narrow;

  const rows = useMemo(() => {
    const list: { key: string; items: { id: string; index: number }[] }[] = [];
    for (let start = 0; start < images.length; start += columns) {
      const items = images.slice(start, start + columns).map((id, offset) => ({
        id,
        index: start + offset,
      }));
      list.push({ key: `overview-${start}`, items });
    }
    return list;
  }, [images, columns]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      data-testid="page-overview"
      className="fixed inset-0 z-50 flex flex-col bg-neutral-950/97 text-white"
      role="dialog"
      aria-modal="true"
      aria-label="目录"
    >
      <header className="flex h-12 shrink-0 items-center gap-3 px-4">
        <h2 className="text-[13.5px] font-medium text-white/90">目录</h2>
        <span className="text-[12px] tabular-nums text-white/55">
          共 {images.length} 页
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md text-white/75 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          title="关闭目录 (T / Esc)"
          aria-label="关闭目录"
        >
          <CloseIcon size={15} />
        </button>
      </header>

      <div className="min-h-0 flex-1 px-4 pb-4">
        <Virtuoso
          data={rows}
          style={{ height: "100%" }}
          overscan={400}
          increaseViewportBy={{ top: 400, bottom: 400 }}
          computeItemKey={(_index, row) => row.key}
          itemContent={(_index, row) => (
            <div
              className="grid gap-2 pb-2"
              style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            >
              {row.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onJump(item.index)}
                  className={`group relative aspect-[3/4] overflow-hidden rounded border bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 ${
                    item.index === index
                      ? "border-white/80"
                      : "border-white/10 hover:border-white/40"
                  }`}
                  title={`第 ${item.index + 1} 页`}
                  aria-label={`跳到第 ${item.index + 1} 页`}
                  aria-current={item.index === index ? "true" : undefined}
                >
                  <img
                    src={thumbUrl(item.id)}
                    alt={`第 ${item.index + 1} 页`}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover"
                  />
                  <span className="absolute bottom-1 right-1 rounded bg-black/65 px-1.5 py-0.5 text-[11px] tabular-nums text-white/90">
                    {item.index + 1}
                  </span>
                </button>
              ))}
            </div>
          )}
        />
      </div>
    </div>
  );
}
