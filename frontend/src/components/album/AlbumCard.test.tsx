import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AlbumCard, { type CardData } from "./AlbumCard";
import { useUIStore } from "../../store/uiStore";
import { favoritesApi } from "../../api/prefs";

vi.mock("../../api/prefs", () => ({
  favoritesApi: {
    list: vi.fn(async () => ({ favorites: [] })),
    add: vi.fn(async () => ({ favorites: ["album-1"] })),
    remove: vi.fn(async () => ({ favorites: [] })),
  },
}));

vi.mock("../../hooks/useVideoCover", () => ({
  useVideoCover: () => ({
    status: "error",
    url: "",
    retry: vi.fn(),
    enabled: true,
  }),
}));

vi.mock("../common/TranscodeStatusBadge", () => ({
  default: () => null,
}));

vi.mock("../common/HoverPreview", () => ({
  default: () => <div data-testid="hover-preview" />,
}));

function card(overrides: Partial<CardData> = {}): CardData {
  return {
    id: "album-1",
    variant: "album",
    title: "周末记录",
    count: 12,
    imageCount: 12,
    videoCount: 0,
    coverPath: "cover-main",
    coverKind: "image",
    to: "/albums/album-1",
    contentKind: "comic",
    ...overrides,
  };
}

function renderCard(data: CardData, variant: "grid" | "list" = "grid") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AlbumCard data={data} variant={variant} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AlbumCard 封面语义", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("右键打开菜单时收起悬停预览", async () => {
    vi.useFakeTimers();
    // 悬停预览只在精确指针下出现：这里给一个细指针环境。
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    try {
      renderCard(card());
      const tile = screen.getByTestId("album-card");
      fireEvent.mouseEnter(tile);
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByTestId("hover-preview")).toBeInTheDocument();
      // 菜单与预览都浮在指针附近：叠在一起两边都读不清。
      fireEvent.contextMenu(tile);
      expect(screen.queryByTestId("hover-preview")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // 漫画侧是书架：书名印在封面上，封面下方不再重复一遍标题。
  // 照片侧是展陈墙：标题仍然是封面下方的说明牌。
  it("漫画相册把标题印在封面上，封面下方不再重复标题", () => {
    const { container } = renderCard(card({ title: "2024年/上海迪士尼" }));

    const band = screen.getByTestId("cover-title");
    expect(band).toHaveTextContent("2024年/上海迪士尼");
    expect(container.querySelector(".album-tile__cover--book")).not.toBeNull();
    // 封面下方的说明区里没有标题块。
    expect(container.querySelector(".album-tile__title")).toBeNull();
  });

  it("照片相册保留封面下方的标题，不压成书名压条", () => {
    const { container } = renderCard(
      card({ title: "周末记录", contentKind: "photo" }),
    );

    expect(screen.queryByTestId("cover-title")).not.toBeInTheDocument();
    expect(container.querySelector(".album-tile__cover--book")).toBeNull();
    expect(container.querySelector(".album-tile__title")).toHaveTextContent(
      "周末记录",
    );
  });

  // 漫画侧的卷名只写「第1卷」：一屏里两本「第1卷」分属不同作品，
  // 光看封面分不出谁是谁。作品名因此压在书名上方。
  it("漫画卷在书名上方印出所属作品", () => {
    const { container } = renderCard(
      card({ title: "第1卷", parentName: "星海漫步" }),
    );

    const series = container.querySelector(".cover-title__series");
    expect(series).toHaveTextContent("星海漫步");
    expect(screen.getByTestId("cover-title")).toHaveTextContent("第1卷");
  });

  it("作品名与卷名相同时不重复印两遍", () => {
    const { container } = renderCard(
      card({ title: "星海漫步", parentName: "星海漫步" }),
    );

    expect(container.querySelector(".cover-title__series")).toBeNull();
  });

  // 列表行没有封面压条可借位置，作品名补在卷名前面。
  it("列表行的漫画卷在卷名前面补上所属作品", () => {
    renderCard(card({ title: "第1卷", parentName: "星海漫步" }), "list");

    expect(screen.getByText("星海漫步 · 第1卷")).toBeInTheDocument();
  });

  it("列表行的照片相册不补作品名", () => {
    renderCard(
      card({ title: "周末记录", contentKind: "photo", parentName: "某个相册" }),
      "list",
    );

    expect(screen.queryByText(/某个相册/)).not.toBeInTheDocument();
  });

  it("照片相册不印作品名", () => {
    const { container } = renderCard(
      card({ title: "周末记录", contentKind: "photo", parentName: "某个相册" }),
    );

    expect(container.querySelector(".cover-title__series")).toBeNull();
  });

  it("相册始终使用主封面，不把 covers 渲染成马赛克", () => {
    const { container } = renderCard(
      card({ covers: ["other-1", "other-2", "other-3"] }),
    );

    const images = container.querySelectorAll('[data-testid="card-cover"] img');
    expect(images).toHaveLength(1);
    expect(images[0]).toHaveAttribute("src", "/api/thumbs/cover-main");
    expect(screen.queryByTestId("card-cover-mosaic")).not.toBeInTheDocument();
  });

  it("集合封面去重、忽略空值并最多展示四张", () => {
    const { container } = renderCard(
      card({
        id: "collection-1",
        variant: "collection",
        title: "2026 年",
        count: 8,
        coverPath: "legacy-cover",
        covers: ["one", "two", "one", "  ", "three", "four", "five"],
      }),
    );

    const mosaic = screen.getByTestId("card-cover-mosaic");
    expect(mosaic).toHaveAttribute("data-cover-layout", "mosaic-4");
    expect(
      container.querySelectorAll('[data-testid="card-cover"] img'),
    ).toHaveLength(4);
    expect(
      container.querySelector('img[src="/api/thumbs/legacy-cover"]'),
    ).toBeNull();
  });

  it("集合没有 covers 时回退到旧 coverPath", () => {
    const { container } = renderCard(
      card({
        id: "smart-1",
        variant: "smart",
        title: "旅行",
        count: 3,
        covers: [],
      }),
    );

    expect(screen.getByTestId("card-cover-mosaic")).toHaveAttribute(
      "data-cover-layout",
      "single",
    );
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "/api/thumbs/cover-main",
    );
  });

  it("混合相册展示视频角标以及分开的图片、视频计数", () => {
    renderCard(
      card({
        imageCount: 9,
        videoCount: 2,
        coverKind: "video",
        durationSec: 125,
      }),
    );

    expect(screen.getByText("02:05")).toBeInTheDocument();
    // 默认是漫画相册：图片按「页」计数（照片侧才是「张」）。
    // 漫画侧标题印在封面上，封面下方的说明行只剩计数，
    // 因此数量与视频数分成两段：数量用正文色，补充信息退回次要色。
    const lead = screen.getByText("9 页");
    expect(lead).toBeInTheDocument();
    expect(screen.getByText("· 2 个视频")).toBeInTheDocument();
    expect(lead.closest("[title]")).toHaveAttribute("title", "9 页 + 2 个视频");
    expect(
      screen.queryByRole("button", { name: "重试" }),
    ).not.toBeInTheDocument();
  });

  it("照片相册按「张」计数，与漫画侧的「页」分开", () => {
    renderCard(card({ contentKind: "photo", imageCount: 9, videoCount: 0 }));

    expect(screen.getByText("9 张")).toBeInTheDocument();
    expect(screen.queryByText(/页/)).not.toBeInTheDocument();
  });

  it.each(["grid", "list"] as const)(
    "%s 模式集合计数单位跟着内容属性走",
    (variant) => {
      renderCard(
        card({
          variant: "collection",
          contentKind: "photo",
          count: 3,
          imageCount: undefined,
          videoCount: undefined,
        }),
        variant,
      );
      // 照片侧说「本相册」：光秃秃一个「本」看不出是什么。
      expect(screen.getByText("3 本相册")).toBeInTheDocument();
    },
  );

  it.each(["grid", "list"] as const)(
    "%s 模式使用真实链接和对应画幅且没有嵌套按钮",
    (variant) => {
      renderCard(card(), variant);

      const link = screen.getByRole("link", { name: "打开相册“周末记录”" });
      expect(link).toHaveAttribute("href", "/albums/album-1");
      expect(link.querySelector("button")).toBeNull();
      expect(screen.getByTestId("card-cover")).toHaveClass(
        variant === "grid" ? "aspect-[4/3]" : "aspect-[4/5]",
      );
    },
  );
  it.each(["grid", "list"] as const)(
    "%s 模式只在多根媒体下显示来源标记",
    (variant) => {
      const withSource = card({ sourceName: "存照", sourceRoot: "r_1" });

      useUIStore.getState().setMultiRoot(false);
      const { unmount } = renderCard(withSource, variant);
      expect(screen.queryByText(/来自 存照/)).not.toBeInTheDocument();
      unmount();

      useUIStore.getState().setMultiRoot(true);
      renderCard(withSource, variant);
      expect(screen.getByText(/来自 存照/)).toBeInTheDocument();
    },
  );

  it("列表模式把张数与最近查看放进右侧信息列", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AlbumCard
            data={card({
              imageCount: 9,
              videoCount: 2,
              lastSeenAt: "2024-05-01T00:00:00Z",
            })}
            variant="list"
            showLastSeen
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByText("9 页 · 2 个视频")).toBeInTheDocument();
    expect(screen.getByText(/上次/)).toBeInTheDocument();
  });
});

