import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useUnreadAlbums } from "./useUnreadAlbums";
import { useFavorites } from "./useFavorites";

vi.mock("./useFavorites", () => ({
  useFavorites: vi.fn(),
}));
vi.mock("./useLibrary", () => ({
  useLibraryManifest: vi.fn(),
  useLibraryUnreadAlbums: vi.fn(),
}));

import { useLibraryManifest, useLibraryUnreadAlbums } from "./useLibrary";

const baseAlbum = (id: string, name: string, imageCount = 10) => ({
  id,
  kind: "album" as const,
  name,
  displayName: name,
  imageCount,
  videoCount: 0,
  mediaCount: imageCount,
  coverImage: id + "-cover",
  coverImages: [id + "-cover"],
  folderSize: 0,
  tags: [] as string[],
  modTime: "",
});

function seedUnread(
  albums: ReturnType<typeof baseAlbum>[],
  albumCount = albums.length,
) {
  vi.mocked(useLibraryUnreadAlbums).mockReturnValue({
    data: { revision: 1, items: albums, total: albums.length },
    isLoading: false,
  } as never);
  vi.mocked(useLibraryManifest).mockReturnValue({
    data: { manifest: { statistics: { albumCount } } },
    isLoading: false,
  } as never);
}

describe("useUnreadAlbums", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useFavorites).mockReturnValue({
      favorites: [],
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
      add: vi.fn(),
      remove: vi.fn(),
      toggle: vi.fn(),
    });
    seedUnread([]);
  });

  it("将服务端未读摘要直接转换为可标记已读的卡片", () => {
    seedUnread([baseAlbum("a_1", "A"), baseAlbum("a_2", "B")]);

    const { result } = renderHook(() => useUnreadAlbums());

    expect(result.current.count).toBe(2);
    expect(result.current.cards.map((card) => card.title)).toEqual(["A", "B"]);
    expect(result.current.cards[0]?.progress).toEqual({ index: 0, total: 10 });
  });

  it("全库总数来自 manifest，未读总数来自专用端点", () => {
    seedUnread([baseAlbum("a_1", "A")], 12);

    const { result } = renderHook(() => useUnreadAlbums());

    expect(result.current.count).toBe(1);
    expect(result.current.total).toBe(12);
  });

  it("在未读摘要上合并本地收藏状态", () => {
    seedUnread([baseAlbum("a_1", "A"), baseAlbum("a_2", "B")]);
    vi.mocked(useFavorites).mockReturnValue({
      favorites: ["a_2"],
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
      add: vi.fn(),
      remove: vi.fn(),
      toggle: vi.fn(),
    });

    const { result } = renderHook(() => useUnreadAlbums());

    expect(result.current.cards.map((card) => card.isFavorite)).toEqual([
      false,
      true,
    ]);
  });
});
