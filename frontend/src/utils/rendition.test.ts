import { describe, expect, it } from "vitest";
import {
  RENDITION_WIDTHS,
  fitPreviewWidth,
  pickRenditionWidth,
  renditionCandidates,
} from "./rendition";

describe("pickRenditionWidth", () => {
  it("选出够用的最小档位", () => {
    expect(pickRenditionWidth(320, 1)).toBe(320);
    expect(pickRenditionWidth(321, 1)).toBe(640);
    expect(pickRenditionWidth(554, 1)).toBe(640);
    expect(pickRenditionWidth(554, 2)).toBe(1280);
    expect(pickRenditionWidth(1280, 1)).toBe(1280);
    expect(pickRenditionWidth(1281, 1)).toBe(1920);
  });

  it("显示宽或像素比缺失时退回最小可用档", () => {
    expect(pickRenditionWidth(0, 1)).toBe(320);
    expect(pickRenditionWidth(-10, 1)).toBe(320);
  });

  it("超过最大档位时取最大档", () => {
    const max = RENDITION_WIDTHS[RENDITION_WIDTHS.length - 1];
    expect(pickRenditionWidth(max * 4, 1)).toBe(max);
  });
});

describe("renditionCandidates", () => {
  it("给出整条阶梯，供 srcset 交给浏览器挑", () => {
    expect(renditionCandidates()).toEqual([...RENDITION_WIDTHS]);
  });

  it("返回的是副本，改动不会影响常量", () => {
    const first = renditionCandidates();
    first.push(1);
    expect(renditionCandidates()).toEqual([...RENDITION_WIDTHS]);
  });
});

describe("fitPreviewWidth", () => {
  // 舞台 1440×788 里放一张 3456 见方的照片：实际只显示 788 像素宽。
  const stage = { stageWidth: 1440, stageHeight: 788 };

  it("按图片在舞台里的真实显示宽取档，不按视口宽", () => {
    expect(
      fitPreviewWidth({
        ...stage,
        imageWidth: 3456,
        imageHeight: 3456,
        dpr: 1,
      }),
    ).toBe(1280);
  });

  it("高像素比屏幕按显示宽 × 像素比取档", () => {
    expect(
      fitPreviewWidth({
        ...stage,
        imageWidth: 3456,
        imageHeight: 3456,
        dpr: 2,
      }),
    ).toBe(1920);
  });

  it("竖图受高度约束时比视口窄得多", () => {
    // 1200×3046 在 1440×788 的舞台里只显示 310 像素宽。
    expect(
      fitPreviewWidth({
        ...stage,
        imageWidth: 1200,
        imageHeight: 3046,
        dpr: 1,
      }),
    ).toBe(320);
  });

  it("放大时向上一档取", () => {
    expect(
      fitPreviewWidth({
        ...stage,
        imageWidth: 3456,
        imageHeight: 3456,
        dpr: 1,
        zoom: 2,
      }),
    ).toBe(1920);
  });

  it("源图比舞台小的时候不放大，按原尺寸取档", () => {
    expect(
      fitPreviewWidth({ ...stage, imageWidth: 200, imageHeight: 200, dpr: 1 }),
    ).toBe(320);
  });

  it("图片原始尺寸未知时退回舞台宽", () => {
    expect(fitPreviewWidth({ ...stage, dpr: 1 })).toBe(1920);
  });
});
