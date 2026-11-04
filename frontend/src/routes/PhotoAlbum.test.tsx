import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import PhotoAlbum from "./PhotoAlbum";
import { useAlbumMedia } from "../hooks/useLibrary";
import { useFavorites } from "../hooks/useFavorites";
import { useUIStore } from "../store/uiStore";
import { activityApi } from "../api/activity";
import { albumsApi } from "../api/albums";

vi.mock("../hooks/useLibrary", () => ({
  useAlbumMedia: vi.fn(),
  useLibraryChildren: vi.fn(),
  useLibraryNodes: vi.fn(),
  useTagAlbums: vi.fn(),
}));
vi.mock("../hooks/useFavorites", () => ({ useFavorites: vi.fn() }));
vi.mock("../api/fs", () => ({
  fsApi: { capabilities: vi.fn().mockResolvedValue({ allowOsOpen: false }) },
}));
vi.mock("../api/activity", () => ({
  activityApi: { setPhoto: vi.fn(async () => ({})) },
}));
vi.mock("../api/albums", () => ({
  albumsApi: {
    setCover: vi.fn(async () => ({})),
    setContentKind: vi.fn(async () => ({
      ok: true,
      contentKind: "comic",
      contentKindDefault: "photo",
      contentKindOverridden: true,
    })),
    clearContentKind: vi.fn(),
  },
}));
vi.mock("../components/wall/PhotoWall", () => ({
  default: ({
    items,
    onOpen,
  }: {
    items: { id: string; kind: string; name: string }[];
    onOpen: (item: unknown, index: number) => void;
  }) => (
    <div data-testid="photo-wall">
      {items.map((item, index) => (
        <button key={item.id} onClick={() => onOpen(item, index)}>
          {item.name}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../components/wall/PhotoViewer", () => ({
  default: ({ albumName }: { albumName: string }) => (
    <div data-testid="photo-viewer">大图:{albumName}</div>
  ),
}));

const album = {
  id: "a_trip",
  kind: "album" as const,
  name: "春游",
  displayName: "春游",
  coverImage: "f_cover",
  coverImages: ["f_cover"],
  imageCount: 3,
  videoCount: 1,
  contentKind: "photo" as const,
  contentKindDefault: "photo" as const,
  contentKindOverridden: false,
};

function Location() {
  const location = useLocation();
  return (
    <output data-testid="location">{location.pathname + location.search}</output>
  );
}

function renderPhotoAlbum(node = album) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/albums/${node.id}`]}>
        <Location />
        <Routes>
          <Route
            path="/albums/:albumId"
            element={<PhotoAlbum album={node} />}
          />
          <Route path="/read/:albumId" element={<div>阅读器</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PhotoAlbum", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ toasts: [] });
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
      data: {
        pages: [
          {
            total: 4,
            items: [
              { id: "f_1", kind: "image", index: 0, kindIndex: 0, name: "1.jpg" },
              { id: "f_2", kind: "image", index: 1, kindIndex: 1, name: "2.jpg" },
              { id: "f_3", kind: "video", index: 2, kindIndex: 0, name: "3.mp4" },
            ],
          },
        ],
      },
      hasNextPage: false,
      isFetchingNextPage: false,
      isFetchNextPageError: false,
      fetchNextPage: vi.fn(),
    } as never);
  });

  it("直接呈现照片墙，没有漫画阅读器的入口", () => {
    renderPhotoAlbum();

    expect(screen.getByTestId("photo-wall")).toBeInTheDocument();
    expect(screen.getByText("春游")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /开始浏览/ })).toBeNull();
    expect(screen.queryByText(/阅读进度/)).toBeNull();
  });

  it("点击照片打开沉浸式大图预览", () => {
    renderPhotoAlbum();

    fireEvent.click(screen.getByText("1.jpg"));

    expect(screen.getByTestId("photo-viewer")).toHaveTextContent("大图:春游");
  });

  it("更多菜单复制相册的完整链接", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      renderPhotoAlbum();
      fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "复制相册链接" }));
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith(
          window.location.origin + "/albums/a_trip",
        ),
      );
    } finally {
      if (originalClipboard)
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("切换成漫画相册后进入阅读器", async () => {
    renderPhotoAlbum();

    fireEvent.click(screen.getByRole("button", { name: "漫画" }));

    await waitFor(() =>
      expect(albumsApi.setContentKind).toHaveBeenCalledWith("a_trip", "comic"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/read/a_trip"),
    );
  });

  it("打开照片墙就记下浏览进度", async () => {
    renderPhotoAlbum();

    await waitFor(() =>
      expect(activityApi.setPhoto).toHaveBeenCalledWith("a_trip", 0, 4),
    );
  });
});