describe("AlbumCard 状态表达", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ toasts: [] });
  });

  it("从未打开过的相册在封面左上角标一个安静的未读点，而不是一个「新」字块", () => {
    renderCard(card());

    // 未读：深色蒙版上的白点 + 屏幕阅读器可读的文本。
    expect(screen.getByText("未读")).toBeInTheDocument();
    expect(screen.queryByText("新", { exact: true })).not.toBeInTheDocument();
    // 未读相册不能同时显示「已读」。
    expect(screen.queryByText("已读完", { exact: true })).not.toBeInTheDocument();
  });

  // 阅读状态集中在封面左上角一列：未读点与已读完 chip 互斥，不会同时
  // 出现，但也不再散在两个方向 —— 扫读一张卡片时不用分别去找。
  it("已读完的相册在封面左上角显示已读 chip，且不再显示未读点", () => {
    const { container } = renderCard(card({ progress: { index: 11, total: 12 } }));

    expect(screen.getByText("已读完", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("未读")).not.toBeInTheDocument();
    const chip = screen.getByText("已读完", { exact: true }).closest("div");
    const slot = container.querySelector(".album-tile__cover > div");
    expect(slot).not.toBeNull();
    expect(slot?.contains(chip)).toBe(true);
  });

  it("在读的相册不再显示未读点，状态由封面底部的进度条承担", () => {
    renderCard(card({ progress: { index: 3, total: 12 } }));

    expect(screen.queryByText("未读")).not.toBeInTheDocument();
    // 漫画侧标题印在封面上，封面下缘不再压百分比 chip，
    // 百分比与计数读在同一条说明行里。
    expect(screen.getByText("已读 27%")).toBeInTheDocument();
  });

  // 照片相册没有阅读进度：百分比、位置与「已读完」都属于漫画。
  it("照片相册不显示百分比，也不显示阅读位置", () => {
    renderCard(
      card({ contentKind: "photo", progress: { index: 3, total: 12 } }),
    );

    expect(screen.queryByText("27%")).not.toBeInTheDocument();
    expect(screen.queryByText("读到 4 / 12")).not.toBeInTheDocument();
    expect(screen.queryByText("已读完", { exact: true })).not.toBeInTheDocument();
  });

  it("照片相册不显示「已读完」chip，也不显示未读点", () => {
    renderCard(card({ contentKind: "photo", progress: { index: 11, total: 12 } }));

    expect(screen.queryByText("已读完", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("未读")).not.toBeInTheDocument();
  });

  it("整页都是未读的列表关掉逐卡未读标记", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AlbumCard data={card()} showUnreadBadge={false} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.queryByText("未读")).not.toBeInTheDocument();
    expect(screen.queryByText("新", { exact: true })).not.toBeInTheDocument();
  });

  it("集合与标签是类型而不是状态：类型信息放在元信息行，不占封面角位", () => {
    renderCard(
      card({ variant: "collection", title: "2026 年", subtitle: "集合" }),
    );

    // 仍然能看到类型信息，但不再占用封面角位（角位留给未读 / 已读）。
    const chip = screen.getByText("集合");
    expect(chip).toBeInTheDocument();
    expect(screen.getByTestId("card-cover").contains(chip)).toBe(false);
  });

  it("标签（智能视图）在元信息行标出类型", () => {
    renderCard(card({ variant: "smart", title: "旅行" }));

    const chip = screen.getByText("标签");
    expect(screen.getByTestId("card-cover").contains(chip)).toBe(false);
  });

  it("列表视图把状态写在标题行，不再在缩略图上重复已读", () => {
    renderCard(card({ progress: { index: 11, total: 12 } }), "list");

    const marks = screen.getAllByText("已读完", { exact: true });
    expect(marks).toHaveLength(1);
    expect(screen.getByTestId("card-cover").contains(marks[0])).toBe(false);
  });

  it("列表视图的未读标记带可读文字而不是只有一颗点", () => {
    renderCard(card(), "list");

    expect(screen.getByText("未读")).toBeInTheDocument();
  });
});

