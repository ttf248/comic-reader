import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { LibraryNodeSummary } from "../api/library";
import { historyApi } from "../api/prefs";
import { useSearchStore } from "../store/searchStore";
import Home from "./Home";
import Album from "./Album";
import Favorites from "./Favorites";
import Recents from "./Recents";
import Unread from "./Unread";
import Tag from "./Tag";

const mocks = vi.hoisted(() => ({ items: [] as LibraryNodeSummary[] }));
vi.mock("../api/prefs", () => ({ historyApi: { list: vi.fn() } }));
vi.mock("../hooks/useFavorites", () => ({
  useFavorites: () => ({
    favorites: mocks.items.map((item) => item.id),
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    toggle: vi.fn(),
  }),
}));
vi.mock("../hooks/useScanSSE", () => ({
  useScanSSE: () => ({ isRunning: false }),
}));
vi.mock("../hooks/useGalleryContextSync", () => ({
  useGalleryContextSync: vi.fn(),
}));
vi.mock("../hooks/useImageActivity", () => ({
  useImageActivities: () => ({ data: {} }),
  useMarkAlbumRead: () => ({ mutateAsync: vi.fn() }),
  useMarkAlbumsRead: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../components/home/YearTimeline", () => ({ default: () => null }));
vi.mock("../components/home/HomeHeroes", () => ({
  ContinueReadingHero: () => null,
  UnreadHero: () => null,
}));
vi.mock("../components/album/AlbumGrid", () => ({
  default: ({ items }: { items: { id: string; title: string }[] }) => (
    <ol data-testid="sort-results">
      {items.map((item) => (
        <li key={item.id}>{item.title}</li>
      ))}
    </ol>
  ),
}));
vi.mock("../hooks/useLibrary", () => {
  const manifest = {
    revision: 1,
    scannedAt: "2026-10-31T00:00:00Z",
    roots: [{ id: "r_fixture", name: "素材", childCount: 3 }],
    statistics: {
      rootCount: 1,
      albumCount: 3,
      collectionCount: 0,
      tagCount: 0,
      warningCount: 0,
    },
  };
  const query = (items: LibraryNodeSummary[]) => ({
    data: { items, missing: [], total: items.length },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  });
  return {
    useLibraryOverview: () => ({
      manifest,
      nodes: mocks.items,
      tags: [],
      isLoading: false,
      isError: false,
    }),
    useLibraryDashboard: () => ({
      data: { dashboard: { unread: [], unreadCount: 0, inProgress: [] } },
      isLoading: false,
    }),
    useLibraryManifest: () => ({ data: { manifest }, isLoading: false }),
    useLibraryUnreadAlbums: () => query(mocks.items),
    useLibraryChildren: () => query(mocks.items),
    useTagAlbums: () => query(mocks.items),
    useLibraryTags: () => ({ data: { items: [] }, isLoading: false }),
    useLibraryNodes: (ids: string[]) =>
      query(
        ids.includes("c_root")
          ? [
              {
                id: "c_root",
                kind: "collection",
                name: "集合",
                displayName: "集合",
                coverImages: [],
              },
            ]
          : mocks.items,
      ),
    useAlbumMedia: () => ({ data: undefined, isLoading: false }),
  };
});

const pages = [
  ["主页", "/"],
  ["集合", "/albums/c_root"],
  ["收藏", "/favorites"],
  ["最近", "/recents"],
  ["未读", "/unread"],
  ["标签", "/tags/测试"],
] as const;
const expected = ["M新相册", "A中相册", "Z旧相册"];

beforeEach(() => {
  vi.clearAllMocks();
  useSearchStore.getState().reset();
  useSearchStore.getState().setSortBy("recent");
  mocks.items = [
    {
      id: "a_old",
      name: "Z旧相册",
      modTime: "2022-01-01T00:00:00Z",
      date: "2030-01-01T00:00:00Z",
    },
    {
      id: "a_middle",
      name: "A中相册",
      modTime: "2023-01-01T00:00:00Z",
      date: "2025-01-01T00:00:00Z",
    },
    {
      id: "a_new",
      name: "M新相册",
      modTime: "2024-01-01T00:00:00Z",
      date: "2000-01-01T00:00:00Z",
    },
  ].map((item) => ({
    ...item,
    kind: "album",
    displayName: item.name,
    imageCount: 3,
    coverImages: [],
  }));
  vi.mocked(historyApi.list).mockResolvedValue({
    history: mocks.items.map((item) => ({
      albumId: item.id,
      name: item.name,
      imageCount: 3,
      openedAt: "2026-10-31T00:00:00Z",
    })),
  });
});

function renderPage(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/albums/*" element={<Album />} />
          <Route path="/favorites" element={<Favorites />} />
          <Route path="/recents" element={<Recents />} />
          <Route path="/unread" element={<Unread />} />
          <Route path="/tags/*" element={<Tag />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it.each(pages)(
  "%s 最近改按修改时间倒序，不按名称、业务日期或访问顺序",
  async (_name, path) => {
    renderPage(path);
    await waitFor(() =>
      expect(
        within(screen.getByTestId("sort-results"))
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual(expected),
    );
  },
);

it.each(pages)(
  "%s 把缺失及无效修改时间放在最后并按名称稳定排序",
  async (_name, path) => {
    mocks.items[0].modTime = undefined;
    mocks.items[1].modTime = "invalid-date";
    renderPage(path);
    await waitFor(() =>
      expect(
        within(screen.getByTestId("sort-results"))
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual(expected),
    );
  },
);
