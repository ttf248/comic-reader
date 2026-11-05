import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { favoritesApi, historyApi } from "../api/prefs";
import { libraryApi } from "../api/library";
import {
  useLibraryDashboard,
  useLibraryNodes,
  useLibraryRecentAlbums,
} from "../hooks/useLibrary";
import { useSearchStore } from "../store/searchStore";
import Favorites from "./Favorites";

vi.mock("../api/prefs", () => ({
  favoritesApi: { list: vi.fn(), add: vi.fn(), remove: vi.fn() },
  historyApi: { list: vi.fn() },
}));
vi.mock("../hooks/useLibrary", () => ({
  useLibraryNodes: vi.fn(),
  useLibraryDashboard: vi.fn(),
  useLibraryRecentAlbums: vi.fn(),
}));
// 智能标签按名解析：接口同时给出两侧的册数，客户端据此区分
// 「标签失效了」与「它只属于另一侧」。
vi.mock("../api/library", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/library")>();
  return {
    ...actual,
    libraryApi: { ...actual.libraryApi, queryTags: vi.fn() },
  };
});
vi.mock("../hooks/useImageActivity", () => ({
  useImageActivities: () => ({ data: {} }),
  usePhotoActivities: () => ({ data: {} }),
}));
vi.mock("../hooks/useGalleryContextSync", () => ({
  useGalleryContextSync: vi.fn(),
}));
vi.mock("../components/album/AlbumGrid", () => ({
  default: ({ items }: { items: { title: string }[] }) => (
    <div>
      {items.map((item) => (
        <span key={item.title}>{item.title}</span>
      ))}
    </div>
  ),
}));

const node = {
  id: "a_trip",
  kind: "album",
  name: "春游相册",
  displayName: "春游相册",
  imageCount: 3,
  coverImages: [],
  // 工作台默认是照片：相册要带上用途，否则会被模式过滤掉。
  contentKind: "photo",
};
const clientForTest = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });
function renderFavorites(client = clientForTest()) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Favorites />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useSearchStore.getState().reset();
  vi.mocked(favoritesApi.list).mockResolvedValue({ favorites: [node.id] });
  vi.mocked(historyApi.list).mockResolvedValue({ history: [] });
  vi.mocked(useLibraryNodes).mockReturnValue({
    data: { items: [node], missing: [] },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  } as never);
  vi.mocked(libraryApi.queryTags).mockResolvedValue({
    ok: true,
    result: {
      revision: 1,
      items: [
        {
          tag: "旅行",
          albumCount: 1,
          coverImages: [],
          photoAlbumCount: 1,
          comicAlbumCount: 0,
        },
      ],
      missing: [],
    },
  });
  vi.mocked(useLibraryRecentAlbums).mockReturnValue({
    data: { page: { revision: 1, items: [], total: 0 } },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  } as never);
  vi.mocked(useLibraryDashboard).mockReturnValue({
    data: { dashboard: { unread: [], inProgress: [] } },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  } as never);
});

it("收藏请求未完成时不显示没有收藏", async () => {
  let resolveList: (value: { favorites: string[] }) => void = () => {};
  vi.mocked(favoritesApi.list).mockReturnValue(
    new Promise((resolve) => {
      resolveList = resolve;
    }),
  );
  renderFavorites();
  expect(screen.getByRole("status")).toHaveTextContent("正在加载收藏");
  expect(screen.queryByText("还没有收藏照片")).not.toBeInTheDocument();
  await act(async () => {
    resolveList({ favorites: [] });
  });
  expect(await screen.findByText("还没有收藏照片")).toBeInTheDocument();
});

it("收藏读取失败提供重试，恢复后展示收藏", async () => {
  vi.mocked(favoritesApi.list).mockRejectedValueOnce(new Error("offline"));
  renderFavorites();
  expect(await screen.findByRole("alert")).toHaveTextContent("收藏加载失败");
  expect(screen.queryByText("还没有收藏照片")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  expect(await screen.findByText("春游相册")).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
});

it.each(["nodes", "tags"] as const)(
  "%s 读取失败不误报筛选无结果",
  async (kind) => {
    const retry = vi.fn();
    const failed = {
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch: retry,
    };
    if (kind === "nodes")
      vi.mocked(useLibraryNodes).mockReturnValue(failed as never);
    else {
      vi.mocked(favoritesApi.list).mockResolvedValue({
        favorites: ["smart:旅行"],
      });
      vi.mocked(libraryApi.queryTags).mockRejectedValue(new Error("offline"));
    }
    renderFavorites();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "收藏详情加载失败",
    );
    expect(screen.queryByText("没有匹配的收藏")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    if (kind === "nodes") {
      expect(retry).toHaveBeenCalledTimes(1);
    } else {
      // 标签走的是按名解析接口：重试再打一次它，收藏列表本身不动。
      expect(libraryApi.queryTags).toHaveBeenCalledTimes(2);
    }
    expect(favoritesApi.list).toHaveBeenCalledTimes(1);
  },
);

it("标签查询失败仍保留已经解析的相册收藏", async () => {
  vi.mocked(favoritesApi.list).mockResolvedValue({
    favorites: [node.id, "smart:旅行"],
  });
  vi.mocked(libraryApi.queryTags).mockRejectedValue(new Error("offline"));
  renderFavorites();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "仍显示已加载的收藏",
  );
  expect(screen.getByText("春游相册")).toBeInTheDocument();
});