describe("AlbumCard 收藏星标", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ toasts: [] });
  });

  it.each(["grid", "list"] as const)(
    "%s 模式的星标在链接之外，点击写入收藏并给出中文提示",
    async (variant) => {
      renderCard(card(), variant);

      // 星标必须是链接的兄弟节点：在 <a> 里嵌按钮会让 Enter 冒泡触发跳转。
      const link = screen.getByRole("link", { name: "打开相册“周末记录”" });
      expect(link.querySelector("button")).toBeNull();

      const star = screen.getByRole("button", { name: "收藏「周末记录」" });
      fireEvent.click(star);

      await waitFor(() =>
        expect(favoritesApi.add).toHaveBeenCalledWith("album-1"),
      );
      await waitFor(() =>
        expect(useUIStore.getState().toasts.at(-1)?.message).toBe(
          "已收藏「周末记录」",
        ),
      );
    },
  );

  it("已收藏时按钮标记为按下并给出取消收藏的名称", () => {
    renderCard(card({ isFavorite: true }));

    const star = screen.getByRole("button", { name: "取消收藏「周末记录」" });
    expect(star).toHaveAttribute("aria-pressed", "true");
  });

  it("收藏失败时给出中文错误提示而不是静默失败", async () => {
    vi.mocked(favoritesApi.add).mockRejectedValueOnce(new Error("boom"));
    renderCard(card());

    fireEvent.click(screen.getByRole("button", { name: "收藏「周末记录」" }));

    await waitFor(() =>
      expect(useUIStore.getState().toasts.at(-1)?.message).toBe(
        "收藏失败，请稍后重试",
      ),
    );
  });
});


