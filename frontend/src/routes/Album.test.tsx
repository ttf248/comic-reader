import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import Album from "./Album";
import {
  useAlbumMedia,
  useLibraryAncestors,
  useLibraryChildren,
  useLibraryNodes,
} from "../hooks/useLibrary";
import { useFavorites } from "../hooks/useFavorites";
import { useSearchStore } from "../store/searchStore";
import { historyApi } from "../api/prefs";

vi.mock("../hooks/useLibrary", () => ({
  useAlbumMedia: vi.fn(),
  useLibraryAncestors: vi.fn(),
  useLibraryChildren: vi.fn(),
  useLibraryNodes: vi.fn(),
  useTagAlbums: vi.fn(),
}));
vi.mock("../hooks/useFavorites", () => ({ useFavorites: vi.fn() }));
vi.mock("../api/fs", () => ({
  fsApi: { capabilities: vi.fn().mockResolvedValue({ allowOsOpen: false }) },
}));
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
// 照片墙与阅读器各自有自己的测试；这里只验证「按用途分派」。
vi.mock("./PhotoAlbum", () => ({
  default: ({ album }: { album: { id: string } }) => (
    <div data-testid="photo-album">照片墙:{album.id}</div>
  ),
}));

function Location() {
  const location = useLocation();
  return (
    <output data-testid="location">{location.pathname + location.search}</output>
  );
}

function renderAlbum(path = "/albums/c_year") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Location />
        <Routes>
          <Route path="/albums/*" element={<Album />} />
          <Route path="/read/:albumId" element={<div>阅读器</div>} />
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
    vi.mocked(useLibraryAncestors).mockReturnValue({
      data: [],
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
    // 集合的子节点按集合自己的属性查：kind 是必填的第二个参数。
    expect(useLibraryChildren).toHaveBeenCalledWith("c_year", "photo", 4);
    expect(screen.getByText("2025")).toBeInTheDocument();
    expect(screen.getByText("春游")).toBeInTheDocument();
  });

  it("集合页拼出上级路径，顶层集合没有面包屑", () => {
    vi.mocked(useLibraryNodes).mockReturnValue({
      data: {
        revision: 4,
        missing: [],
        items: [
          {
            id: "c_class",
            kind: "collection",
            name: "3班",
            displayName: "3班",
            coverImage: "f_cover",
            coverImages: ["f_cover"],
            albumCount: 1,
            imageCount: 8,
            parentId: "c_school",
          },
        ],
      },
      isLoading: false,
    } as never);
    vi.mocked(useLibraryChildren).mockReturnValue({
      data: { revision: 4, total: 0, items: [] },
      isLoading: false,
    } as never);
    vi.mocked(useLibraryAncestors).mockReturnValue({
      data: [{ id: "c_school", kind: "collection", name: "中学", displayName: "中学" }],
      isLoading: false,
    } as never);

    renderAlbum("/albums/c_class");

    // 上级集合是链接，当前页是标题：面包屑说的是「你在哪棵树上」。
    expect(useLibraryAncestors).toHaveBeenCalledWith("c_school");
    expect(screen.getByRole("link", { name: "中学" })).toHaveAttribute(
      "href",
      "/photo/albums/c_school",
    );
    expect(screen.getByText("3班")).toBeInTheDocument();
  });

  it("集合内的散图卡片用语义名，不与父集合重名", () => {
    vi.mocked(useLibraryNodes).mockReturnValue({
      data: {
        revision: 4,
        missing: [],
        items: [
          {
            id: "c_year",
            kind: "collection",
            name: "2011年",
            displayName: "2011年",
            coverImage: "f_cover",
            coverImages: ["f_cover"],
            albumCount: 2,
            imageCount: 8,
          },
        ],
      },
      isLoading: false,
    } as never);
    vi.mocked(useLibraryChildren).mockReturnValue({
      data: {
        revision: 4,
        total: 2,
        items: [
          {
            id: "a_loose",
            kind: "album",
            name: "本目录媒体",
            displayName: "本目录媒体",
            virtual: true,
            location: "2011年",
            coverImage: "f_loose",
            coverImages: ["f_loose"],
            imageCount: 102,
          },
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

    // 父集合标题是 "2011年"；散图卡片不能也叫 "2011年"，否则同名卡片
    // 会让人以为集合里还有一个叫 "2011年" 的子相册。
    expect(screen.getByText("散图")).toBeInTheDocument();
    expect(screen.queryByText("2011年")).toBeInTheDocument();
    expect(screen.getAllByText("2011年")).toHaveLength(1);
  });

  it("只到 /albums 时回到工作台首页", () => {
    renderAlbum("/albums");
    expect(screen.getByTestId("location")).toHaveTextContent("/photo");
    expect(screen.queryByText("找不到此文件夹")).not.toBeInTheDocument();
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

  it("照片相册直接进入照片墙，没有「开始浏览」这一步", () => {
    vi.mocked(useLibraryNodes).mockReturnValue({
      data: {
        revision: 4,
        missing: [],
        items: [
          {
            id: "a_trip",
            kind: "album",
            name: "春游",
            imageCount: 8,
            contentKind: "photo",
          },
        ],
      },
      isLoading: false,
    } as never);

    renderAlbum("/albums/a_trip");

    expect(screen.getByTestId("photo-album")).toHaveTextContent("照片墙:a_trip");
    expect(screen.queryByRole("button", { name: /开始浏览/ })).toBeNull();
  });

  it("漫画相册直接进入阅读器", async () => {
    vi.mocked(useLibraryNodes).mockReturnValue({
      data: {
        revision: 4,
        missing: [],
        items: [
          {
            id: "a_comic",
            kind: "album",
            name: "第一卷",
            imageCount: 120,
            contentKind: "comic",
          },
        ],
      },
      isLoading: false,
    } as never);

    renderAlbum("/albums/a_comic");

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/read/a_comic"),
    );
    expect(screen.queryByTestId("photo-album")).toBeNull();
  });

  it("打开相册成功写入访问后使已有历史缓存立即失效", async () => {
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
    const { client } = renderAlbum("/albums/a_pages");
    client.setQueryData(["history"], { history: [] });
    await waitFor(() => expect(historyApi.add).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(client.getQueryState(["history"])?.isInvalidated).toBe(true),
    );
  });

  it("写入访问成功立即采用返回列表，不依赖后续读取", async () => {
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
    renderAlbum("/albums/a_pages");
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
    await waitFor(() => expect(historyApi.add).toHaveBeenCalledTimes(1));
    cleanup();
  });
});
