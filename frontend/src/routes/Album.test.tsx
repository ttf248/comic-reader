import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Album from "./Album";
import {
  useAlbumMedia,
  useLibraryChildren,
  useLibraryNodes,
  useTagAlbums,
} from "../hooks/useLibrary";
import { useFavorites } from "../hooks/useFavorites";
import { useSearchStore } from "../store/searchStore";
import { historyApi } from "../api/prefs";
import { useUIStore } from "../store/uiStore";

vi.mock("../hooks/useLibrary", () => ({
  useAlbumMedia: vi.fn(),
  useLibraryChildren: vi.fn(),
  useLibraryNodes: vi.fn(),
  useTagAlbums: vi.fn(),
}));
vi.mock("../hooks/useFavorites", () => ({ useFavorites: vi.fn() }));
vi.mock("../api/prefs", () => ({ historyApi: { add: vi.fn() } }));
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

function renderAlbum(path = "/albums/c_year") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/albums/*" element={<Album />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const rendered = render(ui());
  return { ...rendered, client, refresh: () => rendered.rerender(ui()) };
}

describe("Album", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(historyApi.add).mockResolvedValue({ history: [] });
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
    vi.mocked(useAlbumMedia).mockReturnValue({
      data: undefined,
      isLoading: false,
    } as never);
    vi.mocked(useTagAlbums).mockReturnValue({
      data: undefined,
      isLoading: false,
    } as never);
  });

  it("通过节点摘要和直属子项渲染集合", () => {
    vi.mocked(useLibraryNodes).mockReturnValue({
      data: {
        revision: 4,
        missing: [],
        items: [
          {
            id: "c_year",
            kind: "collection",
            name: "2025",
            displayName: "2025",
            coverImage: "f_cover",
            coverImages: ["f_cover"],
            albumCount: 1,
            imageCount: 8,
          },
        ],
      },
      isLoading: false,
    } as never);
    vi.mocked(useLibraryChildren).mockReturnValue({
      data: {
        revision: 4,
        total: 1,
        items: [
          {
            id: "a_trip",
            kind: "album",
            name: "春游",
            displayName: "春游",
            coverImage: "f_trip",
            coverImages: ["f_trip"],
            imageCount: 8,
          },
        ],
      },
      isLoading: false,
    } as never);

    renderAlbum();

    expect(useLibraryNodes).toHaveBeenCalledWith(["c_year"]);
    expect(useLibraryChildren).toHaveBeenCalledWith("c_year", 4);
    expect(screen.getByText("2025")).toBeInTheDocument();
    expect(screen.getByText("春游")).toBeInTheDocument();
  });

  it("节点查询未完成时显示加载态", () => {
    vi.mocked(useLibraryNodes).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as never);
    vi.mocked(useLibraryChildren).mockReturnValue({
      data: undefined,
      isLoading: false,
    } as never);

    renderAlbum();

    expect(screen.getByText("正在加载文件夹")).toBeInTheDocument();
    expect(screen.queryByText("找不到此文件夹")).not.toBeInTheDocument();
  });

  it("分页失败保留相册并提供不取消活动请求的重试", () => {
    const fetchNextPage = vi.fn();
    vi.mocked(useLibraryNodes).mockReturnValue({
      data: {
        revision: 4,
        missing: [],
        items: [
          { id: "a_pages", kind: "album", name: "分页相册", imageCount: 405 },
        ],
      },
      isLoading: false,
    } as never);
    vi.mocked(useAlbumMedia).mockReturnValue({
      data: {
        pages: [
          { items: [{ id: "f_first", kind: "image", index: 0, kindIndex: 0 }] },
        ],
      },
      hasNextPage: true,
      isFetchNextPageError: true,
      isFetchingNextPage: false,
      fetchNextPage,
    } as never);

    renderAlbum("/albums/a_pages");

    expect(
      screen.getByRole("heading", { name: "分页相册" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("后续媒体加载失败");
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
    expect(fetchNextPage).toHaveBeenCalledWith({ cancelRefetch: false });
  });

  function mockAlbumPage() {
    vi.mocked(useLibraryNodes).mockReturnValue({
      data: {
        revision: 4,
        missing: [],
        items: [
          { id: "a_pages", kind: "album", name: "分页相册", imageCount: 405 },
        ],
      },
      isLoading: false,
    } as never);
    vi.mocked(useAlbumMedia).mockReturnValue({
      data: {
        pages: [
          { items: [{ id: "f_first", kind: "image", index: 0, kindIndex: 0 }] },
        ],
      },
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    } as never);
  }

  it("更多菜单复制相册的完整链接并恢复来源焦点", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    useUIStore.setState({ toasts: [] });
    try {
      mockAlbumPage();
      renderAlbum("/albums/a_pages");
      const source = screen.getByRole("button", { name: "更多操作" });
      source.focus();
      fireEvent.click(source);
      fireEvent.click(
        screen.getByRole("menuitem", {
          name: "复制链接",
        }),
      );
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith(
          window.location.origin + "/albums/a_pages",
        ),
      );
      await waitFor(() =>
        expect(useUIStore.getState().toasts).toEqual([
          expect.objectContaining({ kind: "success", message: "已复制链接" }),
        ]),
      );
      expect(screen.queryByRole("menu")).toBeNull();
      expect(source).toHaveFocus();
    } finally {
      if (originalClipboard)
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("详情菜单复制被拒绝且回退不可用时反馈错误", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("test denied")) },
    });
    useUIStore.setState({ toasts: [] });
    try {
      mockAlbumPage();
      renderAlbum("/albums/a_pages");
      fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "复制链接" }));
      await waitFor(() =>
        expect(useUIStore.getState().toasts).toEqual([
          expect.objectContaining({
            kind: "error",
            message: "复制失败，请检查浏览器权限",
          }),
        ]),
      );
      expect(document.querySelector("textarea")).toBeNull();
    } finally {
      if (originalClipboard)
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("打开相册成功写入访问后使已有历史缓存立即失效", async () => {
    mockAlbumPage();
    const { client } = renderAlbum("/albums/a_pages");
    client.setQueryData(["history"], { history: [] });
    await waitFor(() => expect(historyApi.add).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(client.getQueryState(["history"])?.isInvalidated).toBe(true),
    );
  });

  it("写入访问成功立即采用返回列表，不依赖后续读取", async () => {
    mockAlbumPage();
    const history = [
      {
        albumId: "a_pages",
        name: "分页相册",
        imageCount: 405,
        openedAt: "2026-10-31T10:00:00Z",
      },
    ];
    vi.mocked(historyApi.add).mockResolvedValue({ history });
    const { client } = renderAlbum("/albums/a_pages");
    client.setQueryData(["history"], { history: [] });
    await waitFor(() =>
      expect(client.getQueryData(["history"])).toEqual({ history }),
    );
  });

  it("追加媒体页时不重复写入本次访问", async () => {
    mockAlbumPage();
    const { refresh } = renderAlbum("/albums/a_pages");
    await waitFor(() => expect(historyApi.add).toHaveBeenCalledTimes(1));
    vi.mocked(useAlbumMedia).mockReturnValue({
      data: {
        pages: [
          { items: [{ id: "f_first", kind: "image", index: 0, kindIndex: 0 }] },
          { items: [{ id: "f_next", kind: "image", index: 1, kindIndex: 1 }] },
        ],
      },
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    } as never);
    await act(async () => {
      refresh();
    });
    expect(historyApi.add).toHaveBeenCalledTimes(1);
  });
});
