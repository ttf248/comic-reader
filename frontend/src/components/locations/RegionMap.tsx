import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  createMapProjection,
  levelOpacity,
  regionLabelPoint,
  regionPath,
  shareOf,
  type MapRegion,
} from "../../utils/chinaMap";

interface RegionMapProps {
  /** 本层的全部区域。 */
  regions: MapRegion[];
  /** 本层照片总数，作为色阶与占比的分母。 */
  levelTotal: number;
  /** 本层名称，例如「省级区域」「地级区域」。 */
  levelName: string;
  /** 当前层级名，例如「全国」「浙江省」。 */
  levelLabel: string;
  /** 区域名字是否画在图上。全国层级不画，34 个省名会糊成一片。 */
  showLabels: boolean;
  /** 点选区域时下钻一层。 */
  onSelect: (region: MapRegion) => void;
  /** 回到上一层。 */
  onLevelUp: () => void;
}

interface TooltipState {
  region: MapRegion;
  x: number;
  y: number;
}

/**
 * 层级无关的行政区照片地图。
 *
 * 地图本身只是形状，键盘与读屏用户靠右边的排行列表进入 —— 所以这里
 * 只保证形状可点、可聚焦，信息不靠颜色单独承载。
 */
export default function RegionMap({
  regions,
  levelTotal,
  levelName,
  levelLabel,
  showLabels,
  onSelect,
  onLevelUp,
}: RegionMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const projection = useMemo(() => createMapProjection(regions), [regions]);

  // 区域按照片数排序：焦点移动的顺序与视觉重要性一致，
  // 排行列表也用同一个顺序。
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

  const paths = useMemo(
    () =>
      ordered.map((region) => ({
        region,
        path: regionPath(region.geometry, projection.project),
        label: showLabels ? regionLabelPoint(region.geometry) : null,
      })),
    [ordered, projection, showLabels],
  );

  const showTooltip = useCallback(
    (region: MapRegion, event: MouseEvent<SVGElement>) => {
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
          onSelect(region);
          break;
        case "Escape":
          event.preventDefault();
          event.stopPropagation();
          onLevelUp();
          break;
        default:
          break;
      }
    },
    [focusIndex, moveFocus, onLevelUp, onSelect, ordered.length],
  );

  if (regions.length === 0) {
    return (
      <div className="flex min-h-[320px] flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-body font-medium text-fg">这一层没有更细的边界</p>
        <p className="max-w-sm text-meta leading-relaxed text-fg-muted">
          这个区域的照片仍然计入上级统计，可以回到上一级继续查看。
        </p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative px-2 py-3 sm:px-4">
      <svg
        role="group"
        aria-label={`${levelLabel}${levelName}照片地图，可用方向键在区域间移动，回车下钻，Esc 返回上一级`}
        viewBox={projection.viewBox}
        className="mx-auto block h-auto w-full"
      >
        <g>
          {paths.map(({ region, path }, index) => {
            const opacity = levelOpacity(region.photoCount, levelTotal);
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
                onClick={() => onSelect(region)}
                onMouseEnter={(event) => showTooltip(region, event)}
                onMouseMove={(event) => showTooltip(region, event)}
                onMouseLeave={() => setTooltip(null)}
                onFocus={(event) => {
                  const bounds =
                    event.currentTarget.getBoundingClientRect();
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
                    region.photoCount === 0
                      ? "fill-bg-subtle group-focus-visible:stroke-brand-ink"
                      : "fill-brand group-hover:fill-brand-ink group-focus-visible:stroke-brand-ink"
                  }
                  fillOpacity={opacity}
                  stroke={region.photoCount === 0 ? "border-strong" : "brand"}
                  strokeWidth={1.4}
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
        {showLabels
          ? paths.map(({ region, label }) => {
              if (!label) return null;
              const [x, y] = projection.project(label);
              return (
                <text
                  key={`label-${region.adcode}`}
                  x={x}
                  y={y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={17}
                  className="pointer-events-none select-none"
                  fill="var(--fg)"
                  stroke="var(--bg-elevated)"
                  strokeWidth={3}
                  paintOrder="stroke"
                >
                  {region.name}
                </text>
              );
            })
          : null}
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
            {(
              shareOf(tooltip.region.photoCount, levelTotal) * 100
            ).toFixed(1)}
            %
          </p>
        </div>
      ) : null}
    </div>
  );
}
