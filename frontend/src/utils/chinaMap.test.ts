import { describe, expect, it } from "vitest";
import type { ChinaLocationGeometry } from "../api/aiJobs";
import {
  createMapProjection,
  levelOpacity,
  polygonMaximumLatitude,
  regionLabelPoint,
  regionPath,
  shareOf,
  type MapRegion,
} from "./chinaMap";

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
});
