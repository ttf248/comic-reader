import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { previewUrl } from "../../api/images";
import type { LibraryMediaItem } from "../../api/library";
import { isFullscreen, toggleFullscreen } from "../../utils/fullscreen";
import { shouldIgnoreShortcut } from "../../utils/shortcuts";
import VideoPlayer from "../gallery/VideoPlayer";
import ImageInfoPanel from "../gallery/ImageInfoPanel";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  FullscreenIcon,
  InfoIcon,
  MinusIcon,
  PlusIcon,
  StarIcon,
} from "../common/Icon";

interface Props {
  /** 照片墙上的媒体序列（图片与视频混合）。 */
  items: LibraryMediaItem[];
  /** 当前查看的序号（0 基）。 */
  index: number;
  /** 相册名，用于标题与信息。 */
  albumName: string;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  onSetCover?: () => void;
  hasCustomCover?: boolean;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const ZOOM_STEP = 1.25;

/**
 * 照片模式的沉浸式大图预览。
 *
 * 与漫画阅读器刻意分开：这里没有页码概念、没有双页、没有 RTL，
 * 只有「看这一张 → 下一张 → 上一张」。缩放、拖动、全屏与键盘操作
 * 在看图场景里是基本动作，而不是阅读器的附属功能。
 */
export default function PhotoViewer({
  items,
  index,
  albumName,
  onIndexChange,
  onClose,
  isFavorite,
  onToggleFavorite,
  onSetCover,
  hasCustomCover,
}: Props) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [showInfo, setShowInfo] = useState(false);
  const [failed, setFailed] = useState(false);

  const imageRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const fittedRef = useRef({ width: 0, height: 0 });
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const swipeRef = useRef<{ x: number; y: number } | null>(null);

  const current = items[index];
  const isVideo = current?.kind === "video";

  const previewWidth = useMemo(() => {
    if (typeof window === "undefined") return 1600;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return Math.round(window.innerWidth * dpr);
  }, []);

  const clampPan = useCallback(
    (next: { x: number; y: number }, scale: number) => {
      const fitted = fittedRef.current;
      const maxX = Math.max(0, (fitted.width * (scale - 1)) / 2);
      const maxY = Math.max(0, (fitted.height * (scale - 1)) / 2);
      return {
        x: Math.max(-maxX, Math.min(maxX, next.x)),
        y: Math.max(-maxY, Math.min(maxY, next.y)),
      };
    },
    [],
  );

  const measureFitted = useCallback(() => {
    const element = imageRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const scale = zoom > 0 ? zoom : 1;
    fittedRef.current = {
      width: rect.width / scale,
      height: rect.height / scale,
    };
  }, [zoom]);

  const applyZoom = useCallback(
    (next: number) => {
      const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
      setZoom(scale);
      setPan((current) => clampPan(current, scale));
    },
    [clampPan],
  );

  const go = useCallback(
    (delta: number) => {
      if (items.length === 0) return;
      const next = Math.max(0, Math.min(items.length - 1, index + delta));
      if (next === index) return;
      onIndexChange(next);
    },
    [index, items.length, onIndexChange],
  );

