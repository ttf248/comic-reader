import { describe, expect, it } from "vitest";
import type { ChinaLocationGeometry } from "../api/aiJobs";
import {
  boundsOfPhotos,
  createMapProjection,
  fillMonthRange,
  fitViewport,
  levelOpacity,
  monthBuckets,
  monthIndex,
  monthKey,
  MAX_MAP_ZOOM,
  panViewportBy,
  photoViewport,
  pointRadius,
  polygonMaximumLatitude,
  regionLabelPoint,
  regionPath,
  shareOf,
  zoomViewportAt,
  type MapRegion,
} from "./travelMap";

const square: ChinaLocationGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [115, 39],
      [117, 39],
      [117, 41],
      [115, 41],
      [115, 39],
    ],
  ],
};

function region(overrides: Partial<MapRegion> = {}): MapRegion {
  return {
    adcode: 110000,
    name: "测试区",
    level: "city",
    photoCount: 1,
    geometry: square,
    ...overrides,
  };
}

describe("离线地图几何", () => {
  it("空输入不会崩溃，并给出占位画布", () => {
    const projection = createMapProjection([]);
    expect(projection.viewBox).toContain("1000");
    expect(projection.project([116, 40])).toEqual([0, 0]);
  });

  it("画布长宽比跟着区域走", () => {
    const projection = createMapProjection([region()]);
    const [, , width, height] = projection.viewBox.split(" ").map(Number);
    // 区域跨 2 度经度、2 度纬度，纬度越高经度越窄，画布略高于宽。
    expect(width).toBe(1000);
    expect(height).toBeGreaterThan(width * 0.9);
    expect(height).toBeLessThan(width * 1.4);
  });

  it("远离大陆的碎块不参与绘制", () => {
    const farSouth: ChinaLocationGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [110, 4],
          [111, 4],
          [111, 5],
          [110, 4],
        ],
      ],
    };
    const path = regionPath(farSouth, createMapProjection([region()]).project);
    expect(path).toBe("");
    expect(polygonMaximumLatitude([farSouth.coordinates[0]])).toBeLessThan(15);
  });

  it("Polygon 与 MultiPolygon 都能产出路径", () => {
    const projection = createMapProjection([region()]);
    const polygon = regionPath(square, projection.project);
    const multi = regionPath(
      {
        type: "MultiPolygon",
        coordinates: [square.coordinates],
      },
      projection.project,
    );
    expect(polygon.startsWith("M")).toBe(true);
    expect(polygon.endsWith("Z")).toBe(true);
    expect(multi).toBe(polygon);
  });

  it("区域名字落在区域里面", () => {
    const point = regionLabelPoint(square);
    expect(point).not.toBeNull();
    expect(point?.[0]).toBeGreaterThanOrEqual(115);
    expect(point?.[0]).toBeLessThanOrEqual(117);
    expect(point?.[1]).toBeGreaterThanOrEqual(39);
    expect(point?.[1]).toBeLessThanOrEqual(41);
  });

  it("没有轮廓的区域不参与绘制", () => {
    const projection = createMapProjection([region({ geometry: null })]);
    expect(regionPath(null, projection.project)).toBe("");
    expect(regionLabelPoint(null)).toBeNull();
  });

  it("色阶的分母是本层合计，换一层就换一个深浅", () => {
    expect(levelOpacity(0, 100)).toBe(0);
    expect(levelOpacity(10, 0)).toBe(0);
    expect(levelOpacity(100, 100)).toBeGreaterThan(levelOpacity(10, 100));
    // 同样的照片数，在照片总数更少的一层里颜色更深。
    expect(levelOpacity(10, 20)).toBeGreaterThan(levelOpacity(10, 100));
  });

  it("占比不会算出 NaN", () => {
    expect(shareOf(0, 0)).toBe(0);
    expect(shareOf(5, 0)).toBe(0);
    expect(shareOf(5, 10)).toBe(0.5);
    expect(shareOf(20, 10)).toBe(1);
  });

  it("逐月分布聚成年份，按时间升序", () => {
    const years = monthBuckets([
      { month: "2021-06", count: 3 },
      { month: "2019-05", count: 2 },
      { month: "2019-11", count: 4 },
    ]);
    expect(years).toEqual([
      { year: "2019", count: 6 },
      { year: "2021", count: 3 },
    ]);
  });

  it("有照片的区域给出内容范围，没有照片的给不出", () => {
    const bounds = boundsOfPhotos([
      region({ adcode: 1, photoCount: 5 }),
      region({ adcode: 2, photoCount: 0 }),
    ]);
    expect(bounds).not.toBeNull();
    expect(bounds?.minLongitude).toBeLessThanOrEqual(115);
    expect(bounds?.maxLongitude).toBeGreaterThanOrEqual(117);
    expect(boundsOfPhotos([region({ photoCount: 0 })])).toBeNull();
  });

  it("裁到内容范围后画面里只剩下那一片", () => {
    const east: MapRegion = region({ adcode: 1, photoCount: 5 });
    const west: MapRegion = {
      ...region({ adcode: 2, photoCount: 0 }),
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [80, 20],
            [85, 20],
            [85, 25],
            [80, 20],
          ],
        ],
      },
    };
    const projection = createMapProjection([east, west]);
    const bounds = boundsOfPhotos([east, west]);
    expect(bounds).not.toBeNull();
    const fit = fitViewport(projection);
    const cropped = photoViewport(projection, bounds);
    // 裁剪之后画面里只有内容那一片：视口更窄，同样一段经度占得更宽。
    expect(cropped.width).toBeLessThan(fit.width);
    const fitWidth = fit.width;
    const croppedWidth = cropped.width;
    const fullSpan = projection.project([117, 40])[0] - projection.project([115, 40])[0];
    expect(fullSpan / croppedWidth).toBeGreaterThan(fullSpan / fitWidth);
  });

  it("视口换算出的 viewBox 长宽比恒定", () => {
    const projection = createMapProjection([region()]);
    const viewport = fitViewport(projection);
    const [, , width, height] = projection
      .viewBoxFor(viewport)
      .split(" ")
      .map(Number);
    expect(width).toBe(projection.worldWidth);
    expect(height / width).toBeCloseTo(
      projection.worldHeight / projection.worldWidth,
      6,
    );
  });

  it("以指针为锚点缩放时，指针下的地物不动", () => {
    const projection = createMapProjection([region()]);
    const viewport = fitViewport(projection);
    const zoomed = zoomViewportAt(projection, viewport, 4, 0.75, 0.25);
    // 锚点在缩放前后的基坐标位置应当一致。
    const before = {
      x: viewport.centerX + (0.75 - 0.5) * viewport.width,
      y:
        viewport.centerY +
        (0.25 - 0.5) *
          viewport.width *
          (projection.worldHeight / projection.worldWidth),
    };
    const after = {
      x: zoomed.centerX + (0.75 - 0.5) * zoomed.width,
      y:
        zoomed.centerY +
        (0.25 - 0.5) *
          zoomed.width *
          (projection.worldHeight / projection.worldWidth),
    };
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(zoomed.width).toBeCloseTo(viewport.width / 4, 6);
  });

  it("缩放有上下限，拖不出基坐标", () => {
    const projection = createMapProjection([region()]);
    const fit = fitViewport(projection);
    const zoomedOut = zoomViewportAt(projection, fit, 0.01);
    expect(zoomedOut.width).toBeCloseTo(fit.width, 6);
    const zoomedIn = zoomViewportAt(projection, fit, 1000);
    expect(zoomedIn.width).toBeGreaterThanOrEqual(
      projection.worldWidth / MAX_MAP_ZOOM - 1e-6,
    );
    const panned = panViewportBy(projection, fit, 100, 100);
    expect(panned.centerX).toBeLessThanOrEqual(projection.worldWidth * 1.25 + 1e-6);
  });

  it("点的半径按张数开方缩放", () => {
    const world = 1000;
    const small = pointRadius(10, 100, world, world);
    const large = pointRadius(100, 100, world, world);
    // 十倍的张数不该有十倍的面积。
    expect(large / small).toBeLessThan(3);
    expect(large).toBeGreaterThan(small);
    // 视口放大时半径按比例缩小，屏幕上的大小不变。
    expect(pointRadius(100, 100, world / 4, world)).toBeCloseTo(large / 4, 6);
  });

  it("月份序号能来回换", () => {
    expect(monthIndex("2019-05")).toBe(monthIndex("2019-05"));
    expect(monthIndex("2020-05") - monthIndex("2019-05")).toBe(12);
    expect(monthKey(monthIndex("2019-05"))).toBe("2019-05");
  });

  it("空档的月份也要占位，否则稀疏的年份会被压扁", () => {
    const filled = fillMonthRange([
      { month: "2019-01", count: 3 },
      { month: "2019-04", count: 2 },
    ]);
    expect(filled.map((entry) => entry.month)).toEqual([
      "2019-01",
      "2019-02",
      "2019-03",
      "2019-04",
    ]);
    expect(filled[1].count).toBe(0);
  });
});
