import { describe, expect, it } from "vitest";
import {
  entryDisplayName,
  entryReaderUrl,
  type GalleryContextEntry,
} from "./galleryContext";

function entry(overrides: Partial<GalleryContextEntry> = {}): GalleryContextEntry {
  return {
    key: "a_1",
    to: "/albums/a_1",
    name: "某本相册",
    ...overrides,
  };
}

describe("entryReaderUrl", () => {
  it("漫画相册有阅读器入口", () => {
    const url = entryReaderUrl(entry({ contentKind: "comic" }));
    expect(url).toBe("/comic/read/a_1?index=0&name=%E6%9F%90%E6%9C%AC%E7%9B%B8%E5%86%8C");
  });

  it("照片相册没有阅读器入口：照片要进照片墙", () => {
    expect(entryReaderUrl(entry({ contentKind: "photo" }))).toBeNull();
  });

  it("集合没有阅读器入口", () => {
    expect(
      entryReaderUrl(entry({ kind: "collection", contentKind: "comic" })),
    ).toBeNull();
  });
});

// 漫画的卷名只写「第1卷」：跳本提示与跨卷箭头要说得清这一卷属于哪部。
describe("entryDisplayName", () => {
  it("有所属作品时把作品名补在卷名前面", () => {
    expect(
      entryDisplayName(entry({ name: "第1卷", parentName: "星海漫步" })),
    ).toBe("星海漫步 · 第1卷");
  });

  it("没有所属作品时只写卷名", () => {
    expect(entryDisplayName(entry({ name: "第1卷" }))).toBe("第1卷");
  });

  it("作品名与卷名相同时不重复", () => {
    expect(
      entryDisplayName(entry({ name: "星海漫步", parentName: "星海漫步" })),
    ).toBe("星海漫步");
  });
});
