import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import Unread from "./Unread";
import { useFavorites } from "../hooks/useFavorites";
import { useSearchStore } from "../store/searchStore";
import { useAppModeStore } from "../store/appModeStore";

// 全部依赖外部 hook,组件本身不直接 fetch — mock 掉避免网络。
vi.mock("../hooks/useFavorites", () => ({
  useFavorites: vi.fn(),
}));
vi.mock("../hooks/useLibrary", () => ({
  useLibraryManifest: vi.fn(),
  useLibraryUnreadAlbums: vi.fn(),
}));
vi.mock("../hooks/useGalleryContextSync", () => ({
  useGalleryContextSync: vi.fn(),
}));
vi.mock("../components/common/ListFilterBar", () => ({
  ListFilterBar: () => <div data-testid="filter-bar" />,
}));
vi.mock("../components/album/AlbumGrid", () => ({
  default: ({ items }: { items: { id: string; title: string }[] }) => (
    <div data-testid="album-grid">
      {items.map((item) => (
        <span key={item.id}>{item.title}</span>
      ))}
    </div>
  ),
}));

import {
  useLibraryManifest,
  useLibraryUnreadAlbums,
} from "../hooks/useLibrary";
import type { LibraryNodeSummary } from "../api/library";

const baseAlbum = (
  id: string,
  name: string,
  imageCount = 10,
  extra: Partial<LibraryNodeSummary> = {},
) => ({
  id,
  kind: "album" as const,
  name,
  displayName: name,
  imageCount,
  videoCount: 0,
  mediaCount: imageCount,
  coverImage: id + "-cover",
  // 未读只属于漫画工作台：相册必须是漫画属性。
  contentKind: "comic" as const,
  coverImages: [id + "-cover"],
  folderSize: 0,
  tags: [] as string[],
  modTime: "",
  ...extra,
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
    data: {
      manifest: {
        statistics: {
          albumCount,
          comicAlbumCount: albumCount,
          photoAlbumCount: 0,
        },
      },
    },
    isLoading: false,
  } as never);
}

function renderUnread() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Unread />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Unread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useLibraryUnreadAlbums).mockReturnValue({
      data: { revision: 1, items: [], total: 0 },
      isLoading: false,
    } as never);
    vi.mocked(useLibraryManifest).mockReturnValue({
      data: {
        manifest: {
          statistics: {
            albumCount: 0,
            comicAlbumCount: 0,
            photoAlbumCount: 0,
          },
        },
      },
      isLoading: false,
    } as never);
    // 未读页只属于漫画工作台：照片模式会被重定向回主页。
    useAppModeStore.setState({ mode: "comic", ready: true });
    useSearchStore.getState().reset();
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
  });

  it("有未读时显示计数 + 随机按钮", async () => {
    seedUnread([baseAlbum("/a", "A"), baseAlbum("/b", "B")]);
    renderUnread();
    await waitFor(() => {
      // 页头 counter:还有 X 本没看。直接用 queryAllByText 扫整个 DOM,
      // 看有没有 <p> 包含 "还有" — 这样比函数 matcher 更稳,避免祖先元素
      // 也「碰巧」包含这段文本导致多个匹配。
      const headerHasCount = screen.queryAllByText(/还有/).length > 0;
      expect(headerHasCount).toBe(true);
    });
    expect(screen.getByText("随机一本未读")).toBeInTheDocument();
  });

  it("全部看完时显示「看完了」空态", async () => {
    seedUnread([], 1);
    renderUnread();
    await waitFor(() => {
      expect(screen.getByText(/全部看完啦/)).toBeInTheDocument();
    });
  });

  it("全库为空时引导去设置", async () => {
    // 不 seedUnread → 相册摘要为空
    renderUnread();
    await waitFor(() => {
      expect(screen.getByText(/尚未加载图像库/)).toBeInTheDocument();
    });
    expect(screen.getByText("去设置")).toBeInTheDocument();
  });

  it("最小图数变化后立即重新筛选", async () => {
    seedUnread([baseAlbum("/a", "A", 2), baseAlbum("/b", "B", 10)]);
    renderUnread();

    expect(await screen.findByText("A")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();

    act(() => useSearchStore.getState().setMinImageCount(5));

    await waitFor(() =>
      expect(screen.queryByText("A")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("B")).toBeInTheDocument();
  });

  it("散图相册按归属目录展示并能被目录名搜到", async () => {
    seedUnread([
      baseAlbum("/loose", "本目录媒体", 10, {
        virtual: true,
        location: "2020年",
      }),
      baseAlbum("/b", "B"),
    ]);
    renderUnread();

    // 卡片展示归属目录，而不是通用的类型名
    expect(await screen.findByText("2020年")).toBeInTheDocument();

    act(() => useSearchStore.getState().setQuery("2020年"));

    await waitFor(() =>
      expect(screen.queryByText("B")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("2020年")).toBeInTheDocument();
  });
});
