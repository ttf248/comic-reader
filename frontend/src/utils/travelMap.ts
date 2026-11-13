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

/**
 * 地图的视口。
 *
 * 投影把经纬度换算成一套固定的「基坐标」，视口决定基坐标里哪一块看得
 * 见。两者分开，缩放与平移才只是换视口 —— 路径与点位不必重算。
 */
export interface MapViewport {
  /** 视口中心（基坐标）。 */
  centerX: number;
  centerY: number;
  /** 视口宽度（基坐标单位）。 */
  width: number;
}

export interface MapProjection {
  project: (point: ChinaLocationPoint) => [number, number];
  /** SVG 的 viewBox，按本层区域的实际长宽比给出。 */
  viewBox: string;
  width: number;
  height: number;
  /** 基坐标的宽高。视口的取值范围就是它。 */
  worldWidth: number;
  worldHeight: number;
  /**
   * 视口 → SVG 的 viewBox。
   *
   * aspect 是画布的高宽比（容器的高除以宽）。给了它，viewBox 就与画布
   * 同形，图铺满整块画布而不是缩在中间、两边各空一截。
   */
  viewBoxFor: (viewport: MapViewport, aspect?: number) => string;
}

/** 画布的默认高宽比：与基坐标同形。 */
function worldAspect(projection: MapProjection): number {
  return projection.worldHeight / projection.worldWidth;
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

/** 视口最多能放大到铺满的多少倍。 */
export const MAX_MAP_ZOOM = 32;

/**
 * 造一个投影。
 *
 * 投影覆盖本层所有区域的完整范围，缩放与平移交给视口：一张静态图片
 * 只能整张缩放，一张地图得能推到某一座城市里。
 */
export function createMapProjection(regions: MapRegion[]): MapProjection {
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
  if (!Number.isFinite(minLongitude) || !Number.isFinite(minLatitude)) {
    return {
      project: () => [0, 0],
      viewBox: EMPTY_VIEW_BOX,
      width: MAP_WIDTH,
      height: 750,
      worldWidth: MAP_WIDTH,
      worldHeight: 750,
      viewBoxFor: () => EMPTY_VIEW_BOX,
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
  const worldHeight = Math.round(drawnHeight);
  const project = ([longitude, latitude]: ChinaLocationPoint): [number, number] => [
    offsetX + (longitude * longitudeScale - scaledMin) * scale,
    (maxLatitude - latitude) * scale,
  ];
  return {
    project,
    viewBox: `0 0 ${MAP_WIDTH} ${worldHeight}`,
    width: MAP_WIDTH,
    height: worldHeight,
    worldWidth: MAP_WIDTH,
    worldHeight,
    viewBoxFor: (viewport: MapViewport, aspect?: number) => {
      const width = Math.max(viewport.width, 1);
      const height = width * (aspect ?? worldHeight / MAP_WIDTH);
      return `${viewport.centerX - width / 2} ${viewport.centerY - height / 2} ${width} ${height}`;
    },
  };
}

/**
 * 铺满整个基坐标的视口。
 *
 * aspect 是画布的高宽比。取「装满画布」而不是「把内容整个放进画布」：
 * 地图是要铺满一块画布的，露出来的空白不是内容。
 */
export function fitViewport(
  projection: MapProjection,
  aspect?: number,
): MapViewport {
  const ratio = aspect ?? worldAspect(projection);
  return {
    centerX: projection.worldWidth / 2,
    centerY: projection.worldHeight / 2,
    width: Math.min(projection.worldWidth, projection.worldHeight / ratio),
  };
}

/**
 * 视口的缩放倍数：1 是铺满。
 */
export function viewportZoom(
  projection: MapProjection,
  viewport: MapViewport,
): number {
  return projection.worldWidth / Math.max(viewport.width, 1);
}

/**
 * 把视口夹在合理范围内。
 *
 * 放大有上限（再推行政区已经糊了），缩小不下于铺满；中心也不许拖出
 * 基坐标太远，否则会拖到一片空白里。
 */
export function clampViewport(
  projection: MapProjection,
  viewport: MapViewport,
  aspect?: number,
): MapViewport {
  const ratio = aspect ?? worldAspect(projection);
  const minimum = projection.worldWidth / MAX_MAP_ZOOM;
  // 最宽的一档就是「铺满」：画布比基坐标更宽时，铺满要看得更多。
  const maximum = Math.max(projection.worldWidth, projection.worldHeight / ratio);
  const width = Math.min(Math.max(viewport.width, minimum), maximum);
  const slack = projection.worldWidth * 0.25;
  return {
    centerX: Math.min(
      Math.max(viewport.centerX, -slack),
      projection.worldWidth + slack,
    ),
    centerY: Math.min(
      Math.max(viewport.centerY, -slack),
      projection.worldHeight + slack,
    ),
    width,
  };
}

/**
 * 以某个屏幕位置为锚点缩放。
 *
 * anchorX 与 anchorY 是该位置在容器里的比例（0 到 1）。缩放时那个位置
 * 下的地物不动 —— 滚轮缩放要跟着指针走，不是跟着中心走。
 */
export function zoomViewportAt(
  projection: MapProjection,
  viewport: MapViewport,
  factor: number,
  anchorX = 0.5,
  anchorY = 0.5,
  aspect?: number,
): MapViewport {
  const ratio = aspect ?? worldAspect(projection);
  const worldX = viewport.centerX + (anchorX - 0.5) * viewport.width;
  const worldY = viewport.centerY + (anchorY - 0.5) * viewport.width * ratio;
  const next = clampViewport(
    projection,
    {
      centerX: viewport.centerX,
      centerY: viewport.centerY,
      width: viewport.width / factor,
    },
    ratio,
  );
  return {
    centerX: worldX - (anchorX - 0.5) * next.width,
    centerY: worldY - (anchorY - 0.5) * next.width * ratio,
    width: next.width,
  };
}

/**
 * 平移视口。
 *
 * deltaX 与 deltaY 是位移占容器宽高的比例，正数表示内容往右 / 往下移。
 */
export function panViewportBy(
  projection: MapProjection,
  viewport: MapViewport,
  deltaX: number,
  deltaY: number,
  aspect?: number,
): MapViewport {
  const ratio = aspect ?? worldAspect(projection);
  return clampViewport(
    projection,
    {
      centerX: viewport.centerX - deltaX * viewport.width,
      centerY: viewport.centerY - deltaY * viewport.width * ratio,
      width: viewport.width,
    },
    ratio,
  );
}

/**
 * 缩到有照片的那一片的视口。
 *
 * 一张库里的照片往往只落在几个省，整张中国地图里大半是空的；裁到内容
 * 范围，那一片才填满画面。
 *
 * fit 决定内容与画面的关系：
 * - cover（默认）：画面装满内容，多出来的一边裁掉。内容填满画面，但
 *   会切掉照片最远的那一角。
 * - contain：内容整个留下，多出来的一边留白。宁可留白也不切掉照片。
 */
export function photoViewport(
  projection: MapProjection,
  bounds: MapBounds | null,
  aspect?: number,
  fit: "cover" | "contain" = "cover",
): MapViewport {
  if (!bounds) return fitViewport(projection, aspect);
  const corners: ChinaLocationPoint[] = [
    [bounds.minLongitude, bounds.maxLatitude],
    [bounds.maxLongitude, bounds.maxLatitude],
    [bounds.minLongitude, bounds.minLatitude],
    [bounds.maxLongitude, bounds.minLatitude],
  ];
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const corner of corners) {
    const [x, y] = projection.project(corner);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const ratio = aspect ?? worldAspect(projection);
  const contentWidth = Math.max(maxX - minX, 1);
  const contentHeight = Math.max(maxY - minY, 1);
  const width =
    fit === "contain"
      ? // 取大的一边：内容整个留下，多出来的一边留白。
        Math.max(contentWidth, contentHeight / ratio) * 1.06
      : // 取小的一边：画面装满内容，多出来的一边裁掉。
        Math.min(
          Math.min(projection.worldWidth, projection.worldHeight / ratio) * 2,
          Math.min(contentWidth, contentHeight / ratio) * 1.12,
        );
  return clampViewport(
    projection,
    {
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
      width,
    },
    ratio,
  );
}

/**
 * 点的半径（基坐标单位）。
 *
 * 张数按开方缩放：差十倍的张数不该差十倍的面积。半径随视口一起缩，
 * 屏幕上的大小不变 —— 放大地图时点不会糊成一坨。
 */
export function pointRadius(
  count: number,
  maxCount: number,
  viewportWidth: number,
  worldWidth: number,
): number {
  const share = maxCount > 0 ? Math.sqrt(count / maxCount) : 0;
  const units = 2.5 + 7 * share;
  return units * (viewportWidth / Math.max(worldWidth, 1));
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

/**
 * 照片点位的外接矩形。
 *
 * 与 boundsOfPhotos 一样用于裁画面，但这一份是点本身的位置 —— 照片真的
 * 在哪儿，而不是行政区画到哪儿。
 */
export function boundsOfPoints(
  cells: { lon: number; lat: number }[],
): MapBounds | null {
  let minLongitude = Number.POSITIVE_INFINITY;
  let maxLongitude = Number.NEGATIVE_INFINITY;
  let minLatitude = Number.POSITIVE_INFINITY;
  let maxLatitude = Number.NEGATIVE_INFINITY;
  for (const cell of cells) {
    minLongitude = Math.min(minLongitude, cell.lon);
    maxLongitude = Math.max(maxLongitude, cell.lon);
    minLatitude = Math.min(minLatitude, cell.lat);
    maxLatitude = Math.max(maxLatitude, cell.lat);
  }
  if (!Number.isFinite(minLongitude)) return null;
  return { minLongitude, maxLongitude, minLatitude, maxLatitude };
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

/**
 * 月份的序号。
 *
 * 时间带按真实时间比例铺开，因此每��月都要占一个位置：2011 年 11 月的
 * 序号与 2022 年 10 月的序号之间，隔着多少个月就是多少个月。
 */
export function monthIndex(month: string): number {
  const year = Number(month.slice(0, 4));
  const value = Number(month.slice(5, 7));
  if (!Number.isFinite(year) || !Number.isFinite(value)) return Number.NaN;
  return year * 12 + (value - 1);
}

/**
 * 序号的月份写法（"YYYY-MM"）。
 */
export function monthKey(index: number): string {
  const year = Math.floor(index / 12);
  const value = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(value).padStart(2, "0")}`;
}

/**
 * 补齐两个月之间的空档。
 *
 * 逐月分布里只有有照片的月份。时间带按真实时间比例铺开，缺一个月的位置
 * 就会让后面的月份整体前移 —— 稀疏的那几年会被压扁，看不出那几年其实
 * 没怎么出门。
 */
export function fillMonthRange(months: MonthCount[]): MonthCount[] {
  const known = new Map(months.map((entry) => [entry.month, entry.count]));
  const keys = [...known.keys()].filter((key) => Number.isFinite(monthIndex(key)));
  if (keys.length === 0) return [];
  const indexes = keys.map(monthIndex).sort((left, right) => left - right);
  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  const filled: MonthCount[] = [];
  for (let index = first; index <= last; index += 1) {
    const key = monthKey(index);
    filled.push({ month: key, count: known.get(key) ?? 0 });
  }
  return filled;
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
