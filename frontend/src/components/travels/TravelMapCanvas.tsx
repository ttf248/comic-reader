import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from "react";
import type { ChinaLocationGeometry, ChinaPointCell } from "../../api/aiJobs";
import {
  boundsOfPhotos,
  createMapProjection,
  fitViewport,
  levelOpacity,
  panViewportBy,
  photoViewport,
  pointRadius,
  regionPath,
  shareOf,
  viewportZoom,
  zoomViewportAt,
  type MapRegion,
  type MapViewport,
} from "../../utils/travelMap";

interface TravelMapCanvasProps {
  /** 画出来的地方：有照片的那些，带各自的轮廓。 */
  regions: MapRegion[];
  /** 参照层：全国省界，只作方位参照。 */
  backdrop?: MapRegion[];
  /** 点位：照片位置的网格聚合。 */
  points?: ChinaPointCell[];
  /** 高亮的区划码（选中的那几段行程走过的地方）。 */
  highlightedAdcodes?: number[];
  /** 高亮的一段日期区间；与它相交的网格点会被描出来。 */
  highlightedRange?: { from: string; to: string } | null;
  /** 本层的照片总数，作为色阶的分母。 */
  levelTotal: number;
  /** 这一层的说法，写在无障碍名称与图例里。 */
  scopeLabel: string;
  /** 点选一个地方。 */
  onSelect?: (region: MapRegion) => void;
  /** 缩放倍数变化。地图放得越大，照片位置越要细。 */
  onZoomChange?: (zoom: number) => void;
}

/**
 * 足迹地图：一片点云浮在离线行政边界上。
 *
 * 底图只说明「在哪个市」，点云才说明「具体在哪儿」—— 一座城市的形状
 * 从照片的位置里自己长出来。因此地图的密度来自用户自己的照片，不是
 * 行政区着色。
 *
 * 地图可以拖动与缩放：行政区匹配只到市一级，推到市里面去看的正是那些
 * 照片的位置。
 */
