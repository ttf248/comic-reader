import { describe, expect, it } from "vitest";
import {
  RENDITION_WIDTHS,
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
