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
import { useLibraryNodes, useLibraryTags } from "../hooks/useLibrary";
import { useSearchStore } from "../store/searchStore";
import Favorites from "./Favorites";

vi.mock("../api/prefs", () => ({
  favoritesApi: { list: vi.fn(), add: vi.fn(), remove: vi.fn() },
  historyApi: { list: vi.fn() },
}));
vi.mock("../hooks/useLibrary", () => ({
  useLibraryNodes: vi.fn(),
  useLibraryTags: vi.fn(),
}));
vi.mock("../hooks/useImageActivity", () => ({
  useImageActivities: () => ({ data: {} }),
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
  vi.mocked(useLibraryTags).mockReturnValue({
    data: { items: [{ tag: "旅行", albumCount: 1, coverImages: [] }] },
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
  expect(screen.queryByText("还没有收藏")).not.toBeInTheDocument();
  await act(async () => {
    resolveList({ favorites: [] });
  });
  expect(await screen.findByText("还没有收藏")).toBeInTheDocument();
});

it("收藏读取失败提供重试，恢复后展示收藏", async () => {
  vi.mocked(favoritesApi.list).mockRejectedValueOnce(new Error("offline"));
  renderFavorites();
  expect(await screen.findByRole("alert")).toHaveTextContent("收藏加载失败");
  expect(screen.queryByText("还没有收藏")).not.toBeInTheDocument();
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
      vi.mocked(useLibraryTags).mockReturnValue(failed as never);
    }
    renderFavorites();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "收藏详情加载失败",
    );
    expect(screen.queryByText("没有匹配的收藏")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(favoritesApi.list).toHaveBeenCalledTimes(1);
  },
);

it("标签查询失败仍保留已经解析的相册收藏", async () => {
  vi.mocked(favoritesApi.list).mockResolvedValue({
    favorites: [node.id, "smart:旅行"],
  });
  vi.mocked(useLibraryTags).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: true,
    isFetching: false,
    refetch: vi.fn(),
  } as never);
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
  // 条数说的是"收藏了多少"，失效的那一项另起一行说明。
  expect(screen.getByText("1 项")).toBeInTheDocument();
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
