import { describe, expect, it } from "vitest";
import type { LibraryNodeSummary, LibraryTagSummary } from "../api/library";
import { libraryOverviewCards, nodeSummaryToCard, cardMatchesQuery } from "./libraryCard";

function node(
  id: string,
  kind: LibraryNodeSummary["kind"],
  extra: Partial<LibraryNodeSummary> = {},
): LibraryNodeSummary {
  return {
    id,
    kind,
    name: id,
    displayName: id,
    coverImages: [],
    contentKind: "photo",
    ...extra,
  };
}

describe("libraryCard", () => {
  it("相册卡片以全部标签作为副标题", () => {
    const card = nodeSummaryToCard(
      node("a_trip", "album", { tags: ["旅行", "2025"] }),
    );

    expect(card.subtitle).toBe("旅行 · 2025");
  });

  it("集合卡片使用聚合数量与拼贴封面", () => {
    const card = nodeSummaryToCard(
      node("c_year", "collection", {
        albumCount: 12,
        coverImage: "f_cover",
        coverImages: ["f_cover", "f_second"],
      }),
    );

    expect(card.count).toBe(12);
    expect(card.coverPath).toBe("f_cover");
    expect(card.covers).toEqual(["f_cover", "f_second"]);
  });

  it("首页隐藏虚拟相册并追加标签卡片", () => {
    const tags: LibraryTagSummary[] = [
      {
        tag: "旅行",
        albumCount: 3,
        coverImage: "f_tag",
        coverImages: ["f_tag"],
      },
    ];
    const cards = libraryOverviewCards(
      [
        node("a_loose", "album", { virtual: true }),
        node("c_root", "collection", { albumCount: 1 }),
      ],
      tags,
      "photo",
    );

    expect(cards.map((card) => card.id)).toEqual(["c:c_root", "s:旅行"]);
  });

  it("散图卡片用归属目录做标题并把类型降级为副标题", () => {
    const card = nodeSummaryToCard(
      node("a_loose", "album", {
        name: "本目录媒体",
        displayName: "本目录媒体",
        virtual: true,
        location: "2020年",
      }),
    );

    expect(card.displayTitle).toBe("2020年");
    expect(card.subtitle).toBe("散图");
    // 标题与搜索、排序共用：都用归属目录，否则列表里只能搜到类型词。
    expect(card.title).toBe("2020年");
  });

  it("散图缺少归属目录时回退到原展示名", () => {
    const card = nodeSummaryToCard(
      node("a_loose", "album", {
        name: "本目录媒体",
        displayName: "本目录媒体",
        virtual: true,
      }),
    );

    expect(card.displayTitle).toBe("本目录媒体");
  });

  it("列表搜索能按散图的归属目录命中", () => {
    const card = nodeSummaryToCard(
      node("a_loose", "album", {
        name: "本目录媒体",
        displayName: "本目录媒体",
        virtual: true,
        location: "2020年",
      }),
    );

    expect(cardMatchesQuery(card, "2020年")).toBe(true);
    expect(cardMatchesQuery(card, "2020")).toBe(true);
    expect(cardMatchesQuery(card, "散图")).toBe(true);
    expect(cardMatchesQuery(card, "1999")).toBe(false);
    expect(cardMatchesQuery(card, "  ")).toBe(true);
  });
});
