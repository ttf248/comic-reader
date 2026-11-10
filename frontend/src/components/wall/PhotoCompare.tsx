import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { previewUrl } from "../../api/images";
import { devicePixelRatio, pickRenditionWidth } from "../../utils/rendition";
import { shouldIgnoreShortcut } from "../../utils/shortcuts";
import {
  ArrowsIcon,
  CloseIcon,
  FitIcon,
  MinusIcon,
  PickIcon,
  PlusIcon,
} from "../common/Icon";

export interface CompareItem {
  id: string;
  name: string;
  version?: string;
  width?: number;
  height?: number;
  albumName?: string;
}

interface Props {
  left: CompareItem;
  right: CompareItem;
  /** 左边这张是否在精选里。 */
  leftPicked?: boolean;
  rightPicked?: boolean;
  onClose: () => void;
  /** 交换左右。 */
  onSwap: () => void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.5;

/**
 * 两张照片并排对比。
 *
 * 挑照片时真正难的是「这两张哪个更好」：构图、细节、清晰度都要
 * 放在一起看。单张预览一次只能看一张，来回切换会把上一张的印象冲掉。
 *
 * 两侧共用一个缩放倍数：要比的是同一档放大下的细节，两边各自缩放
 * 就失去了可比性。拖动也一起动 —— 同步平移才能对齐同一处细节。
 */
export default function PhotoCompare({
  left,
  right,
  leftPicked,
  rightPicked,
  onClose,
  onSwap,
}: Props) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  // 换了一对照片就回到初始状态：上一组的放大与位移不该带过来。
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [left.id, right.id]);

  const applyZoom = useCallback((next: number) => {
    const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
    setZoom(scale);
    if (scale <= MIN_ZOOM) setPan({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (shouldIgnoreShortcut(event)) return;
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          onClose();
          break;
        case "+":
        case "=":
          event.preventDefault();
          applyZoom(zoom * ZOOM_STEP);
          break;
        case "-":
          event.preventDefault();
          applyZoom(zoom / ZOOM_STEP);
          break;
        case "0":
          event.preventDefault();
          applyZoom(1);
          break;
        case "x":
        case "X":
          event.preventDefault();
          onSwap();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyZoom, onClose, onSwap, zoom]);

  return (
    <div
      data-testid="photo-compare"
      className="fixed inset-0 z-50 flex flex-col bg-overlay-bg text-overlay-fg"
      role="dialog"
      aria-modal="true"
      aria-label="两张照片并排对比"
    >
      <header className="relative flex h-14 shrink-0 items-center gap-3 px-3 sm:px-5">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          title="关闭 (Esc)"
          aria-label="关闭对比"
        >
          <CloseIcon size={16} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-label font-semibold text-white/95">
            并排对比
          </div>
          <div className="text-meta text-white/55">两侧同一档放大，细节可比</div>
        </div>
        <button
          type="button"
          onClick={onSwap}
          className="inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-meta text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          title="交换左右 (X)"
        >
          <ArrowsIcon size={14} />
          <span className="hidden sm:inline">交换</span>
        </button>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col gap-px sm:flex-row">
        <ComparePane
          item={left}
          picked={leftPicked}
          zoom={zoom}
          pan={pan}
          onPan={setPan}
        />
        <ComparePane
          item={right}
          picked={rightPicked}
          zoom={zoom}
          pan={pan}
          onPan={setPan}
        />
      </div>

      <footer className="relative flex h-14 shrink-0 items-center justify-center px-3 sm:px-5">
        <div className="inline-flex items-center gap-1 rounded-full bg-white/10 p-1 backdrop-blur-sm ring-1 ring-white/10">
          <button
            type="button"
            onClick={() => applyZoom(zoom / ZOOM_STEP)}
            disabled={zoom <= MIN_ZOOM}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/15 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            title="缩小 (-)"
            aria-label="缩小"
          >
            <MinusIcon size={15} />
          </button>
          <span className="w-14 text-center text-meta tabular-nums text-white/75">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => applyZoom(zoom * ZOOM_STEP)}
            disabled={zoom >= MAX_ZOOM}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/15 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            title="放大 (+)"
            aria-label="放大"
          >
            <PlusIcon size={15} />
          </button>
          <button
            type="button"
            onClick={() => applyZoom(1)}
            disabled={zoom === MIN_ZOOM}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/15 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            title="适应窗口 (0)"
            aria-label="适应窗口"
          >
            <FitIcon size={15} />
          </button>
        </div>
      </footer>
    </div>
  );
}

