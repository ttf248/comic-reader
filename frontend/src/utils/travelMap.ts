import type { ChinaLocationGeometry, ChinaLocationPoint } from "../api/aiJobs";

/** 地图上可以绘制的一个行政区。 */
export interface MapRegion {
  adcode: number;
  name: string;
  level: string;
  photoCount: number;
  /**
   * 绘图轮廓。
   *
   * 几何与统计是两份数据：轮廓还没到（或这个区划没有轮廓）时是 null，
   * 这时这个区划不参与绘制，但仍然出现在排行里。
   */
  geometry: ChinaLocationGeometry | null;
}

/** 地图上的一个矩形范围（经纬度）。 */
export interface MapBounds {
  minLongitude: number;
  maxLongitude: number;
  minLatitude: number;
  maxLatitude: number;
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

/**
 * 造一个投影。
 *
 * bounds 用来把画面裁到有照片的那一片：一张库里的照片往往只落在几个
 * 省，整张中国地图里大半是空的，裁到内容范围才看得见。
 */
export function createMapProjection(
  regions: MapRegion[],
  bounds?: MapBounds | null,
): MapProjection {
  let minLongitude = Number.POSITIVE_INFINITY;
  let maxLongitude = Number.NEGATIVE_INFINITY;
  let minLatitude = Number.POSITIVE_INFINITY;
  let maxLatitude = Number.NEGATIVE_INFINITY;
  for (const region of regions) {
    if (!region.geometry) continue;
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
  if (bounds) {
    minLongitude = Math.max(minLongitude, bounds.minLongitude);
    maxLongitude = Math.min(maxLongitude, bounds.maxLongitude);
    minLatitude = Math.max(minLatitude, bounds.minLatitude);
    maxLatitude = Math.min(maxLatitude, bounds.maxLatitude);
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

/**
 * 有照片的那些区域的外接矩形。
 *
 * 用来把画面裁到内容范围：全国层级下浙江那一片填满画面，比一整张
 * 大半是空的中国地图有用得多。
 */
export function boundsOfPhotos(regions: MapRegion[]): MapBounds | null {
  let minLongitude = Number.POSITIVE_INFINITY;
  let maxLongitude = Number.NEGATIVE_INFINITY;
  let minLatitude = Number.POSITIVE_INFINITY;
  let maxLatitude = Number.NEGATIVE_INFINITY;
  let found = false;
  for (const region of regions) {
    if (region.photoCount <= 0 || !region.geometry) continue;
    for (const polygon of geometryPolygons(region.geometry)) {
      if (polygonMaximumLatitude(polygon) < MIN_RENDER_LATITUDE) continue;
      for (const ring of polygon) {
        for (const [longitude, latitude] of ring) {
          found = true;
          minLongitude = Math.min(minLongitude, longitude);
          maxLongitude = Math.max(maxLongitude, longitude);
          minLatitude = Math.min(minLatitude, latitude);
          maxLatitude = Math.max(maxLatitude, latitude);
        }
      }
    }
  }
  if (!found) return null;
  // 留一点余量：内容正好贴着边框时，边缘的描边会被切掉一半。
  const padLongitude = Math.max((maxLongitude - minLongitude) * 0.08, 0.6);
  const padLatitude = Math.max((maxLatitude - minLatitude) * 0.08, 0.4);
  return {
    minLongitude: minLongitude - padLongitude,
    maxLongitude: maxLongitude + padLongitude,
    minLatitude: minLatitude - padLatitude,
    maxLatitude: maxLatitude + padLatitude,
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
  geometry: ChinaLocationGeometry | null,
  project: MapProjection["project"],
): string {
  if (!geometry) return "";
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
  geometry: ChinaLocationGeometry | null,
): ChinaLocationPoint | null {
  if (!geometry) return null;
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
 * 当前层级里的照片占比对应的填充浓度。
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

/** 逐月的照片数。 */
export interface MonthCount {
  /** "2024-06"。 */
  month: string;
  count: number;
}

/** 一个年份格。 */
export interface YearBucket {
  /** "2019". */
  year: string;
  count: number;
}

/**
 * 把逐月分布聚成年份。
 *
 * 年份按时间升序，没有照片的年份不出现 —— 时间轴上只摆有内容的年份。
 */
export function monthBuckets(months: MonthCount[]): YearBucket[] {
  const counts = new Map<string, number>();
  for (const entry of months) {
    const year = entry.month.slice(0, 4);
    if (year.length !== 4) continue;
    counts.set(year, (counts.get(year) ?? 0) + entry.count);
  }
  return [...counts.entries()]
    .map(([year, count]) => ({ year, count }))
    .sort((left, right) => left.year.localeCompare(right.year));
}

/** 轨迹上的一个停靠点。 */
export interface TrajectoryStop {
  adcode: number;
  name: string;
  /** 该段第一张照片的拍摄日期。 */
  at: string;
  /** 该段最后一张照片的拍摄日期。 */
  until: string;
  photoCount: number;
}

/**
 * 生成轨迹折线的路径数据。
 *
 * 停靠点画在行政区质心上，因此响应里不需要照片坐标。相邻停靠之间
 * 间隔超过阈值就不连线：否则相隔很久的两次出行会被画成一条假路径。
 */
export function trajectoryPath(
  stops: TrajectoryStop[],
  centroidOf: (adcode: number) => [number, number] | null,
  maxGapDays = 2,
): string {
  const segments: string[] = [];
  let segment = "";
  let previous: { point: [number, number]; until: string } | null = null;
  for (const stop of stops) {
    const point = centroidOf(stop.adcode);
    if (!point) continue;
    if (previous) {
      const gap = dayGap(previous.until, stop.at);
      if (gap > maxGapDays) {
        // 间隔太久，另起一段，不连线。
        if (segment) segments.push(segment);
        segment = `M${point[0].toFixed(2)},${point[1].toFixed(2)}`;
      } else {
        segment += `L${point[0].toFixed(2)},${point[1].toFixed(2)}`;
      }
    } else {
      segment = `M${point[0].toFixed(2)},${point[1].toFixed(2)}`;
    }
    previous = { point, until: stop.until };
  }
  if (segment) segments.push(segment);
  return segments.join(" ");
}

/** 两个日期之间隔了几天。 */
function dayGap(from: string, to: string): number {
  const fromTime = Date.parse(`${from}T00:00:00Z`);
  const toTime = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(fromTime) || Number.isNaN(toTime)) return 0;
  return Math.round((toTime - fromTime) / 86400000);
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
