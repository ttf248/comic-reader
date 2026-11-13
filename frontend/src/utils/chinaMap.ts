import type { ChinaLocationGeometry, ChinaLocationPoint } from "../api/aiJobs";

/** 地图上可以绘制的一个行政区。 */
export interface MapRegion {
  adcode: number;
  name: string;
  level: string;
  photoCount: number;
  geometry: ChinaLocationGeometry;
}

export interface MapProjection {
  project: (point: ChinaLocationPoint) => [number, number];
  /** SVG 的 viewBox，按本层区域的实际长宽比给出。 */
  viewBox: string;
  width: number;
  height: number;
}

/**
 * 远离大陆的小环不参与绘制。
 *
 * 边界数据里带着南海诸岛等远离主体的碎块，把它们算进外接矩形会让
 * 本土的地图缩成一小团。
 */
export const MIN_RENDER_LATITUDE = 15;

/** 地图画布的宽度；高度按区域长宽比给出。 */
const MAP_WIDTH = 1000;

/** 地图画布的最高高度。超过这个比例的区域改用另一种缩放，免得地图变得又高又窄。 */
const MAP_MAX_HEIGHT = 1400;

/** 图上什么都不画时的占位画布。 */
const EMPTY_VIEW_BOX = "0 0 1000 750";

export function createMapProjection(regions: MapRegion[]): MapProjection {
  let minLongitude = Number.POSITIVE_INFINITY;
  let maxLongitude = Number.NEGATIVE_INFINITY;
  let minLatitude = Number.POSITIVE_INFINITY;
  let maxLatitude = Number.NEGATIVE_INFINITY;
  for (const region of regions) {
    for (const polygon of geometryPolygons(region.geometry)) {
      if (polygonMaximumLatitude(polygon) < MIN_RENDER_LATITUDE) continue;
      for (const ring of polygon) {
        for (const [longitude, latitude] of ring) {
          minLongitude = Math.min(minLongitude, longitude);
          maxLongitude = Math.max(maxLongitude, longitude);
          minLatitude = Math.min(minLatitude, latitude);
          maxLatitude = Math.max(maxLatitude, latitude);
        }
      }
    }
  }
  if (!Number.isFinite(minLongitude) || !Number.isFinite(minLatitude)) {
    return {
      project: () => [0, 0],
      viewBox: EMPTY_VIEW_BOX,
      width: MAP_WIDTH,
      height: 750,
    };
  }

  // 经度按本层中点纬度的余弦收缩，避免高纬地区被拉得过宽。
  const referenceLatitude = (minLatitude + maxLatitude) / 2;
  const longitudeScale = Math.cos((referenceLatitude * Math.PI) / 180) || 1;
  const scaledMin = minLongitude * longitudeScale;
  const scaledMax = maxLongitude * longitudeScale;
  const spanX = Math.max(scaledMax - scaledMin, 1e-6);
  const spanY = Math.max(maxLatitude - minLatitude, 1e-6);
  const scale = Math.min(MAP_WIDTH / spanX, MAP_MAX_HEIGHT / spanY);
  const drawnWidth = spanX * scale;
  const drawnHeight = spanY * scale;
  const offsetX = (MAP_WIDTH - drawnWidth) / 2;
  return {
    project: ([longitude, latitude]) => [
      offsetX + (longitude * longitudeScale - scaledMin) * scale,
      (maxLatitude - latitude) * scale,
    ],
    viewBox: `0 0 ${MAP_WIDTH} ${Math.round(drawnHeight)}`,
    width: MAP_WIDTH,
    height: Math.round(drawnHeight),
  };
}

/** 把几何拆成多边形数组，Polygon 与 MultiPolygon 都一样处理。 */
export function geometryPolygons(
  geometry: ChinaLocationGeometry,
): ChinaLocationPoint[][][] {
  return geometry.type === "Polygon"
    ? [geometry.coordinates]
    : geometry.coordinates;
}

