import { describe, expect, it } from "vitest";
import { entryReaderUrl, type GalleryContextEntry } from "./galleryContext";

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
    expect(url).toBe("/read/a_1?index=0&name=%E6%9F%90%E6%9C%AC%E7%9B%B8%E5%86%8C");
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
