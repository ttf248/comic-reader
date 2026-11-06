import { describe, expect, it } from "vitest";
import { mediaCountLabel, mediaCountParts } from "./mediaCount";

// 计数说明在多个地方出现（卡片、悬停预览、首屏专区、足迹时间线），
// 必须只有一套口径：照片说「张」，漫画说「页」，纯视频相册不能说「0 张」。
describe("mediaCount", () => {
  it("只有照片时只报照片数", () => {
    expect(mediaCountLabel({ imageCount: 12, videoCount: 0 })).toBe("12 张");
  });

  it("照片与视频都有时两个一起报", () => {
    expect(mediaCountLabel({ imageCount: 12, videoCount: 3 })).toBe(
      "12 张 · 3 个视频",
    );
  });

  it("只有视频时不写「0 张」，直接说有几个视频", () => {
    expect(mediaCountLabel({ imageCount: 0, videoCount: 2 })).toBe("2 个视频");
  });

  it("空相册报 0 张", () => {
    expect(mediaCountLabel({})).toBe("0 张");
  });

  it("单位跟着内容属性走：漫画说页", () => {
    expect(mediaCountLabel({ imageCount: 5, contentKind: "comic" })).toBe("5 页");
  });

  it("拆分出来的段落与整句一致", () => {
    const parts = mediaCountParts({ imageCount: 8, videoCount: 1 });
    expect(parts.lead).toBe("8 张");
    expect(parts.rest).toBe("1 个视频");
    expect(parts.title).toBe("8 张 + 1 个视频");
  });
});
