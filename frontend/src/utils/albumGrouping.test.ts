import { describe, it, expect } from "vitest";
import {
  extractYear,
  groupAlbumsAndCollectionsByYear,
  type AlbumLike,
  type CollectionLike,
} from "./albumGrouping";

describe("extractYear", () => {
  it("parses a 4-digit year in 1900-2100 range", () => {
    expect(extractYear("2011年")).toBe(2011);
    expect(extractYear("2024年")).toBe(2024);
  });

  it("returns null when no 4-digit year", () => {
    expect(extractYear("B站")).toBeNull();
    expect(extractYear("微信下载")).toBeNull();
    expect(extractYear("")).toBeNull();
  });

  it("rejects 4-digit numbers outside the sensible year range", () => {
    expect(extractYear("1234 张")).toBeNull();
    expect(extractYear("9999年")).toBeNull();
  });
});

describe("groupAlbumsAndCollectionsByYear", () => {
  it("空节点返回空数组", () => {
    expect(groupAlbumsAndCollectionsByYear([])).toEqual([]);
  });

  it("groups albums by parsed year, descending, with 其他 last", () => {
    const albums = [
      mk("2011年", 102, 0),
      mk("2024年", 1193, 34),
      mk("B站", 0, 2),
      mk("2020年", 384, 19),
      mk("2024年二班", 50, 0), // 也能解析为 2024
    ];
    const g = groupAlbumsAndCollectionsByYear(albums);
    expect(g.map((x) => x.label)).toEqual(["2024", "2020", "2011", "其他"]);
    expect(g[0].albums.length).toBe(2);
    expect(g[0].totalFiles).toBe(1193 + 34 + 50 + 0);
  });

  it("sums imageCount + videoCount into totalFiles, splits imageTotal / videoTotal", () => {
    const g = groupAlbumsAndCollectionsByYear([
      mk("2024年", 100, 5),
      mk("2024年游戏", 8, 6),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].totalFiles).toBe(119); // 105 + 14
    expect(g[0].imageTotal).toBe(108); // 100 + 8
    expect(g[0].videoTotal).toBe(11); // 5 + 6
  });

  it("exposes up to 4 cover paths for the year card preview, filtering empties", () => {
    const g = groupAlbumsAndCollectionsByYear([
      mk("2024年A", 50, 0), // coverImage '' (mk 默认)
      mk("2024年B", 30, 0),
      mk("2024年C", 20, 0),
      mk("2024年D", 10, 0),
      mk("2024年E", 5, 0),
    ]);
    expect(g).toHaveLength(1);
    // mk() 默认 coverImage=''，所以 coverPreviewPaths 应为空数组
    expect(g[0].coverPreviewPaths).toEqual([]);
  });

  it("sorts albums within a year by count descending", () => {
    const g = groupAlbumsAndCollectionsByYear([
      mk("2024年A", 10, 0),
      mk("2024年B", 100, 0),
      mk("2024年C", 50, 0),
    ]);
    expect(g[0].albums.map((a) => a.title)).toEqual([
      "2024年B",
      "2024年C",
      "2024年A",
    ]);
  });

  it("non-year albums land in 其他 bucket, ordered after years", () => {
    const g = groupAlbumsAndCollectionsByYear([
      mk("微信下载", 159, 18),
      mk("2023年", 100, 0),
    ]);
    expect(g.map((x) => x.label)).toEqual(["2023", "其他"]);
    expect(g[1].albums[0].title).toBe("微信下载");
  });

  // 用户反馈「我需要保留子相册导航」:Collection 下的子相册按所属 Collection
  // 的年份归桶,而不是按子相册自己的名字。否则 10.1国庆 没有 4 位年份,会
  // 被丢到「其他」桶,2024年 主页时间线就看不到 10.1国庆 这种子相册了。
  it("Collection 下的子相册按 Collection 年份归桶,即使子相册名无 4 位年份", () => {
    const collections: CollectionLike[] = [
      {
        path: "E:\\存照\\2024年",
        name: "2024年",
        albums: [
          mk("散图", 1227, 0, "E:\\存照\\2024年"),
          mk("10.1国庆", 2, 0, "E:\\存照\\2024年\\10.1国庆"),
          mk("12.13", 1, 0, "E:\\存照\\2024年\\12.13"),
        ],
        albumCount: 3,
        contentKind: "photo",
      },
    ];
    const g = groupAlbumsAndCollectionsByYear([], collections);
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe("2024");
    // 散图 + 10.1国庆 + 12.13 全部归到 2024 桶
    expect(g[0].albums).toHaveLength(1); // Collection 自身一张卡
    expect(g[0].imageTotal).toBe(1227 + 2 + 1);
  });

  it("嵌套子集合(深 5 层)里的子相册也按最上层 Collection 年份归桶,计数含整个子树", () => {
    const collections: CollectionLike[] = [
      {
        path: "E:\\存照\\2024年",
        name: "2024年",
        albumCount: 0,
        contentKind: "photo" as const,
        albums: [mk("散图", 100, 0, "E:\\存照\\2024年")],
        collections: [
          {
            path: "E:\\存照\\2024年\\夏威夷-度假",
            name: "夏威夷-度假",
            albumCount: 0,
            contentKind: "photo" as const,
            albums: [],
            collections: [
              {
                path: "E:\\存照\\2024年\\夏威夷-度假\\相册",
                name: "相册",
                albumCount: 0,
                contentKind: "photo" as const,
                albums: [],
                collections: [
                  {
                    path: "E:\\存照\\2024年\\夏威夷-度假\\相册\\作品",
                    name: "作品",
                    contentKind: "photo" as const,
                    albums: [
                      mk(
                        "散图",
                        5,
                        0,
                        "E:\\存照\\2024年\\夏威夷-度假\\相册\\作品",
                      ),
                      mk(
                        "甜片",
                        1,
                        0,
                        "E:\\存照\\2024年\\夏威夷-度假\\相册\\作品\\甜片",
                      ),
                    ],
                    albumCount: 2,
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const g = groupAlbumsAndCollectionsByYear([], collections);
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe("2024");
    // imageTotal 应含 5 层子树里的全部图:100 + 5 + 1 = 106
    expect(g[0].imageTotal).toBe(106);
  });

  it("分页集合摘要直接使用服务端聚合计数与拼贴封面", () => {
    const groups = groupAlbumsAndCollectionsByYear(
      [],
      [
        {
          path: "c_2025",
          name: "2025",
          albumCount: 12,
          imageCount: 320,
          videoCount: 8,
          coverImage: "f_primary",
          coverImages: ["f_primary", "f_second"],
          contentKind: "photo",
        },
      ],
    );

    expect(groups[0].imageTotal).toBe(320);
    expect(groups[0].videoTotal).toBe(8);
    expect(groups[0].albums[0].count).toBe(12);
    expect(groups[0].albums[0].covers).toEqual(["f_primary", "f_second"]);
  });
});

function mk(
  name: string,
  imageCount: number,
  videoCount: number,
  path?: string,
): AlbumLike {
  return {
    path: path ?? `E:\\存照\\${name}`,
    name,
    coverImage: "",
    imageCount,
    videoCount,
    contentKind: "photo" as const,
  };
}
