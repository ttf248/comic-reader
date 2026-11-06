import { describe, expect, it } from "vitest";
import {
  collectionUnit,
  coverRatioForMode,
  mediaUnit,
  workbenchCopy,
} from "./workbench";

// 两侧词表是「照片工作台 / 漫画工作台」唯一的措辞来源。
// 共享组件从这张表取词，测试守住「两侧不串味」这条底线。
describe("工作台词表", () => {
  it("照片侧用浏览、张、本，漫画侧用阅读、页、卷", () => {
    expect(workbenchCopy("photo")).toMatchObject({
      mediaUnit: "张",
      lastSeenVerb: "浏览",
      neverSeenLabel: "尚未浏览",
      collectionUnit: "本",
    });
    expect(workbenchCopy("comic")).toMatchObject({
      mediaUnit: "页",
      lastSeenVerb: "阅读",
      neverSeenLabel: "尚未阅读",
      collectionUnit: "卷",
    });
  });

  it("计数单位助手返回的与词表一致", () => {
    expect(collectionUnit("photo")).toBe("本");
    expect(collectionUnit("comic")).toBe("卷");
    expect(mediaUnit("photo")).toBe("张");
    expect(mediaUnit("comic")).toBe("页");
  });

  it("封面画幅分侧：照片方形，漫画竖版", () => {
    expect(coverRatioForMode("photo")).toBe("1/1");
    // 漫画侧用 4:5 而不是 2/3：竖版仍与照片的方形分得开，
    // 却不必把横向素材裁掉一半以上。
    expect(coverRatioForMode("comic")).toBe("4/5");
  });

  it("两侧的随机动作名各自成套", () => {
    expect(workbenchCopy("photo").randomLabel).toBe("随机翻翻");
    expect(workbenchCopy("comic").randomLabel).toBe("随机一本");
  });
});
