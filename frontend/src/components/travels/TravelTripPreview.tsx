import { useMemo } from "react";
import type { ChinaTrip } from "../../api/aiJobs";
import {
  createMapProjection,
  geometryPolygons,
  MIN_RENDER_LATITUDE,
  polygonMaximumLatitude,
  regionLabelPoint,
  type MapRegion,
} from "../../utils/travelMap";

interface TravelTripPreviewProps {
  /** 这一段行程。 */
  trip: ChinaTrip;
  /** 各地点的形状：按 adcode 与行程里的停留点对上。 */
  regions: MapRegion[];
  /** 参照层：全国省界，只说明方位。 */
  backdrop?: MapRegion[];
}

/** 预览图的画布宽（高按 160/300 的比例）。 */
const CANVAS_WIDTH = 300;

/** 预览图的画布高。 */
const CANVAS_HEIGHT = 160;

/**
 * 只有一个停留点时的最小视野。
 *
 * 视野按内容范围算，但范围退化成一点时画面会缩到零 —— 留一档底噪，
 * 至少看得见自己站在哪儿。
 */
const MIN_WORLD_WIDTH = 42;

/**
 * 视野四周留出的余量（画布单位）。
 *
 * 站点标记有半径，不留余量的话边缘那一圈的标记会被切掉一半。
 */
const VIEW_PADDING = 14;

/**
 * 同一个地方被反复到访时，标记错开摆的半径（画布单位）。
 *
 * 一次出行常常在两三个城市之间来回 —— 标记叠在一起就只剩一个点，
 * 次序读不出来。错开摆，一圈标记对应一个地方，看得出「又回了一次」。
 */
const OVERLAP_RADIUS = 13;

/**
 * 站点表最多列几站。
 *
 * 站点表是给「这一站是几号、待了几天」用的；再往后的站点在图上标着
 * 序号，全列出来浮层会长过半个屏幕。
 */
const MAX_LISTED_STOPS = 8;

/**
 * 一段行程的预览。
 *
 * 上面是一张地图：这一段走过的地方画成轮廓，去过的次序连成一条带箭头的
 * 线，每一站标着序号。下面是站点表：第几站、什么地名、待了几天、几张
 * 照片。
 *
 * 连的是行政区里的落点，不是真实路径 —— 它说的是「按顺序走过这些
 * 地方」，不是「沿哪条路走的」。
 */
