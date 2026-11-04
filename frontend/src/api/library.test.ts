import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIBRARY_NODE_BATCH_LIMIT,
  LibraryRevisionChangedError,
  libraryApi,
} from "./library";

function jsonResponse(body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("libraryApi", () => {
  it("合并游标分页并保持同一 revision", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        jsonResponse({
          ok: true,
          page: {
            revision: 7,
            items: [{ tag: "A", albumCount: 1, coverImages: [] }],
            total: 2,
            nextCursor: "next-page",
          },
        }),
      )
      .mockImplementationOnce(() =>
        jsonResponse({
          ok: true,
          page: {
            revision: 7,
            items: [{ tag: "B", albumCount: 1, coverImages: [] }],
            total: 2,
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await libraryApi.allTags("all");

    expect(result.items.map((item) => item.tag)).toEqual(["A", "B"]);
    expect(result.revision).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("cursor=next-page");
  });

  it("批量解析会按服务端上限拆分请求", async () => {
    const ids = Array.from(
      { length: LIBRARY_NODE_BATCH_LIMIT + 1 },
      (_, index) => `a_${index}`,
    );
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { ids: string[] };
      return jsonResponse({
        ok: true,
        result: { revision: 9, items: [], missing: body.ids },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await libraryApi.queryNodes(ids);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.missing).toEqual(ids);
    expect(result.revision).toBe(9);
  });

  it("合并服务端筛选后的未读分页", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        jsonResponse({
          ok: true,
          page: {
            revision: 8,
            items: [
              {
                id: "a_1",
                kind: "album",
                name: "未读一",
                displayName: "未读一",
                coverImages: [],
              },
            ],
            total: 2,
            nextCursor: "next-unread-page",
          },
        }),
      )
      .mockImplementationOnce(() =>
        jsonResponse({
          ok: true,
          page: {
            revision: 8,
            items: [
              {
                id: "a_2",
                kind: "album",
                name: "未读二",
                displayName: "未读二",
                coverImages: [],
              },
            ],
            total: 2,
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await libraryApi.allUnreadAlbums("all");

    expect(result.items.map((item) => item.id)).toEqual(["a_1", "a_2"]);
    expect(result.total).toBe(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/api/library/unread",
    );
  });

  it("拒绝合并跨 revision 的分页结果", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        jsonResponse({
          ok: true,
          page: {
            revision: 10,
            items: [],
            total: 1,
            nextCursor: "next-page",
          },
        }),
      )
      .mockImplementationOnce(() =>
        jsonResponse({
          ok: true,
          page: { revision: 11, items: [], total: 1 },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(libraryApi.allUnreadAlbums("all")).rejects.toBeInstanceOf(
      LibraryRevisionChangedError,
    );
  });

  it("为常驻导航和首页请求轻量阅读数据", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        jsonResponse({
          ok: true,
          summary: { revision: 12, albumCount: 320, unreadCount: 18 },
        }),
      )
      .mockImplementationOnce(() =>
        jsonResponse({
          ok: true,
          dashboard: {
            revision: 12,
            albumCount: 320,
            unreadCount: 18,
            unread: [],
            inProgress: [],
          },
        }),
      )
      .mockImplementationOnce(() =>
        jsonResponse({
          ok: true,
          revision: 12,
          album: {
            id: "a_random",
            kind: "album",
            name: "随机相册",
            displayName: "随机相册",
            coverImages: [],
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const [summary, dashboard, random] = await Promise.all([
      libraryApi.activitySummary("all"),
      libraryApi.dashboard("all"),
      libraryApi.randomAlbum("all", "unread"),
    ]);

    expect(summary.summary).toMatchObject({ albumCount: 320, unreadCount: 18 });
    expect(dashboard.dashboard).toMatchObject({
      albumCount: 320,
      unreadCount: 18,
    });
    expect(random.album.id).toBe("a_random");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/api/library/activity-summary",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "/api/library/dashboard",
    );
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
      "/api/albums/random?scope=unread",
    );
  });
});
