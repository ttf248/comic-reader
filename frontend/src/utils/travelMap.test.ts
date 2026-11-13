import { describe, expect, it } from "vitest";
import type { ChinaLocationGeometry } from "../api/aiJobs";
import {
  boundsOfPhotos,
  createMapProjection,
  levelOpacity,
  monthBuckets,
  polygonMaximumLatitude,
  regionLabelPoint,
  regionPath,
  shareOf,
  trajectoryPath,
  type MapRegion,
  type TrajectoryStop,
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
    const full = createMapProjection([east, west]);
    const cropped = createMapProjection([east, west], boundsOfPhotos([east, west]));
    // 裁剪之后画面里只有内容那一片：同样一段经度在屏幕上占得更宽。
    const fullWidth = full.project([117, 40])[0] - full.project([115, 40])[0];
    const croppedWidth =
      cropped.project([117, 40])[0] - cropped.project([115, 40])[0];
    expect(croppedWidth).toBeGreaterThan(fullWidth);
  });

  it("轨迹折线在间隔太久处断开", () => {
    const stops: TrajectoryStop[] = [
      {
        adcode: 1,
        name: "甲",
        at: "2019-05-02",
        until: "2019-05-02",
        photoCount: 3,
      },
      {
        adcode: 2,
        name: "乙",
        at: "2019-05-03",
        until: "2019-05-03",
        photoCount: 2,
      },
      {
        adcode: 3,
        name: "丙",
        at: "2021-06-12",
        until: "2021-06-12",
        photoCount: 1,
      },
    ];
    const centroidOf = (adcode: number): [number, number] | null =>
      adcode === 1 ? [10, 10] : adcode === 2 ? [20, 20] : [30, 30];
    const path = trajectoryPath(stops, centroidOf);
    // 前两段相隔一天，连在一起；第三段隔了两年，另起一段。
    expect(path).toContain("M10.00,10.00L20.00,20.00");
    expect(path).toContain("M30.00,30.00");
    expect(path).not.toContain("L30.00,30.00");
  });

  it("轨迹折线在空输入时不崩", () => {
    expect(trajectoryPath([], () => null)).toBe("");
    expect(
      trajectoryPath(
        [
          {
            adcode: 1,
            name: "甲",
            at: "2019-05-02",
            until: "2019-05-02",
            photoCount: 1,
          },
        ],
        () => null,
      ),
    ).toBe("");
  });
});