/** 多边形里最高的纬度，用来判断它是不是远离大陆的碎块。 */
export function polygonMaximumLatitude(
  polygon: ChinaLocationPoint[][],
): number {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const ring of polygon) {
    for (const [, latitude] of ring) maximum = Math.max(maximum, latitude);
  }
  return maximum;
}

/** 把几何转成 SVG 路径数据。每个环一段，用 evenodd 规则挖洞。 */
export function regionPath(
  geometry: ChinaLocationGeometry,
  project: MapProjection["project"],
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

/**
 * 区域名字的落点。
 *
 * 取面积最大的那个环的重心；重心落在凹形区域外面时退回外接矩形
 * 中心；都落不到区域里就不画名字。
 */
export function regionLabelPoint(
  geometry: ChinaLocationGeometry,
): ChinaLocationPoint | null {
  let best: { ring: ChinaLocationPoint[]; area: number } | null = null;
  for (const polygon of geometryPolygons(geometry)) {
    for (const ring of polygon) {
      const area = Math.abs(polygonArea(ring));
      if (area <= 0) continue;
      if (!best || area > best.area) best = { ring, area };
    }
  }
  if (!best) return null;
  const centroid = polygonCentroid(best.ring);
  if (centroid && pointInGeometry(geometry, centroid)) return centroid;
  const bounds = ringBounds(best.ring);
  const center: ChinaLocationPoint = [
    (bounds.minLongitude + bounds.maxLongitude) / 2,
    (bounds.minLatitude + bounds.maxLatitude) / 2,
  ];
  return pointInGeometry(geometry, center) ? center : null;
}

/**
 * 当前层级里的照片占比。
 *
 * 分母是本层各区域的照片数合计，不是全国总数：色阶跟着层级走，
 * 图例才说得清楚。
 */
export function levelOpacity(count: number, levelTotal: number): number {
  if (count <= 0 || levelTotal <= 0) return 0;
  return 0.28 + 0.62 * Math.sqrt(count / levelTotal);
}

/** 区域在本层里的照片占比。 */
export function shareOf(count: number, levelTotal: number): number {
  if (count <= 0 || levelTotal <= 0) return 0;
  return Math.min(count / levelTotal, 1);
}

function polygonArea(ring: ChinaLocationPoint[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum / 2;
}

function polygonCentroid(
  ring: ChinaLocationPoint[],
): ChinaLocationPoint | null {
  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    twiceArea += cross;
    x += (ring[j][0] + ring[i][0]) * cross;
    y += (ring[j][1] + ring[i][1]) * cross;
  }
  if (Math.abs(twiceArea) < 1e-12) return null;
  return [x / (3 * twiceArea), y / (3 * twiceArea)];
}

function ringBounds(ring: ChinaLocationPoint[]) {
  let minLongitude = Number.POSITIVE_INFINITY;
  let maxLongitude = Number.NEGATIVE_INFINITY;
  let minLatitude = Number.POSITIVE_INFINITY;
  let maxLatitude = Number.NEGATIVE_INFINITY;
  for (const [longitude, latitude] of ring) {
    minLongitude = Math.min(minLongitude, longitude);
    maxLongitude = Math.max(maxLongitude, longitude);
    minLatitude = Math.min(minLatitude, latitude);
    maxLatitude = Math.max(maxLatitude, latitude);
  }
  return { minLongitude, maxLongitude, minLatitude, maxLatitude };
}

function pointInGeometry(
  geometry: ChinaLocationGeometry,
  point: ChinaLocationPoint,
): boolean {
  return geometryPolygons(geometry).some((polygon) =>
    polygon.some((ring) => pointInRing(point, ring)),
  );
}

function pointInRing(point: ChinaLocationPoint, ring: ChinaLocationPoint[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1]) {
      const crossing = ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
      if (point[0] < crossing) inside = !inside;
    }
  }
  return inside;
}