it("后台刷新收藏失败时保留缓存卡片", async () => {
  const client = clientForTest();
  client.setQueryData(["favorites"], { favorites: [node.id] });
  vi.mocked(favoritesApi.list).mockRejectedValue(new Error("offline"));
  renderFavorites(client);
  expect(screen.getByText("春游相册")).toBeInTheDocument();
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["favorites"] });
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "仍显示已加载的收藏",
  );
  expect(screen.getByText("春游相册")).toBeInTheDocument();
});

it("收藏资源均失效时不引导清除筛选", async () => {
  vi.mocked(useLibraryNodes).mockReturnValue({
    data: { items: [], missing: [node.id] },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  } as never);
  renderFavorites();
  // 文案带上失效条数，别再出现"1 项"配一张空网格的错觉。
  expect(
    await screen.findByText("收藏的 1 项内容暂时找不到"),
  ).toBeInTheDocument();
  // 条数说的是"这一侧能看到几项"，失效的那一项另起一行说明。
  expect(screen.getByText("0 项")).toBeInTheDocument();
  expect(
    screen.getByText("其中 1 项暂时找不到"),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "清除筛选" }),
  ).not.toBeInTheDocument();
});

it("收藏资源均失效时提供清理失效收藏的动作", async () => {
  vi.mocked(useLibraryNodes).mockReturnValue({
    data: { items: [], missing: [node.id] },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  } as never);
  vi.mocked(favoritesApi.remove).mockResolvedValue({ favorites: [] });
  renderFavorites();

  const cleanBtn = await screen.findByRole("button", {
    name: /清理 1 项失效收藏/,
  });
  fireEvent.click(cleanBtn);

  await waitFor(() => {
    expect(favoritesApi.remove).toHaveBeenCalledWith(node.id);
  });
});

it("最近看排序依赖的历史查询失败时保留收藏并提供重试", async () => {
  useSearchStore.getState().setSortBy("viewed");
  vi.mocked(historyApi.list).mockRejectedValueOnce(new Error("offline"));
  renderFavorites();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "最近访问加载失败",
  );
  expect(screen.getByText("春游相册")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  expect(favoritesApi.list).toHaveBeenCalledTimes(1);
  expect(historyApi.list).toHaveBeenCalledTimes(2);
});

it("名称排序不读取历史，真正的筛选空结果仍可清除", async () => {
  useSearchStore.getState().setQuery("无匹配");
  renderFavorites();
  expect(await screen.findByText("没有匹配的收藏")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(await screen.findByText("春游相册")).toBeInTheDocument();
  expect(historyApi.list).not.toHaveBeenCalled();
});

it("收藏为空时给出可收藏的推荐位，而不是只留一片空白", async () => {
  vi.mocked(favoritesApi.list).mockResolvedValue({ favorites: [] });
  // 照片侧没有阅读进度，空态推荐的是最近加入的照片。
  vi.mocked(useLibraryRecentAlbums).mockReturnValue({
    data: {
      page: {
        revision: 1,
        total: 1,
        items: [
          {
            id: "a_picnic",
            kind: "album",
            name: "野餐那本",
            displayName: "野餐那本",
            imageCount: 12,
            coverImages: [],
            contentKind: "photo",
          },
        ],
      },
    },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  } as never);
  renderFavorites();
  expect(await screen.findByText("还没有收藏照片")).toBeInTheDocument();
  // 推荐位：真实封面 + 常驻的星标（文案在教用户点哪里，星标不能藏起来）
  expect(screen.getByText("从这里挑一个收藏")).toBeInTheDocument();
  expect(screen.getByText("野餐那本")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "收藏「野餐那本」" }),
  ).toBeInTheDocument();
});
