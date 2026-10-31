import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

vi.mock("../hooks/useLibrary", () => ({
  useAlbumMedia: vi.fn(),
  useLibraryChildren: vi.fn(),
  useLibraryNodes: vi.fn(),
  useTagAlbums: vi.fn(),
}));
vi.mock("../hooks/useFavorites", () => ({ useFavorites: vi.fn() }));
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
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/albums/*" element={<Album />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Album", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSearchStore.getState().reset();
    vi.mocked(useFavorites).mockReturnValue({
      favorites: [],
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
});
