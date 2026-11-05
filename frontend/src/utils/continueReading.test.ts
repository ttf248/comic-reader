import { describe, it, expect } from "vitest";
import {
  continueReadingTarget,
  readingPercent,
} from "./continueReading";
import type { CardData } from "../components/album/AlbumGrid";

function card(over: Partial<CardData> = {}): CardData {
  return {
    id: "a:1",
    variant: "album",
    title: "某本漫画",
    count: 20,
    imageCount: 20,
    videoCount: 0,
    coverPath: "f_1/cover.jpg",
    to: "/albums/" + encodeURIComponent("E:/存照/某本漫画"),
    progress: { index: 5, total: 20 },
    contentKind: "comic",
    ...over,
  };
}

describe("continueReadingTarget", () => {
  it("漫画相册跳到上次读到的页，并带上相册名", () => {
    const target = continueReadingTarget(card());
    const url = new URL(target, "http://localhost");
    expect(url.pathname).toBe("/comic/read/" + encodeURIComponent("E:/存照/某本漫画"));
    expect(url.searchParams.get("index")).toBe("5");
    expect(url.searchParams.get("name")).toBe("某本漫画");
  });

  it("照片相册回到照片墙，不进阅读器", () => {
    const target = continueReadingTarget(
      card({ contentKind: "photo", title: "某本相册" }),
    );
    expect(target).toBe("/albums/" + encodeURIComponent("E:/存照/某本漫画"));
  });

  it("没有标类型的相册按照片处理", () => {
    const target = continueReadingTarget(card({ contentKind: undefined }));
    expect(target).toBe("/albums/" + encodeURIComponent("E:/存照/某本漫画"));
  });

  it("图片相册走 image 类型", () => {
    const url = new URL(continueReadingTarget(card()), "http://localhost");
    expect(url.searchParams.get("type")).toBe("image");
  });

  it("纯视频相册走 video 类型（否则阅读器会显示「这个文件夹没有图片」）", () => {
    const url = new URL(
      continueReadingTarget(card({ imageCount: 0, videoCount: 3 })),
      "http://localhost",
    );
    expect(url.searchParams.get("type")).toBe("video");
  });

  it("混合相册（既有图又有视频）走 image 类型", () => {
    const url = new URL(
      continueReadingTarget(card({ imageCount: 2, videoCount: 1 })),
      "http://localhost",
    );
    expect(url.searchParams.get("type")).toBe("image");
  });

  it("集合 / 智能视图不做画廊跳转，直接回到它自己的页面", () => {
    const target = continueReadingTarget(
      card({ variant: "collection", to: "/albums/collection-1" }),
    );
    expect(target).toBe("/albums/collection-1");
  });

  it("没有进度时从第 0 页开始", () => {
    const url = new URL(
      continueReadingTarget(card({ progress: undefined })),
      "http://localhost",
    );
    expect(url.searchParams.get("index")).toBe("0");
  });
});

describe("readingPercent", () => {
  it("按已翻页数 / 可翻页数计算", () => {
    // 20 页读到第 6 页（index 5）→ 5/19
    expect(readingPercent({ index: 5, total: 20 })).toBe(26);
  });

  it("读完时是 100%", () => {
    expect(readingPercent({ index: 19, total: 20 })).toBe(100);
  });

  it("只有一页时没有进度可言", () => {
    expect(readingPercent({ index: 0, total: 1 })).toBe(0);
  });

  it("缺进度时是 0", () => {
    expect(readingPercent(undefined)).toBe(0);
  });
});