export default function TravelMapCanvas({
  regions,
  backdrop,
  points,
  highlightedAdcodes,
  highlightedRange,
  levelTotal,
  scopeLabel,
  onSelect,
  onZoomChange,
}: TravelMapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [tooltip, setTooltip] = useState<{ region: MapRegion; x: number; y: number } | null>(null);
  const [cropToPhotos, setCropToPhotos] = useState(true);
  const [viewport, setViewport] = useState<MapViewport | null>(null);
  const [aspect, setAspect] = useState<number | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: MapViewport;
    moved: boolean;
  } | null>(null);

  // 画布的高宽比。viewBox 与画布同形，图才铺满整块，而不是缩在中间。
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width > 0 && height > 0) setAspect(height / width);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 区域按照片数排序：焦点移动的顺序与视觉重要性一致。
  const ordered = useMemo(
    () =>
      [...regions].sort((left, right) => {
        if (left.photoCount !== right.photoCount) {
          return right.photoCount - left.photoCount;
        }
        return left.name.localeCompare(right.name, "zh-CN");
      }),
    [regions],
  );

  const projection = useMemo(
    () => createMapProjection([...(backdrop ?? []), ...ordered]),
    [backdrop, ordered],
  );

  const photoBounds = useMemo(() => boundsOfPhotos(ordered), [ordered]);

  // 视口没被拖动过时，跟着「有照片的地方 / 全国范围」走。
  const defaultViewport = useMemo(
    () =>
      cropToPhotos && photoBounds
        ? photoViewport(projection, photoBounds, aspect ?? undefined)
        : fitViewport(projection, aspect ?? undefined),
    [aspect, cropToPhotos, photoBounds, projection],
  );

  const activeViewport = viewport ?? defaultViewport;
  const zoom = viewportZoom(projection, activeViewport);

  // 缩放变了要告诉外面：地图放得越大，照片位置就要越细（网格越小）。
  useEffect(() => {
    onZoomChange?.(zoom);
  }, [onZoomChange, zoom]);

  // 换了层级或换了地方集合，视口回到默认位置：旧的视口可能落在新图之外。
  // 依赖用区划码的串而不是投影对象 —— 投影每次渲染都是新对象。
  const regionKey = useMemo(
    () => ordered.map((region) => region.adcode).join(","),
    [ordered],
  );
  useEffect(() => {
    setViewport(null);
  }, [regionKey]);

  const paths = useMemo(
    () =>
      ordered
        .filter((region) => region.geometry !== null)
        .map((region) => ({
          region,
          path: regionPath(
            region.geometry as ChinaLocationGeometry,
            projection.project,
          ),
        })),
    [ordered, projection],
  );

  const backdropPaths = useMemo(
    () =>
      (backdrop ?? [])
        .filter((region) => region.geometry !== null)
        .map((region) => ({
          region,
          path: regionPath(
            region.geometry as ChinaLocationGeometry,
            projection.project,
          ),
        })),
    [backdrop, projection],
  );

  const maxPointCount = useMemo(
    () => points?.reduce((max, cell) => Math.max(max, cell.count), 0) ?? 0,
    [points],
  );

  const highlighted = useMemo(
    () => new Set(highlightedAdcodes ?? []),
    [highlightedAdcodes],
  );

  const showTooltip = useCallback(
    (region: MapRegion, event: ReactMouseEvent<SVGElement>) => {
      const container = containerRef.current;
      if (!container) return;
      const bounds = container.getBoundingClientRect();
      setTooltip({
        region,
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
    },
    [],
  );

  const moveFocus = useCallback(
    (next: number) => {
      if (ordered.length === 0) return;
      const index = (next + ordered.length) % ordered.length;
      setFocusIndex(index);
      const target = containerRef.current?.querySelector<SVGGElement>(
        `[data-region-index="${index}"]`,
      );
      target?.focus();
    },
    [ordered.length],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<SVGGElement>, region: MapRegion) => {
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          event.preventDefault();
          moveFocus(focusIndex + 1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
          event.preventDefault();
          if (event.shiftKey) {
            setViewport((current) =>
              panViewportBy(
                projection,
                current ?? defaultViewport,
                event.key === "ArrowLeft" ? -0.2 : 0.2,
                0,
                aspect ?? undefined,
              ),
            );
            return;
          }
          moveFocus(focusIndex - 1);
          break;
        case "Home":
          event.preventDefault();
          moveFocus(0);
          break;
        case "End":
          event.preventDefault();
          moveFocus(ordered.length - 1);
          break;
        case "Enter":
        case " ":
          event.preventDefault();
          onSelect?.(region);
          break;
        case "+":
        case "=":
          event.preventDefault();
          setViewport((current) =>
            zoomViewportAt(projection, current ?? defaultViewport, 1.6, 0.5, 0.5, aspect ?? undefined),
          );
          break;
        case "-":
        case "_":
          event.preventDefault();
          setViewport((current) =>
            zoomViewportAt(projection, current ?? defaultViewport, 1 / 1.6, 0.5, 0.5, aspect ?? undefined),
          );
          break;
        case "0":
          event.preventDefault();
          setViewport(null);
          break;
        default:
          break;
      }
    },
    [
      aspect,
      defaultViewport,
      focusIndex,
      moveFocus,
      onSelect,
      ordered.length,
      projection,
    ],
  );

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      // 普通滚轮只在地图拿到焦点时才缩放：否则地图会吞掉整页的滚动。
      // 按住 Ctrl 的滚轮始终缩放。
      const focused = containerRef.current?.contains(document.activeElement);
      if (!focused && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const bounds = container.getBoundingClientRect();
      const anchorX = (event.clientX - bounds.left) / Math.max(bounds.width, 1);
      const anchorY = (event.clientY - bounds.top) / Math.max(bounds.height, 1);
      const factor = event.deltaY < 0 ? 1.25 : 1 / 1.25;
      setViewport((current) =>
        zoomViewportAt(
          projection,
          current ?? defaultViewport,
          factor,
          anchorX,
          anchorY,
          aspect ?? undefined,
        ),
      );
    },
    [aspect, defaultViewport, projection],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origin: activeViewport,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [activeViewport],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      const container = containerRef.current;
      if (!drag || !container) return;
      const bounds = container.getBoundingClientRect();
      const deltaX = (event.clientX - drag.startX) / Math.max(bounds.width, 1);
      const deltaY = (event.clientY - drag.startY) / Math.max(bounds.height, 1);
      if (!drag.moved && Math.abs(deltaX) < 0.004 && Math.abs(deltaY) < 0.004) {
        return;
      }
      drag.moved = true;
      setViewport(
        panViewportBy(projection, drag.origin, deltaX, deltaY, aspect ?? undefined),
      );
    },
    [aspect, projection],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      setViewport((current) =>
        zoomViewportAt(projection, current ?? defaultViewport, factor, 0.5, 0.5, aspect ?? undefined),
      );
    },
    [aspect, defaultViewport, projection],
  );

  if (ordered.length === 0 && (points?.length ?? 0) === 0) {
    return (
      <div className="travel-map-canvas__empty">
        <p className="text-body font-medium text-fg">还没有带位置的照片</p>
        <p className="mt-1 max-w-sm text-meta leading-relaxed text-fg-muted">
          在任务中心跑一次元数据分析，照片的拍摄地点就会出现在这里。
        </p>
      </div>
    );
  }

  return (
    <div className="travel-map-canvas">
      <div
        ref={(node) => {
          containerRef.current = node;
        }}
        className="travel-map-canvas__stage"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <svg
          role="group"
          aria-label={`${scopeLabel}照片地图，可用方向键在区域间移动，加减号缩放，0 复位`}
          viewBox={projection.viewBoxFor(activeViewport, aspect ?? undefined)}
        >
          {/* 参照层：全国省界，只作方位参照，不填色。 */}
          <g aria-hidden="true">
            {backdropPaths.map(({ region, path }) => (
              <path
                key={`backdrop-${region.adcode}`}
                d={path}
                className="fill-none stroke-border-strong"
                strokeWidth={1}
                strokeLinejoin="round"
                fillRule="evenodd"
              />
            ))}
          </g>
          <g>
            {paths.map(({ region, path }, index) => {
              const hasPhotos = region.photoCount > 0;
              const opacity = hasPhotos
                ? levelOpacity(region.photoCount, levelTotal)
                : 1;
              const share = shareOf(region.photoCount, levelTotal);
              const percent = `${(share * 100).toFixed(share > 0 && share < 0.01 ? 2 : 1)}%`;
              const isHighlighted = highlighted.has(region.adcode);
              return (
                <g
                  key={region.adcode}
                  data-region-index={index}
                  tabIndex={index === focusIndex ? 0 : -1}
                  role="button"
                  aria-label={`${region.name}，${region.photoCount.toLocaleString()} 张照片，占本层 ${percent}`}
                  className="group cursor-pointer outline-none"
                  onClick={() => onSelect?.(region)}
                  onMouseEnter={(event) => showTooltip(region, event)}
                  onMouseMove={(event) => showTooltip(region, event)}
                  onMouseLeave={() => setTooltip(null)}
                  onFocus={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const container =
                      containerRef.current?.getBoundingClientRect();
                    if (!container) return;
                    setTooltip({
                      region,
                      x: bounds.left - container.left + bounds.width / 2,
                      y: bounds.top - container.top,
                    });
                  }}
                  onBlur={() => setTooltip(null)}
                  onKeyDown={(event) => handleKeyDown(event, region)}
                >
                  <path
                    d={path}
                    className={
                      hasPhotos
                        ? "fill-brand group-hover:fill-brand-ink group-focus-visible:stroke-brand-ink"
                        : "fill-bg-strong group-focus-visible:stroke-brand-ink"
                    }
                    fillOpacity={opacity}
                    stroke={
                      isHighlighted
                        ? "brand-ink"
                        : region.photoCount === 0
                          ? "transparent"
                          : "brand"
                    }
                    strokeWidth={isHighlighted ? 2.4 : 1.2}
                    strokeLinejoin="round"
                    fillRule="evenodd"
                  />
                  {/* 透明加粗的命中区：小区域在窄屏上也点得中。 */}
                  <path
                    d={path}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={8}
                    pointerEvents="stroke"
                  />
                  <title>{`${region.name} · ${region.photoCount.toLocaleString()} 张`}</title>
                </g>
              );
            })}
          </g>
          {/* 点云：照片的真实位置。 */}
          <g aria-hidden="true">
            {(points ?? []).map((cell) => {
              const inHighlight =
                highlightedRange !== null &&
                highlightedRange !== undefined &&
                cell.lastAt >= highlightedRange.from &&
                cell.firstAt <= highlightedRange.to;
              return (
                <circle
                  key={`${cell.lon}-${cell.lat}`}
                  cx={projection.project([cell.lon, cell.lat])[0]}
                  cy={projection.project([cell.lon, cell.lat])[1]}
                  r={pointRadius(
                    cell.count,
                    maxPointCount,
                    activeViewport.width,
                    projection.worldWidth,
                  )}
                  className={
                    cell.untimed > 0
                      ? "travel-map-canvas__point fill-brand-ink"
                      : "travel-map-canvas__point fill-brand"
                  }
                  fillOpacity={cell.untimed > 0 ? 0.28 : 0.55}
                  stroke={inHighlight ? "brand-ink" : "none"}
                  strokeWidth={inHighlight ? 1.6 : 0}
                >
                  <title>{`${cell.count} 张 · ${cell.firstAt || "时间未知"} – ${cell.lastAt || "时间未知"}`}</title>
                </circle>
              );
            })}
          </g>
        </svg>
        {tooltip ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border-faint bg-bg-strong px-3 py-2 text-left shadow-lg"
            style={{ left: tooltip.x, top: tooltip.y - 10 }}
          >
            <p className="text-label font-medium text-fg">{tooltip.region.name}</p>
            <p className="mt-0.5 text-meta tabular-nums text-fg-muted">
              {tooltip.region.photoCount.toLocaleString()} 张 · 占本层{" "}
              {(shareOf(tooltip.region.photoCount, levelTotal) * 100).toFixed(1)}%
            </p>
          </div>
        ) : null}
      </div>

      <div className="travel-map-canvas__bar">
        <div className="travel-map-canvas__legend">
          <span className="travel-map-canvas__swatch travel-map-canvas__swatch--unit" />
          <span>去过的地方</span>
          <span className="travel-map-canvas__swatch travel-map-canvas__swatch--point" />
          <span>照片位置</span>
          <span className="travel-map-canvas__swatch travel-map-canvas__swatch--untimed" />
          <span>时间不可信</span>
        </div>
        <div className="travel-map-canvas__controls">
          <span className="text-meta tabular-nums text-fg-muted">
            {zoom >= 1.05 ? `${zoom.toFixed(1)}×` : "全国"}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            onClick={() => zoomBy(1.6)}
            aria-label="放大地图"
          >
            放大
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            onClick={() => zoomBy(1 / 1.6)}
            aria-label="缩小地图"
          >
            缩小
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            aria-pressed={cropToPhotos}
            onClick={() => {
              setCropToPhotos((value) => !value);
              setViewport(null);
            }}
          >
            {cropToPhotos ? "看全国范围" : "缩到有照片的地方"}
          </button>
        </div>
      </div>
    </div>
  );
}
