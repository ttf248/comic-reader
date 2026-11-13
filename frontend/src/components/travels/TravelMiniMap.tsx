import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChinaPointCell } from "../../api/aiJobs";
import {
  boundsOfPhotos,
  boundsOfPoints,
  createMapProjection,
  levelOpacity,
  photoViewport,
  regionPath,
  type MapRegion,
} from "../../utils/travelMap";

interface TravelMiniMapProps {
  /** 画出来的地方：有照片的那些，带各自的轮廓。 */
  regions: MapRegion[];
  /** 参照层：全国省界，只作方位参照。 */
  backdrop?: MapRegion[];
  /** 点位：照片位置的网格聚合。 */
  points?: ChinaPointCell[];
  /** 本层的照片总数，作为色阶的分母。 */
  levelTotal: number;
  /** 这一层的说法。 */
  scopeLabel: string;
}

/**
 * 小地图：数字台右端的那一块。
 *
 * 它不占一屏，也不该占一屏 —— 但「去过哪些地方」这件事得一直看得见。
 * 所以地图缩成信息栏右边的一块：去过的地方按张数深浅着色，照片集中的
 * 位置泛出一点光。
 *
 * 这个尺寸下画不出行政区的细节，也不需要 —— 它是一眼扫过去的方位感，
 * 不是用来读图的，更不是用来点的：236 像素宽的图上，一个市只有几个
 * 像素宽，点了也点不准。要去某个地方，从旁边的「地方」清单进。
 */
export default function TravelMiniMap({
  regions,
  backdrop,
  points,
  levelTotal,
  scopeLabel,
}: TravelMiniMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // 画布的实际尺寸：点的大小要按屏幕像素算，不能按基坐标算。
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      // 去掉内边距：量的是 svg 真正拿到的那块。
      const style = window.getComputedStyle(element);
      const width =
        element.clientWidth -
        parseFloat(style.paddingLeft || "0") -
        parseFloat(style.paddingRight || "0");
      const height =
        element.clientHeight -
        parseFloat(style.paddingTop || "0") -
        parseFloat(style.paddingBottom || "0");
      if (width > 0 && height > 0) setSize({ width, height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const aspect = size.height > 0 ? size.height / size.width : 104 / 236;

  const projection = useMemo(
    () => createMapProjection([...(backdrop ?? []), ...regions]),
    [backdrop, regions],
  );

  // 画面裁到照片真正在的那一片：行政区比照片的位置大得多（一个市
  // 几百公里，照片往往只在市区那几公里里），按行政区裁会裁出一大片空白。
  const contentBounds = useMemo(
    () => boundsOfPoints(points ?? []) ?? boundsOfPhotos(regions),
    [points, regions],
  );

  const viewBox = useMemo(() => {
    if (!contentBounds) return projection.viewBox;
    // contain：内容整个留下。这个尺寸下宁可两边留白，也不要切掉
    // 最远的那几张照片。
    const viewport = photoViewport(projection, contentBounds, aspect, "contain");
    const height = viewport.width * aspect;
    return `${viewport.centerX - viewport.width / 2} ${viewport.centerY - height / 2} ${viewport.width} ${height}`;
  }, [aspect, contentBounds, projection]);

  // 屏幕像素 → 基坐标的比例。点按屏幕像素画，才不会在放大时糊成一坨。
  const scale = useMemo(() => {
    const [, , width, height] = viewBox.split(" ").map(Number);
    if (!Number.isFinite(width) || width <= 0 || size.width <= 0) return 1;
    const byWidth = size.width / width;
    const byHeight = size.height > 0 ? size.height / height : byWidth;
    return Math.min(byWidth, byHeight);
  }, [size.height, size.width, viewBox]);

  const paths = useMemo(
    () =>
      regions
        .filter((region) => region.geometry !== null)
        .map((region) => ({
          region,
          path: regionPath(region.geometry, projection.project),
        })),
    [projection, regions],
  );

  const backdropPaths = useMemo(
    () =>
      (backdrop ?? [])
        .filter((region) => region.geometry !== null)
        .map((region) => ({
          region,
          path: regionPath(region.geometry, projection.project),
        })),
    [backdrop, projection],
  );

  const maxPointCount = useMemo(
    () => points?.reduce((max, cell) => Math.max(max, cell.count), 0) ?? 0,
    [points],
  );

  const photoTotal = useMemo(
    () => points?.reduce((sum, cell) => sum + cell.count, 0) ?? 0,
    [points],
  );

  const empty = regions.length === 0 && (points?.length ?? 0) === 0;

  return (
    <div
      className="travel-mini-map"
      ref={(node) => {
        containerRef.current = node;
      }}
    >
      {empty ? (
        <p className="text-meta text-fg-muted">还没有带位置的照片</p>
      ) : (
        <svg
          role="img"
          aria-label={`${scopeLabel}小地图：${regions.length} 个地方，${photoTotal.toLocaleString()} 张带位置的照片`}
          viewBox={viewBox}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* 参照层：全国省界，只说明方位。 */}
          <g aria-hidden="true">
            {backdropPaths.map(({ region, path }) => (
              <path
                key={`backdrop-${region.adcode}`}
                d={path}
                className="fill-none stroke-border-strong"
                strokeWidth={1}
                strokeLinejoin="round"
                fillRule="evenodd"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
          {/* 去过的地方：按张数深浅。 */}
          <g aria-hidden="true">
            {paths.map(({ region, path }) => {
              const hasPhotos = region.photoCount > 0;
              // 这个尺寸下填色只是底：太实了就成了一块蓝。
              const opacity = hasPhotos
                ? levelOpacity(region.photoCount, levelTotal) * 0.55
                : 0;
              return (
                <path
                  key={region.adcode}
                  d={path}
                  className="fill-brand"
                  fillOpacity={opacity}
                  stroke="brand"
                  strokeWidth={1}
                  strokeLinejoin="round"
                  fillRule="evenodd"
                  vectorEffect="non-scaling-stroke"
                >
                  <title>{`${region.name} · ${region.photoCount.toLocaleString()} 张`}</title>
                </path>
              );
            })}
          </g>
          {/* 点云：照片真正的位置。 */}
          <g aria-hidden="true">
            {(points ?? []).map((cell) => {
              const [x, y] = projection.project([cell.lon, cell.lat]);
              const share =
                maxPointCount > 0 ? Math.sqrt(cell.count / maxPointCount) : 0;
              // 点很小，才看得出是一颗一颗的照片位置，不是一团糊影。
              const radius = (1.3 + 2.1 * share) / Math.max(scale, 0.0001);
              return (
                <circle
                  key={`${cell.lon}-${cell.lat}`}
                  className="travel-mini-map__point"
                  cx={x}
                  cy={y}
                  r={radius}
                  fillOpacity={cell.untimed > 0 ? 0.32 : 0.6}
                >
                  <title>{`${cell.count} 张 · ${cell.firstAt || "时间未知"} – ${cell.lastAt || "时间未知"}`}</title>
                </circle>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}
