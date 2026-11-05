import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { libraryApi } from "../api/library";
import { useFavoritesByMode } from "./useFavoritesByMode";

vi.mock("../api/library", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/library")>();
  return {
    ...actual,
    libraryApi: { ...actual.libraryApi, queryNodes: vi.fn(), queryTags: vi.fn() },
  };
});

vi.mock("../api/prefs", () => ({
  favoritesApi: {
    list: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
  },
}));

const { favoritesApi } = await import("../api/prefs");

const photoAlbum = {
  id: "a_photo",
  kind: "album" as const,
  name: "照片相册",
  displayName: "照片相册",
  imageCount: 3,
  coverImages: [] as string[],
  contentKind: "photo" as const,
};

const comicAlbum = {
  id: "a_comic",
  kind: "album" as const,
  name: "漫画卷",
  displayName: "漫画卷",
  imageCount: 12,
  coverImages: [] as string[],
  contentKind: "comic" as const,
};

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(libraryApi.queryNodes).mockResolvedValue({
    revision: 1,
    items: [photoAlbum, comicAlbum],
    missing: [],
  } as never);
  // 「连载」只含漫画，「旅行」两侧都有。
  vi.mocked(libraryApi.queryTags).mockResolvedValue({
    ok: true,
    result: {
      revision: 1,
      items: [
        {
          tag: "连载",
          albumCount: 1,
          coverImages: [],
          photoAlbumCount: 0,
          comicAlbumCount: 1,
        },
        {
          tag: "旅行",
          albumCount: 2,
          coverImages: [],
          photoAlbumCount: 1,
          comicAlbumCount: 1,
        },
      ],
      missing: ["查无此标签"],
    },
  } as never);
});

describe("useFavoritesByMode", () => {
  it("只呈现当前这一侧的收藏，另一侧一条都不出现", async () => {
    vi.mocked(favoritesApi.list).mockResolvedValue({
      favorites: ["a_photo", "a_comic"],
    } as never);
    const { result } = renderHook(() => useFavoritesByMode("photo"), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.count).toBe(1));
    expect(result.current.cards.map((card) => card.title)).toEqual([
      "照片相册",
    ]);
  });

  // 只属于另一侧的标签收藏不是「失效」：它不能进清理名单，
  // 否则用户在照片工作台点一次「清理失效收藏」就把它真删了。
  it("只属于另一侧的标签收藏不算失效，不会被清理掉", async () => {
    vi.mocked(favoritesApi.list).mockResolvedValue({
      favorites: ["smart:连载", "smart:查无此标签"],
    } as never);
    const { result } = renderHook(() => useFavoritesByMode("photo"), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // 照片侧没有「连载」的作品：它不出现，但也绝不是失效。
    expect(result.current.cards).toHaveLength(0);
    expect(result.current.missingIds).toEqual(["smart:查无此标签"]);
  });

  it("两侧都有的标签在每一侧都出现", async () => {
    vi.mocked(favoritesApi.list).mockResolvedValue({
      favorites: ["smart:旅行"],
    } as never);
    const photo = renderHook(() => useFavoritesByMode("photo"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(photo.result.current.count).toBe(1));

    const comic = renderHook(() => useFavoritesByMode("comic"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(comic.result.current.count).toBe(1));
  });

  it("库里没有的收藏算失效，可以清理", async () => {
    vi.mocked(favoritesApi.list).mockResolvedValue({
      favorites: ["a_missing", "smart:查无此标签"],
    } as never);
    const { result } = renderHook(() => useFavoritesByMode("photo"), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.missingIds).toEqual([
      "a_missing",
      "smart:查无此标签",
    ]);
  });
});
