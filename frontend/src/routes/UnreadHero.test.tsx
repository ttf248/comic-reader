import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UnreadHero } from "../components/home/HomeHeroes";
import { useFavorites } from "../hooks/useFavorites";

vi.mock("../hooks/useFavorites", () => ({
  useFavorites: vi.fn(),
  useToggleFavorite: () => vi.fn().mockResolvedValue(undefined),
}));

function makeCard(path: string, name: string) {
  return {
    id: "u:" + path,
    variant: "album" as const,
    title: name,
    count: 10,
    imageCount: 10,
    videoCount: 0,
    coverPath: path + "/cover.jpg",
    coverKind: "image" as const,
    to: `/albums/${encodeURIComponent(path)}`,
  };
}

function renderHero(
  cards: ReturnType<typeof makeCard>[],
  count = cards.length,
) {
  const onShuffle = vi.fn();
  const onMarkRead = vi.fn();
  // AlbumCard 内部用 useQueryClient 失效图片活动查询，
  // 测试套件包一层 QueryClientProvider 避免 "No QueryClient set" 报错。
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onShuffle,
    onMarkRead,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <UnreadHero
            cards={cards}
            count={count}
            onShuffle={onShuffle}
            onMarkRead={onMarkRead}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

describe("UnreadHero", () => {
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

  it("显示计数 + 随机未读按钮 + 全部链接", () => {
    const { onShuffle } = renderHero([
      makeCard("/a", "A"),
      makeCard("/b", "B"),
    ]);
    // 预览数量与全库未读计数分别展示。

    // 数字 2 通过 nearest 父节点 textContent 校验
    const heroSection = screen.getByTestId("unread-hero");
    expect(heroSection.textContent).toMatch(/2\s*本等你翻开/);
    // 随机未读按钮
    const shuffleBtn = screen.getByRole("button", { name: "随机未读" });
    fireEvent.click(shuffleBtn);
    expect(onShuffle).toHaveBeenCalledTimes(1);
    // 全部 → 链接跳到 /unread
    expect(screen.getByText("全部").closest("a, button")).toBeInTheDocument();
  });

  it("发现区显示四本预览，并保留完整未读入口", () => {
    const eight = Array.from({ length: 8 }, (_, i) =>
      makeCard(`/p${i}`, `P${i}`),
    );
    const { container } = renderHero(eight, 8);
    // 发现区只预览四本，完整列表由明确链接承接。
    const renderedCards = container.querySelectorAll('a[href^="/albums/"]');
    expect(renderedCards.length).toBe(4);
    expect(
      screen.getByRole("link", { name: "查看全部未读相册" }),
    ).toHaveAttribute("href", "/unread");
  });

  it("count 与 cards.length 不一致时显示 count(可能 >6)", () => {
    // 模拟「7 张未读但只传 1 张做展示」的极端情况:display count 而非 length
    const { container } = renderHero([makeCard("/a", "A")], 7);
    const heroSection = screen.getByTestId("unread-hero");
    expect(heroSection.textContent).toMatch(/7\s*本等你翻开/);
    expect(container.querySelectorAll('a[href^="/albums/"]').length).toBe(1);
  });

  it("空 cards 数组仍渲染(调用方决定是否隐藏)", () => {
    // 组件本身不判空,留给 Home 决定是否显示(便于在条件分支里复用)
    renderHero([], 0);
    const heroSection = screen.getByTestId("unread-hero");
    // 计数 0 仍然显示「还有 0 本没看」— 由 Home 条件 {unreadCards.length > 0} 隐藏
    expect(heroSection.textContent).toMatch(/0\s*本等你翻开/);
  });

  it("点 X 触发 onMarkRead 且不触发 onShuffle(未冒泡到其它 handler)", () => {
    const { onMarkRead, onShuffle } = renderHero([
      makeCard("/a", "A"),
      makeCard("/b", "B"),
    ]);
    // 第一张「A」卡上的 X 按钮
    const xBtnA = screen.getByLabelText("将A标记为已读");
    fireEvent.click(xBtnA);
    expect(onMarkRead).toHaveBeenCalledTimes(1);
    expect(onMarkRead.mock.calls[0][0].title).toBe("A");
    expect(onShuffle).not.toHaveBeenCalled();
  });

  it("首页预览不提供批量清空，避免只清除已展示的前六本", () => {
    renderHero([makeCard("/a", "A")]);
    expect(
      screen.queryByTitle(/将所有未读相册标记为已读/),
    ).not.toBeInTheDocument();
  });
});
