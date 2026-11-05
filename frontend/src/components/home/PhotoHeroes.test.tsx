import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RecentlyAddedHero, SerendipityHero } from "./PhotoHeroes";
import { useFavorites } from "../../hooks/useFavorites";
import type { LibraryNodeSummary } from "../../api/library";

vi.mock("../../hooks/useFavorites", () => ({
  useFavorites: vi.fn(),
  useToggleFavorite: () => vi.fn().mockResolvedValue(undefined),
}));

function makeAlbum(
  id: string,
  name: string,
  overrides: Partial<LibraryNodeSummary> = {},
): LibraryNodeSummary {
  return {
    id,
    kind: "album",
    name,
    displayName: name,
    imageCount: 5,
    coverImages: [],
    contentKind: "photo",
    ...overrides,
  };
}

function renderHero(children: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("照片工作台的首屏专区", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  it("最近加入展示方形卡片，链接落在照片侧", () => {
    const { container } = renderHero(
      <RecentlyAddedHero
        items={[makeAlbum("a_1", "海边"), makeAlbum("a_2", "山里")]}
        total={2}
      />,
    );
    const hero = screen.getByTestId("recently-added-hero");
    expect(hero.textContent).toMatch(/2\s*本新照片/);
    // 照片侧的卡片必须落在 /photo/albums/…，不能串到漫画侧。
    const links = container.querySelectorAll('a[href^="/photo/albums/"]');
    expect(links.length).toBe(2);
    // 方形封面：照片工作台的卡片是展陈墙，不是竖版海报。
    const cover = container.querySelector('[data-testid="card-cover"]');
    expect(cover?.className).toContain("aspect-square");
  });

  it("没有最近加入的相册时不渲染该区块", () => {
    renderHero(<RecentlyAddedHero items={[]} total={0} />);
    expect(screen.queryByTestId("recently-added-hero")).toBeNull();
  });

  it("随手看看展示一本照片相册，换一本会回调", () => {
    const onReshuffle = vi.fn();
    renderHero(
      <SerendipityHero
        album={makeAlbum("a_9", "旧照片")}
        isLoading={false}
        onReshuffle={onReshuffle}
      />,
    );
    const hero = screen.getByTestId("serendipity-hero");
    expect(hero.textContent).toContain("旧照片");
    expect(screen.getByRole("link", { name: "打开看看" })).toHaveAttribute(
      "href",
      "/photo/albums/a_9",
    );
    fireEvent.click(screen.getByRole("button", { name: "换一本" }));
    expect(onReshuffle).toHaveBeenCalledTimes(1);
  });

  it("随手看看没有结果时不渲染", () => {
    renderHero(
      <SerendipityHero album={null} isLoading={false} onReshuffle={vi.fn()} />,
    );
    expect(screen.queryByTestId("serendipity-hero")).toBeNull();
  });
});
