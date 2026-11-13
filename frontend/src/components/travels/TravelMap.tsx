import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { ChinaLocationGeometry } from "../../api/aiJobs";
import {
  boundsOfPhotos,
  createMapProjection,
  fitViewport,
  levelOpacity,
  photoViewport,
  regionPath,
  shareOf,
  type MapRegion,
} from "../../utils/travelMap";

interface TravelMapProps {
  /** 参与绘制的这一层区域。 */
  regions: MapRegion[];
  /** 本层照片总数，作为色阶与占比的分母。 */
  levelTotal: number;
  /** 这一层的说法，写在无障碍名称与图例里。 */
  scopeLabel: string;
  /** 图例文案；缺省写「基准：<scopeLabel> · N 张」，null 表示不写图例。 */
  legend?: string | null;
  /** 是否提供「缩到有照片的地方 / 看全国范围」的切换。 */
  cropToggle?: boolean;
  /**
   * 是否裁到有照片的那一片。
   *
   * 位置图不裁：它要说明「在哪儿」，裁到只剩一个区反而失去上下文。
   */
  crop?: boolean;
  /** 点选区域。 */
  onSelect?: (region: MapRegion) => void;
  /** Esc：回到上一层。 */
  onLevelUp?: () => void;
}

interface TooltipState {
  region: MapRegion;
  x: number;
  y: number;
}

/**
 * 把提示框留在容器里。
 *
 * 提示框以指针为中心，贴着容器边缘时会有一半跑到卡片外面。
 */
function clampTooltipX(x: number, containerWidth: number): number {
  const margin = 76;
  if (containerWidth <= margin * 2) return Math.max(x, margin);
  return Math.min(Math.max(x, margin), containerWidth - margin);
}

/**
 * 行政区地图：把一段行程去过的地方画出来。
 *
 * 它是一件按需出现的上下文面板里的配图，因此默认裁到有照片的那一片 ——
 * 一张库里往往只有几个地方有照片，整张中国地图里大半是空的。没有照片的
 * 区域画成中性底色而不是透明：透明会让它从图上消失，看起来像缺了一块。
 *
 * 地图本身只是形状，键盘与读屏用户靠旁边的清单进入 —— 所以这里只保证
 * 形状可点、可聚焦，信息不靠颜色单独承载。
 */
export default function TravelMap({
  regions,
  levelTotal,
  scopeLabel,
  legend,
  cropToggle = true,
  crop = true,
  onSelect,
  onLevelUp,
}: TravelMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [cropToPhotos, setCropToPhotos] = useState(true);

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

  const photoBounds = useMemo(() => boundsOfPhotos(ordered), [ordered]);
  const projection = useMemo(() => createMapProjection(ordered), [ordered]);
  const viewport = useMemo(
    () =>
      crop && cropToPhotos
        ? photoViewport(projection, photoBounds)
        : fitViewport(projection),
    [crop, cropToPhotos, photoBounds, projection],
  );

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

  const showTooltip = useCallback(
    (region: MapRegion, event: MouseEvent<SVGElement>) => {
      const container = containerRef.current;
      if (!container) return;
      const bounds = container.getBoundingClientRect();
      setTooltip({
        region,
        x: clampTooltipX(event.clientX - bounds.left, bounds.width),
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
        case "Escape":
          event.preventDefault();
          event.stopPropagation();
          onLevelUp?.();
          break;
        default:
          break;
      }
    },
    [focusIndex, moveFocus, onLevelUp, onSelect, ordered.length],
  );

  if (regions.length === 0) {
    return (
      <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-body font-medium text-fg">这一层没有更细的边界</p>
        <p className="max-w-sm text-meta leading-relaxed text-fg-muted">
          这个区域的照片仍然计入上级统计，可以回到上一级继续查看。
        </p>
      </div>
    );
  }

  return (
    <div>
      {cropToggle ? (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-meta text-fg-muted">
            {cropToPhotos ? "已缩放到有照片的区域" : "全国范围"}
          </p>
          <button
            type="button"
            aria-pressed={cropToPhotos}
            onClick={() => setCropToPhotos((value) => !value)}
            className="btn btn-sm btn-outline"
          >
            {cropToPhotos ? "看全国范围" : "缩到有照片的地方"}
          </button>
        </div>
      ) : null}
      <div
        ref={(node) => {
          containerRef.current = node;
        }}
        className="travel-map"
      >
        <svg
          role="group"
          aria-label={`${scopeLabel}照片地图，可用方向键在区域间移动，回车打开该地区`}
          viewBox={projection.viewBoxFor(viewport)}
        >
          <g>
            {paths.map(({ region, path }, index) => {
              const hasPhotos = region.photoCount > 0;
              // 没有照片的区域画成中性底色，而不是透明 ——
              // 透明会让它从图上消失，看起来像缺了一块。
              const opacity = hasPhotos
                ? levelOpacity(region.photoCount, levelTotal)
                : 1;
              const share = shareOf(region.photoCount, levelTotal);
              const percent = `${(share * 100).toFixed(share > 0 && share < 0.01 ? 2 : 1)}%`;
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
                      x: clampTooltipX(
                        bounds.left - container.left + bounds.width / 2,
                        container.width,
                      ),
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
                    stroke={region.photoCount === 0 ? "transparent" : "brand"}
                    strokeWidth={1.2}
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
        </svg>
        {tooltip ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border-faint bg-bg-strong px-3 py-2 text-left shadow-lg"
            style={{
              left: tooltip.x,
              top: tooltip.y - 10,
            }}
          >
            <p className="text-label font-medium text-fg">{tooltip.region.name}</p>
            <p className="mt-0.5 text-meta tabular-nums text-fg-muted">
              {tooltip.region.photoCount.toLocaleString()} 张 · 占本层{" "}
              {(shareOf(tooltip.region.photoCount, levelTotal) * 100).toFixed(1)}%
            </p>
          </div>
        ) : null}
      </div>
      {legend === null ? null : (
        <p className="mt-2 text-meta text-fg-muted">
          {legend ?? `基准：${scopeLabel} · ${levelTotal.toLocaleString()} 张`}
        </p>
      )}
    </div>
  );
}