describe("AlbumCard 触摸长按", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // React Router 的 Link 自己就会 preventDefault 再跳转，所以不能用
  // 「事件有没有被取消」来判断有没有跳转 —— 直接看有没有换页。
  function renderCardWithRoute(data: CardData) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="/albums/album-1" element={<div>album-page</div>} />
            <Route path="*" element={<AlbumCard data={data} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  function mockCoarsePointer() {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("pointer: coarse"),
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList,
    );
  }

  // 触摸设备没有悬停，长按是唯一能唤起预览的方式。
  it("长按 400ms 唤起预览", () => {
    vi.useFakeTimers();
    mockCoarsePointer();
    renderCard(card());

    const tile = screen.getByTestId("card-cover").parentElement as HTMLElement;
    expect(screen.queryByTestId("hover-preview")).not.toBeInTheDocument();

    fireEvent.pointerDown(tile, { pointerType: "touch" });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByTestId("hover-preview")).toBeInTheDocument();
  });

  // 长按之后的那次抬手不能算点击 —— 否则用户看完预览松手却又被带进
  // 相册。
  it("长按唤起预览后，这一次抬手不再跳进相册", () => {
    vi.useFakeTimers();
    mockCoarsePointer();
    renderCardWithRoute(card());

    const tile = screen.getByTestId("card-cover").parentElement as HTMLElement;
    fireEvent.pointerDown(tile, { pointerType: "touch" });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.pointerUp(tile, { pointerType: "touch" });

    fireEvent.click(screen.getByRole("link"));
    expect(screen.queryByText("album-page")).not.toBeInTheDocument();
  });

  // 普通点击仍然照常跳转。
  it("没有长按时，点击照常跳进相册", () => {
    vi.useFakeTimers();
    mockCoarsePointer();
    renderCardWithRoute(card());

    const tile = screen.getByTestId("card-cover").parentElement as HTMLElement;
    fireEvent.pointerDown(tile, { pointerType: "touch" });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.pointerUp(tile, { pointerType: "touch" });

    fireEvent.click(screen.getByRole("link"));
    expect(screen.getByText("album-page")).toBeInTheDocument();
  });
});