export default function TravelTripPreview({
  trip,
  regions,
  backdrop,
}: TravelTripPreviewProps) {
  // 每一站对应的形状：行程里的停留点按 adcode 与形状对上。
  const stopRegions = useMemo(
    () =>
      trip.stops.map(
        (stop) => regions.find((region) => region.adcode === stop.adcode) ?? null,
      ),
    [regions, trip.stops],
  );

  const projection = useMemo(
    () =>
      createMapProjection([
        ...(backdrop ?? []),
        ...stopRegions.filter((region): region is MapRegion => region !== null),
      ]),
    [backdrop, stopRegions],
  );

  // 每一站的落点：区域里最大的那个环的重心。
  const anchors = useMemo(
    () =>
      stopRegions.map((region) => {
        const label = region ? regionLabelPoint(region.geometry) : null;
        return label ? projection.project(label) : null;
      }),
    [projection, stopRegions],
  );

  // 视野：把这一段的落点整个装进画布，四周留出标记的余量。
  const view = useMemo(() => {
    const points = anchors.filter((point): point is [number, number] => point !== null);
    if (points.length === 0) return null;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const [x, y] of points) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const contentWidth = Math.max(maxX - minX, MIN_WORLD_WIDTH);
    const contentHeight = Math.max(maxY - minY, MIN_WORLD_WIDTH);
    // unit 是「一个画布单位值多少基坐标」。取大的一边：内容整个留下，
    // 多出来的一边留白。
    const unit = Math.max(
      contentWidth / (CANVAS_WIDTH - VIEW_PADDING * 2),
      contentHeight / (CANVAS_HEIGHT - VIEW_PADDING * 2),
    );
    const viewWidth = unit * CANVAS_WIDTH;
    const viewHeight = unit * CANVAS_HEIGHT;
    return {
      left: (minX + maxX) / 2 - viewWidth / 2,
      top: (minY + maxY) / 2 - viewHeight / 2,
      unit,
    };
  }, [anchors]);

  /** 基坐标 → 画布坐标。 */
  const toCanvas = useMemo(() => {
    if (!view) return null;
    const { left, top, unit } = view;
    return (point: [number, number]): [number, number] => [
      (point[0] - left) / unit,
      (point[1] - top) / unit,
    ];
  }, [view]);

  /** 经纬度 → 画布坐标（轮廓要用）。 */
  const projectShape = useMemo(() => {
    if (!toCanvas) return null;
    return (point: [number, number]): [number, number] =>
      toCanvas(projection.project(point));
  }, [projection, toCanvas]);

  const shapes = useMemo(() => {
    if (!projectShape) return [];
    return stopRegions.map((region, index) => ({
      key: index,
      path: region?.geometry ? shapePath(region.geometry, projectShape) : "",
    }));
  }, [projectShape, stopRegions]);

  const steps = useMemo(() => {
    const raw = trip.stops.map((stop, index) => ({
      stop,
      index: index + 1,
      point: anchors[index] && toCanvas ? toCanvas(anchors[index]!) : null,
    }));
    // 同一个地方被反复到访：标记叠在一起就只剩一个点。错开摆成一小圈，
    // 一个地方一圈标记 —— 看得出「又回了一次」。
    const groups = new Map<string, number[]>();
    raw.forEach((step, position) => {
      if (!step.point) return;
      const key = `${step.point[0].toFixed(2)},${step.point[1].toFixed(2)}`;
      const group = groups.get(key);
      if (group) group.push(position);
      else groups.set(key, [position]);
    });
    for (const positions of groups.values()) {
      if (positions.length < 2) continue;
      positions.forEach((position, order) => {
        const step = raw[position];
        if (!step.point) return;
        const angle = (order / positions.length) * Math.PI * 2 - Math.PI / 2;
        step.point = [
          step.point[0] + Math.cos(angle) * OVERLAP_RADIUS,
          step.point[1] + Math.sin(angle) * OVERLAP_RADIUS,
        ];
      });
    }
    return raw;
  }, [anchors, toCanvas, trip.stops]);

  const route = useMemo(
    () =>
      steps
        .filter((step): step is typeof step & { point: [number, number] } => step.point !== null)
        .map((step) => step.point),
    [steps],
  );

  if (!view || !toCanvas || route.length === 0) {
    return (
      <p className="text-meta text-fg-muted">
        这一段没有可画的地点 —— 边界数据里还没有它们的形状。
      </p>
    );
  }

  return (
    <div className="travel-preview">
      <svg
        className="travel-preview__map"
        viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
        role="img"
        aria-label={`${trip.startedAt} 至 ${trip.endedAt} 的行程轨迹，共 ${trip.stops.length} 站`}
      >
        {/* 走过的地方：只画这一段的轮廓。 */}
        <g aria-hidden="true">
          {shapes.map((shape) =>
            shape.path ? (
              <path
                key={shape.key}
                d={shape.path}
                className="travel-preview__shape"
                fillRule="evenodd"
              />
            ) : null,
          )}
        </g>

        {/* 轨迹：一段一段连，箭头摆在段中间 ——
            摆在末端的话会被下一站的序号圈盖住，方向就读不出来了。 */}
        <g aria-hidden="true">
          {route.slice(0, -1).map((point, index) => {
            const next = route[index + 1];
            return (
              <g key={index}>
                <line
                  x1={point[0]}
                  y1={point[1]}
                  x2={next[0]}
                  y2={next[1]}
                  className="travel-preview__route"
                />
                <path
                  d={arrowPath(point, next)}
                  className="travel-preview__arrowhead"
                />
              </g>
            );
          })}
        </g>

        {/* 站点与序号。 */}
        <g aria-hidden="true">
          {steps.map((step, position) =>
            step.point ? (
              <g key={position}>
                <circle
                  cx={step.point[0]}
                  cy={step.point[1]}
                  r={9}
                  className="travel-preview__step"
                />
                <text
                  x={step.point[0]}
                  y={step.point[1]}
                  className="travel-preview__step-label"
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {step.index}
                </text>
              </g>
            ) : null,
          )}
        </g>
      </svg>

      <ol className="travel-preview__stops">
        {trip.stops.slice(0, MAX_LISTED_STOPS).map((stop, index) => (
          <li key={index} className="travel-preview__stop">
            <span className="travel-preview__stop-index">{index + 1}</span>
            <span className="travel-preview__stop-name">{stop.name}</span>
            <span className="travel-preview__stop-meta tabular-nums">
              {stop.at === stop.until
                ? stop.at.slice(5)
                : `${stop.at.slice(5)} – ${stop.until.slice(5)}`}
              {" · "}
              {stop.photoCount.toLocaleString()} 张
            </span>
          </li>
        ))}
        {trip.stops.length > MAX_LISTED_STOPS ? (
          <li className="travel-preview__stop travel-preview__stop--more">
            还有 {trip.stops.length - MAX_LISTED_STOPS} 站，见上方序号
          </li>
        ) : null}
      </ol>
    </div>
  );
}

/**
 * 一段轨迹中点的箭头。
 *
 * 自己画三角形而不是用 SVG 的 marker：marker 摆在末端会被下一站的序号
 * 圈盖住，摆在中间才是「这一段往哪边走」。
 */
function arrowPath(from: [number, number], to: [number, number]): string {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (length < 1) return "";
  const angle = Math.atan2(dy, dx);
  const midX = (from[0] + to[0]) / 2;
  const midY = (from[1] + to[1]) / 2;
  const size = 6;
  const tipX = midX + Math.cos(angle) * size;
  const tipY = midY + Math.sin(angle) * size;
  const baseX = midX - Math.cos(angle) * size * 0.7;
  const baseY = midY - Math.sin(angle) * size * 0.7;
  const wing = size * 0.6;
  return `M${tipX.toFixed(2)},${tipY.toFixed(2)}L${(
    baseX - Math.sin(angle) * wing
  ).toFixed(2)},${(baseY + Math.cos(angle) * wing).toFixed(2)}L${(
    baseX + Math.sin(angle) * wing
  ).toFixed(2)},${(baseY - Math.cos(angle) * wing).toFixed(2)}Z`;
}

/**
 * 轮廓转成画布上的路径。
 *
 * 与 travelMap 的 regionPath 同一套画法，只是投影换成了画布坐标。
 */
function shapePath(
  geometry: NonNullable<MapRegion["geometry"]>,
  project: (point: [number, number]) => [number, number],
): string {
  return geometryPolygons(geometry)
    .filter((polygon) => polygonMaximumLatitude(polygon) >= MIN_RENDER_LATITUDE)
    .flatMap((polygon) =>
      polygon.map((ring) => {
        if (ring.length === 0) return "";
        const [first, ...rest] = ring.map(project);
        return `M${first[0].toFixed(2)},${first[1].toFixed(2)}${rest
          .map(([x, y]) => `L${x.toFixed(2)},${y.toFixed(2)}`)
          .join("")}Z`;
      }),
    )
    .join("");
}