/**
 * 对比里的一侧。
 *
 * 图片按「适应」渲染，放大倍数再乘上去。适应比例由格子尺寸与图片
 * 原始像素算出，因此两侧算的是同一把尺子。
 */
function ComparePane({
  item,
  picked,
  zoom,
  pan,
  onPan,
}: {
  item: CompareItem;
  picked?: boolean;
  zoom: number;
  pan: { x: number; y: number };
  onPan: (next: { x: number; y: number }) => void;
}) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [paneSize, setPaneSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [natural, setNatural] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const measure = () => {
      const rect = pane.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      setPaneSize((prev) =>
        prev && prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);

  const source = useMemo(() => {
    const width = natural?.width ?? item.width ?? 0;
    const height = natural?.height ?? item.height ?? 0;
    return { width, height };
  }, [natural, item.width, item.height]);

  // 适应比例：图片按原比例塞进格子。放大倍数乘在它上面。
  const fit = useMemo(() => {
    if (!paneSize || !source.width || !source.height) return null;
    const scale = Math.min(
      paneSize.width / source.width,
      paneSize.height / source.height,
      1,
    );
    return {
      scale,
      width: source.width * scale * zoom,
      height: source.height * scale * zoom,
    };
  }, [paneSize, source, zoom]);

  const src = useMemo(() => {
    if (!fit) return "";
    return previewUrl(
      item.id,
      pickRenditionWidth(fit.width * devicePixelRatio()),
      item.version,
    );
  }, [fit, item.id, item.version]);

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0 || zoom <= 1) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
    };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    onPan({
      x: drag.originX + (event.clientX - drag.startX),
      y: drag.originY + (event.clientY - drag.startY),
    });
  };

  const onPointerUp = (event: React.PointerEvent) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-black/40">
      <div
        ref={paneRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {failed ? (
          <div className="px-6 text-center text-body text-white/60">
            这张图片无法显示
          </div>
        ) : fit ? (
          <img
            src={src}
            alt={item.name}
            draggable={false}
            onLoad={(event) => {
              const img = event.currentTarget;
              if (!natural && img.naturalWidth > 0) {
                setNatural({
                  width: img.naturalWidth,
                  height: img.naturalHeight,
                });
              }
            }}
            onError={() => setFailed(true)}
            className="max-w-full select-none object-contain shadow-[0_20px_60px_-20px_rgba(0,0,0,0.9)]"
            style={{
              width: fit.width,
              height: fit.height,
              transform: `translate(${pan.x}px, ${pan.y}px)`,
              cursor: zoom > 1 ? "grab" : "default",
            }}
          />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-white/10 px-3 py-2">
        <span className="truncate text-meta text-white/85" title={item.name}>
          {item.name}
        </span>
        {source.width > 0 && (
          <span className="shrink-0 text-badge tabular-nums text-white/50">
            {source.width}×{source.height}
          </span>
        )}
        {item.albumName && (
          <span className="hidden shrink-0 truncate text-badge text-white/45 sm:inline">
            {item.albumName}
          </span>
        )}
        {picked && (
          <span
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-badge text-white/90"
            title="这张照片在精选里"
          >
            <PickIcon size={11} />
            <span>精选</span>
          </span>
        )}
      </div>
    </div>
  );
}
