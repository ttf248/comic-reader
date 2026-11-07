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
import { historyApi } from "../api/prefs";
import { useLibraryNodes } from "../hooks/useLibrary";
import { useSearchStore } from "../store/searchStore";
import Recents from "./Recents";

vi.mock("../api/prefs", () => ({ historyApi: { list: vi.fn() } }));
vi.mock("../hooks/useLibrary", () => ({ useLibraryNodes: vi.fn() }));
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

const history = [
  {
    albumId: "a_book",
    name: "春游相册",
    imageCount: 3,
    openedAt: "2026-10-31T00:00:00Z",
  },
];
const node = {
  id: "a_book",
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

function renderRecents(client = clientForTest()) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Recents />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useSearchStore.getState().reset();
  vi.mocked(historyApi.list).mockResolvedValue({ history });
  vi.mocked(useLibraryNodes).mockReturnValue({
    data: { items: [node], missing: [] },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  } as never);
});

it("历史请求未完成时显示加载，确认空列表后才显示没有记录", async () => {
  let resolveHistory: (value: { history: [] }) => void = () => {};
  vi.mocked(historyApi.list).mockReturnValue(
    new Promise((resolve) => {
      resolveHistory = resolve;
    }),
  );
  renderRecents();
  expect(screen.getByRole("status")).toHaveTextContent("正在加载最近浏览");
  expect(screen.queryByText("还没有最近浏览")).not.toBeInTheDocument();
  await act(async () => {
    resolveHistory({ history: [] });
  });
  expect(await screen.findByText("还没有最近浏览")).toBeInTheDocument();
});

it("历史读取失败提示重试，恢复后展示记录", async () => {
  vi.mocked(historyApi.list).mockRejectedValueOnce(new Error("offline"));
  renderRecents();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "最近浏览加载失败",
  );
  expect(screen.queryByText("还没有最近浏览")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  expect(await screen.findByText("春游相册")).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
});

it("摘要读取失败不误报没有匹配，并只重试失败的查询", async () => {
  const retryNodes = vi.fn();
  vi.mocked(useLibraryNodes).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: true,
    isFetching: false,
    refetch: retryNodes,
  } as never);
  renderRecents();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "相册信息加载失败",
  );
  expect(screen.queryByText("没有匹配的最近访问")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  expect(retryNodes).toHaveBeenCalledTimes(1);
  expect(historyApi.list).toHaveBeenCalledTimes(1);
});

it("后台刷新失败时保留已经加载的卡片并提示失败", async () => {
  const client = clientForTest();
  client.setQueryData(["history"], { history });
  vi.mocked(historyApi.list).mockRejectedValue(new Error("offline"));
  renderRecents(client);
  expect(screen.getByText("春游相册")).toBeInTheDocument();
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["history"] });
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "仍显示已加载的记录",
  );
  expect(screen.getByText("春游相册")).toBeInTheDocument();
});

it("历史中资源均已失效时说明相册不可用，不引导清除筛选", async () => {
  vi.mocked(useLibraryNodes).mockReturnValue({
    data: { items: [], missing: ["a_book"] },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  } as never);
  renderRecents();
  expect(await screen.findByText("最近访问的相册暂不可用")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "清除筛选" }),
  ).not.toBeInTheDocument();
});

it("已加载记录确实被筛选掉时仍可清除筛选", async () => {
  useSearchStore.getState().setQuery("无匹配");
  renderRecents();
  expect(await screen.findByText("没有匹配的最近访问")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(await screen.findByText("春游相册")).toBeInTheDocument();
});

// 这一页的天然顺序是「按最近看」：浏览足迹是一份日记，时刻要能排成一条轴。
// 用户没动过排序时按访问记录排；动过之后沿用他挑的那个。
it("默认按最近打开的顺序排，而不是按名称", async () => {
  vi.mocked(historyApi.list).mockResolvedValue({
    history: [
      {
        albumId: "a_b",
        name: "B 相册",
        imageCount: 2,
        openedAt: "2026-10-31T02:00:00Z",
      },
      {
        albumId: "a_a",
        name: "A 相册",
        imageCount: 2,
        openedAt: "2026-10-31T01:00:00Z",
      },
    ],
  });
  vi.mocked(useLibraryNodes).mockReturnValue({
    data: {
      items: [
        { ...node, id: "a_b", name: "B 相册", displayName: "B 相册" },
        { ...node, id: "a_a", name: "A 相册", displayName: "A 相册" },
      ],
      missing: [],
    },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  } as never);
  renderRecents();
  await waitFor(() => expect(screen.getByText("B 相册")).toBeInTheDocument());
  const titles = screen
    .getAllByText(/相册$/)
    .map((el) => el.textContent);
  expect(titles).toEqual(["B 相册", "A 相册"]);
  // 排序菜单也要说这一页正在按什么排。
  expect(screen.getByRole("button", { name: "排序" })).toHaveTextContent(
    "按最近看",
  );
});
