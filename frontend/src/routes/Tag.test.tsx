import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Tag from "./Tag";
import { useTagAlbums } from "../hooks/useLibrary";
import { useFavorites } from "../hooks/useFavorites";
import { useImageActivities } from "../hooks/useImageActivity";
import { useSearchStore } from "../store/searchStore";

vi.mock("../hooks/useLibrary", () => ({ useTagAlbums: vi.fn() }));
vi.mock("../hooks/useFavorites", () => ({ useFavorites: vi.fn() }));
vi.mock("../hooks/useImageActivity", () => ({
  useImageActivities: vi.fn(),
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

function renderTag() {
  return render(
    <MemoryRouter initialEntries={["/tags/%E6%97%85%E8%A1%8C"]}>
      <Routes>
        <Route path="/tags/*" element={<Tag />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Tag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSearchStore.getState().reset();
    vi.mocked(useFavorites).mockReturnValue({
      favorites: [],
      add: vi.fn(),
      remove: vi.fn(),
      toggle: vi.fn(),
    });
    vi.mocked(useImageActivities).mockReturnValue({
      data: {},
      isLoading: false,
    } as never);
  });

  it("使用标签分页摘要渲染全部相册", () => {
    vi.mocked(useTagAlbums).mockReturnValue({
      data: {
        revision: 3,
        total: 1,
        items: [
          {
            id: "a_trip",
            kind: "album",
            name: "旅行册",
            displayName: "旅行册",
            tags: ["旅行"],
            coverImage: "f_cover",
            coverImages: ["f_cover"],
            imageCount: 12,
            videoCount: 1,
          },
        ],
      },
      isLoading: false,
    } as never);

    renderTag();

    expect(useTagAlbums).toHaveBeenCalledWith("旅行");
    expect(screen.getByText("旅行册")).toBeInTheDocument();
    expect(screen.getByText("13")).toBeInTheDocument();
    expect(screen.getByText("图片 12 · 视频 1")).toBeInTheDocument();
    expect(screen.getByText("0/1")).toBeInTheDocument();
  });

  it("加载时不误报标签不存在", () => {
    vi.mocked(useTagAlbums).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as never);

    renderTag();

    expect(screen.getByText("正在加载标签")).toBeInTheDocument();
    expect(screen.queryByText("未找到该标签")).not.toBeInTheDocument();
  });
});
