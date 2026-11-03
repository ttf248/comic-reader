import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { LibraryNodeSummary } from "../api/library";
import { historyApi } from "../api/prefs";
import { useSearchStore } from "../store/searchStore";
import { useUIStore } from "../store/uiStore";
import Home from "./Home";

const mocks = vi.hoisted(() => ({
  items: [] as LibraryNodeSummary[],
  inProgress: true,
}));

vi.mock("../api/prefs", () => ({ historyApi: { list: vi.fn() } }));
vi.mock("../hooks/useFavorites", () => ({
  useFavorites: () => ({
    favorites: [],
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
// 英雄区与时间线用占位元素代替：这里只关心「筛选条相对它们的位置」。
vi.mock("../components/home/YearTimeline", () => ({
  default: () => <div data-testid="year-timeline" />,
}));
vi.mock("../components/home/HomeHeroes", () => ({
  // rightSlot 是真实组件的右栏（只有一本在读时，首页把「未读」塞进去），
  // 占位组件也要渲染它，否则 DOM 顺序断言会漏掉未读区的位置。
  ContinueReadingHero: ({ rightSlot }: { rightSlot?: React.ReactNode }) => (
    <div data-testid="continue-hero">{rightSlot}</div>
  ),
  UnreadHero: () => <div data-testid="unread-hero" />,
}));
vi.mock("../components/album/AlbumGrid", () => ({
  default: ({ items }: { items: { id: string; title: string }[] }) => (
    <ol data-testid="album-grid">
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
    roots: [{ id: "r_fixture", name: "素材", childCount: 1 }],
    statistics: {
      rootCount: 1,
      albumCount: 1,
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
      data: {
        dashboard: {
          unread: [mocks.items[0]],
          unreadCount: 1,
          inProgress: mocks.inProgress
            ? mocks.items.map((album) => ({
                album,
                pageIndex: 1,
                pageCount: 3,
              }))
            : [],
        },
      },
      isLoading: false,
    }),
    useLibraryManifest: () => ({ data: { manifest }, isLoading: false }),
    useLibraryUnreadAlbums: () => query(mocks.items),
    useLibraryChildren: () => query(mocks.items),
    useTagAlbums: () => query(mocks.items),
    useLibraryTags: () => ({ data: { items: [] }, isLoading: false }),
    useLibraryNodes: () => query(mocks.items),
    useAlbumMedia: () => ({ data: undefined, isLoading: false }),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  useUIStore.setState({ viewMode: "grid" });
  useSearchStore.getState().reset();
  mocks.inProgress = true;
  vi.mocked(historyApi.list).mockResolvedValue({ history: [] });
  mocks.items = [
    {
      id: "a_1",
      kind: "album",
      name: "2023年测试相册",
      displayName: "2023年测试相册",
      imageCount: 3,
      coverImages: [],
      modTime: "2024-01-01T00:00:00Z",
      date: "2024-01-01T00:00:00Z",
    },
  ];
});

function renderHome() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<Home />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

it("筛选条紧贴在「全部图像」网格上方，不被英雄区 / 时间线隔开", async () => {
  renderHome();

  await waitFor(() => expect(screen.getByTestId("album-grid")).toBeTruthy());

  const heading = screen.getByText("全部图像");
  const chip = screen.getByRole("button", { name: /文件夹/ });
  const grid = screen.getByTestId("album-grid");

  // 1) 筛选条排在「全部图像」标题之后、网格之前。
  expect(
    heading.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    chip.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  // 2) 筛选条和网格同属「全部图像」这个 section —— 控件必须贴着它控制的内容。
  const section = heading.closest("section");
  expect(section).toBeTruthy();
  expect(section?.contains(chip)).toBe(true);
  expect(section?.contains(grid)).toBe(true);

  // 3) 控件不再排在未读 / 继续阅读 / 时间线之前（它们离网格有两千多像素）。
  for (const id of ["unread-hero", "continue-hero", "year-timeline"]) {
    const hero = screen.getByTestId(id);
    expect(
      hero.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
});

it("只有一本在读时阅读区和发现区独立呈现", async () => {
  renderHome();
  await waitFor(() => expect(screen.getByTestId("album-grid")).toBeTruthy());
  // 阅读进度与发现推荐是独立区块，避免重复陈列。
  expect(
    screen
      .getByTestId("continue-hero")
      .contains(screen.getByTestId("unread-hero")),
  ).toBe(false);
});

it("多本在读时保留独立发现区且未读预览不重复", async () => {
  mocks.items = [
    ...mocks.items,
    {
      id: "a_2",
      kind: "album" as const,
      name: "2024年第二本",
      displayName: "2024年第二本",
      imageCount: 3,
      coverImages: [],
      modTime: "2024-01-02T00:00:00Z",
      date: "2024-01-02T00:00:00Z",
    },
  ];
  renderHome();
  await waitFor(() => expect(screen.getByTestId("album-grid")).toBeTruthy());
  // 不同在读数量都不改变发现区的归属。
  expect(
    screen
      .getByTestId("continue-hero")
      .contains(screen.getByTestId("unread-hero")),
  ).toBe(false);
  // 未读预览始终只出现一次。
  expect(screen.getAllByTestId("unread-hero")).toHaveLength(1);
});

it("没有在读相册时未读区独立成块（没有舞台可挂）", async () => {
  mocks.inProgress = false;
  renderHome();
  await waitFor(() => expect(screen.getByTestId("album-grid")).toBeTruthy());
  // 没有在读就没有「继续阅读」舞台，未读回到独立区块，
  // 否则首页第一屏只剩一个推荐货架，没有"接着读"的主入口。
  expect(screen.queryByTestId("continue-hero")).toBeNull();
  expect(screen.getByTestId("unread-hero")).toBeTruthy();
});