  // 切换照片时复位缩放与位移：新图不应该带着上一张的放大状态出现。
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setFailed(false);
  }, [current?.id]);

  useEffect(() => {
    const onResize = () => measureFitted();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measureFitted]);

  // 滚轮缩放：覆盖层吃掉了页面滚动，普通滚轮直接用来缩放更符合看图习惯。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      setZoom((current) => {
        const scale = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, current * factor),
        );
        setPan((panNow) => clampPan(panNow, scale));
        return scale;
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [clampPan]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (shouldIgnoreShortcut(event)) return;
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          onClose();
          break;
        case "ArrowLeft":
          event.preventDefault();
          go(-1);
          break;
        case "ArrowRight":
          event.preventDefault();
          go(1);
          break;
        case "Home":
          event.preventDefault();
          onIndexChange(0);
          break;
        case "End":
          event.preventDefault();
          onIndexChange(items.length - 1);
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
          setPan({ x: 0, y: 0 });
          break;
        case "f":
        case "F":
          event.preventDefault();
          toggleFullscreen();
          break;
        case "i":
        case "I":
          event.preventDefault();
          setShowInfo((value) => !value);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyZoom, go, items.length, onClose, onIndexChange, zoom]);

  if (!current) return null;

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    swipeRef.current = { x: event.clientX, y: event.clientY };
    if (zoom > 1) {
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: pan.x,
        originY: pan.y,
        moved: false,
      };
      (event.target as Element).setPointerCapture?.(event.pointerId);
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    setPan(clampPan({ x: drag.originX + dx, y: drag.originY + dy }, zoom));
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.moved) {
      swipeRef.current = null;
      return;
    }
    const swipe = swipeRef.current;
    swipeRef.current = null;
    if (!swipe) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    // 触摸左右滑动切换照片；纵向滑动留给页面，不做处理。
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      go(dx < 0 ? 1 : -1);
    }
  };

  const onDoubleClick = () => {
    if (zoom > 1) {
      applyZoom(1);
      setPan({ x: 0, y: 0 });
    } else {
      applyZoom(2);
    }
  };

  return (
    <div
      data-testid="photo-viewer"
      className="fixed inset-0 z-50 flex flex-col bg-neutral-950/96 text-white"
      role="dialog"
      aria-modal="true"
      aria-label={`${albumName} 大图预览`}
    >
      {/* 顶栏：返回、标题、位置与操作 */}
      <header className="flex h-14 shrink-0 items-center gap-3 px-3 sm:px-5">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          title="关闭 (Esc)"
          aria-label="关闭大图预览"
        >
          <CloseIcon size={16} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium text-white/90">
            {albumName}
          </div>
          <div className="text-[12px] tabular-nums text-white/55">
            {index + 1} / {items.length}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {onToggleFavorite && (
            <button
              type="button"
              onClick={onToggleFavorite}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              title={isFavorite ? "取消收藏" : "收藏"}
              aria-label={isFavorite ? "取消收藏" : "收藏"}
            >
              <StarIcon size={15} filled={isFavorite} />
            </button>
          )}
          {onSetCover && (
            <button
              type="button"
              onClick={onSetCover}
              className="hidden h-9 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 sm:inline-flex"
              title={hasCustomCover ? "更换封面" : "设为封面"}
            >
              设为封面
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowInfo((value) => !value)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            title="图片信息 (I)"
            aria-label="图片信息"
          >
            <InfoIcon size={15} />
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            title={isFullscreen() ? "退出全屏 (F)" : "全屏 (F)"}
            aria-label="全屏"
          >
            <FullscreenIcon size={15} />
          </button>
        </div>
      </header>

      {/* 画布 */}
      <div className="relative flex min-h-0 flex-1">
        <div
          ref={stageRef}
          className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
        >
          {isVideo ? (
            <div className="h-full w-full p-4">
              <VideoPlayer src={current.id} className="h-full w-full" />
            </div>
          ) : failed ? (
            <div className="px-6 text-center text-[13px] text-white/60">
              这张图片无法显示
            </div>
          ) : (
            <img
              ref={imageRef}
              src={previewUrl(current.id, previewWidth)}
              alt={current.name}
              onLoad={measureFitted}
              onError={() => setFailed(true)}
              draggable={false}
              className="max-h-full max-w-full select-none object-contain"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                cursor: zoom > 1 ? "grab" : "default",
              }}
            />
          )}
        </div>

        {showInfo && !isVideo && (
          <ImageInfoPanel
            absPath={current.id}
            onClose={() => setShowInfo(false)}
          />
        )}
      </div>

      {/* 底栏：上一张 / 下一张与缩放 */}
      <footer className="flex h-14 shrink-0 items-center justify-center gap-2 px-3 sm:px-5">
        <button
          type="button"
          onClick={() => go(-1)}
          disabled={index <= 0}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-white/85 transition-colors hover:bg-white/10 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          title="上一张 (←)"
          aria-label="上一张"
        >
          <ChevronLeftIcon size={16} />
        </button>
        <button
          type="button"
          onClick={() => go(1)}
          disabled={index >= items.length - 1}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-white/85 transition-colors hover:bg-white/10 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          title="下一张 (→)"
          aria-label="下一张"
        >
          <ChevronRightIcon size={16} />
        </button>
        {!isVideo && (
          <div className="ml-2 flex items-center gap-1">
            <button
              type="button"
              onClick={() => applyZoom(zoom / ZOOM_STEP)}
              disabled={zoom <= MIN_ZOOM}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-white/85 transition-colors hover:bg-white/10 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              title="缩小 (-)"
              aria-label="缩小"
            >
              <MinusIcon size={15} />
            </button>
            <span className="w-12 text-center text-[12px] tabular-nums text-white/70">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => applyZoom(zoom * ZOOM_STEP)}
              disabled={zoom >= MAX_ZOOM}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-white/85 transition-colors hover:bg-white/10 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              title="放大 (+)"
              aria-label="放大"
            >
              <PlusIcon size={15} />
            </button>
          </div>
        )}
      </footer>
    </div>
  );
}
