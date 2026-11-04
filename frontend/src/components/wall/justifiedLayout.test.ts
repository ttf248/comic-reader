import { describe, expect, it } from "vitest";
import {
  DEFAULT_TILE_RATIO,
  layoutJustified,
  tileRatio,
  type WallTile,
} from "./justifiedLayout";

function tiles(count: number, ratio = 1.5): WallTile[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${index}`,
    ratio,
  }));
}

const options = { containerWidth: 1200, targetHeight: 200, gap: 8 };

describe("layoutJustified", () => {
  it("把每一行铺满容器宽度", () => {
    const rows = layoutJustified(tiles(12), options);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows.slice(0, -1)) {
      const total =
        row.tiles.reduce((sum, tile) => sum + tile.width, 0) +
        options.gap * (row.tiles.length - 1);
      expect(total).toBeCloseTo(options.containerWidth, 5);
    }
  });

  it("保留所有条目且顺序不变", () => {
    const rows = layoutJustified(tiles(17), options);
    const ids = rows.flatMap((row) => row.tiles.map((tile) => tile.id));
    expect(ids).toEqual(tiles(17).map((tile) => tile.id));
  });

  it("按真实比例给不同画幅不同宽度", () => {
    const rows = layoutJustified(
      [
        { id: "wide", ratio: 2 },
        { id: "square", ratio: 1 },
        { id: "tall", ratio: 0.5 },
      ],
      { containerWidth: 1200, targetHeight: 200, gap: 8 },
    );
    const row = rows[0];
    const wide = row.tiles.find((tile) => tile.id === "wide")!;
    const square = row.tiles.find((tile) => tile.id === "square")!;
    const tall = row.tiles.find((tile) => tile.id === "tall")!;
    expect(wide.width).toBeGreaterThan(square.width);
    expect(square.width).toBeGreaterThan(tall.width);
  });

  it("末行不为了填满宽度而放大", () => {
    const rows = layoutJustified(tiles(3), options);
    expect(rows).toHaveLength(1);
    expect(rows[0].tileHeight).toBeLessThanOrEqual(options.targetHeight);
  });

  it("单张竖图不会顶满屏幕", () => {
    const rows = layoutJustified([{ id: "tall", ratio: 0.4 }], {
      containerWidth: 1200,
      targetHeight: 200,
      gap: 8,
    });
    expect(rows[0].tileHeight).toBeLessThanOrEqual(200 * 1.8 + 0.001);
  });

  it("容器宽度或目标行高无效时返回空结果", () => {
    expect(layoutJustified(tiles(3), { ...options, containerWidth: 0 })).toEqual(
      [],
    );
    expect(layoutJustified([], options)).toEqual([]);
  });

  it("非法比例退回默认比例", () => {
    const rows = layoutJustified([{ id: "bad", ratio: 0 }], options);
    expect(rows[0].tiles[0].ratio).toBe(DEFAULT_TILE_RATIO);
  });
});

describe("tileRatio", () => {
  it("优先使用服务端给出的像素尺寸", () => {
    expect(tileRatio({ kind: "image", width: 1600, height: 900 })).toBeCloseTo(
      16 / 9,
      5,
    );
  });

  it("视频使用 16:9", () => {
    expect(tileRatio({ kind: "video" })).toBeCloseTo(16 / 9, 5);
  });

  it("尺寸未知时退回默认比例", () => {
    expect(tileRatio({ kind: "image" })).toBe(DEFAULT_TILE_RATIO);
    expect(tileRatio(undefined)).toBe(DEFAULT_TILE_RATIO);
  });
});
