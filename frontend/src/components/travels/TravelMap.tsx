import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { ChinaLocationGeometry } from "../../api/aiJobs";
import { useElementSize } from "../../hooks/useElementSize";
import {
  boundsOfPhotos,
  createMapProjection,
  levelOpacity,
  regionLabelPoint,
  regionPath,
  shareOf,
  trajectoryPath,
  type MapRegion,
  type TrajectoryStop,
} from "../../utils/travelMap";

interface TravelMapProps {
  /** 本层的全部区域。 */
  regions: MapRegion[];
  /** 本层照片总数，作为色阶与占比的分母。 */
  levelTotal: number;
  /** 当前层级名，例如「省级区域」「地级区域」。 */
  levelName: string;
  /** 当前层级名，例如「全国」「浙江省」。 */
  levelLabel: string;
  /** 区域名字是否画在图上。全国层级不画，34 个省名会糊成一片。 */
  showLabels: boolean;
  /** 行踪折线（可选，默认不画）。 */
  trajectory?: TrajectoryStop[];
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
 * 紧凑的行政区地图。
 *
 * 它是右栏里的一件配图，不是页面主角：所以高度有限，且默认把画面
 * 裁到有照片的那一片 —— 一张库里往往只有几个省有照片，整张中国地图
 * 里大半是空的。
 *
 * 地图本身只是形状，键盘与读屏用户靠旁边的排行进入 —— 所以这里只保证
 * 形状可点、可聚焦，信息不靠颜色单独承载。
 */
export default function TravelMap({
  regions,
  levelTotal,
  levelName,
  levelLabel,
  showLabels,
  trajectory,
  onSelect,
  onLevelUp,
}: TravelMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { ref: sizeRef, width: containerWidth } =
    useElementSize<HTMLDivElement>();
  const [focusIndex, setFocusIndex] = useState(0);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [cropToPhotos, setCropToPhotos] = useState(true);
  // 行踪折线默认不画：它连的是行政区质心，画出来是示意而不是真实路径。
  const [showRoute, setShowRoute] = useState(false);

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

  const photoBounds = useMemo(() => boundsOfPhotos(ordered), [ordered]);
  const projection = useMemo(
    () => createMapProjection(ordered, cropToPhotos ? photoBounds : null),
    [cropToPhotos, ordered, photoBounds],
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
          // 质心无条件算：行踪的节点要落在区域里，名字只是顺带用。
          centroid: regionLabelPoint(region.geometry),
          label: showLabels ? regionLabelPoint(region.geometry) : null,
        })),
    [ordered, projection, showLabels],
  );

  const centroidOf = useCallback(
    (adcode: number): [number, number] | null => {
      const entry = paths.find((item) => item.region.adcode === adcode);
      if (!entry?.centroid) return null;
      return projection.project(entry.centroid);
    },
    [paths, projection],
  );

  const routePath = useMemo(() => {
    if (!trajectory || trajectory.length === 0) return "";
    return trajectoryPath(trajectory, centroidOf, 2);
  }, [centroidOf, trajectory]);

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
      <div className="flex min-h-[220px] flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-body font-medium text-fg">这一层没有更细的边界</p>
        <p className="max-w-sm text-meta leading-relaxed text-fg-muted">
          这个区域的照片仍然计入上级统计，可以回到上一级继续查看。
        </p>
      </div>
    );
  }

  // 名字按屏幕上的实际字号给，不随 SVG 缩放：窄屏上 17 个单位只有
  // 六个像素，根本看不清。
  const labelFontSize =
    containerWidth > 0
      ? Math.min(30, (11 * projection.width) / containerWidth)
      : 15;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-fg-muted">
          {cropToPhotos ? "已缩放到有照片的区域" : "全国范围"}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-pressed={cropToPhotos}
            onClick={() => setCropToPhotos((value) => !value)}
            className="btn btn-sm btn-outline"
          >
            {cropToPhotos ? "看全国范围" : "缩到有照片的地方"}
          </button>
          {trajectory && trajectory.length > 0 ? (
            <button
              type="button"
              aria-pressed={showRoute}
              onClick={() => setShowRoute((value) => !value)}
              className="btn btn-sm btn-outline"
            >
              {showRoute ? "不看行踪" : "看行踪"}
            </button>
          ) : null}
        </div>
      </div>
      <div
        ref={(node) => {
          containerRef.current = node;
          sizeRef(node);
        }}
        className="travel-map"
      >
        <svg
          role="group"
          aria-label={`${levelLabel}${levelName}照片地图，可用方向键在区域间移动，回车下钻，Esc 返回上一级`}
          viewBox={projection.viewBox}
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
                  onClick={() => onSelect(region)}
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
          {showRoute && routePath ? (
            <path
              d={routePath}
              fill="none"
              stroke="var(--fg)"
              strokeOpacity={0.45}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray="5 4"
            />
          ) : null}
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
                    fontSize={labelFontSize}
                    className="pointer-events-none select-none"
                    fill="var(--fg)"
                    stroke="var(--bg-strong)"
                    strokeWidth={labelFontSize * 0.18}
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
              {(shareOf(tooltip.region.photoCount, levelTotal) * 100).toFixed(1)}%
            </p>
          </div>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-fg-muted">
        <span className="flex items-center gap-2">
          <span>少</span>
          <span className="h-2.5 w-10 rounded-full bg-gradient-to-r from-brand-soft to-brand" />
          <span>多</span>
        </span>
        <span className="text-fg-subtle">
          基准：{levelLabel} · {levelTotal.toLocaleString()} 张
        </span>
      </div>
    </div>
  );
}
