import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(screen.getByText("9 页 · 2 个视频")).toHaveAttribute(
      "title",
      "9 页 + 2 个视频",
    );
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
      expect(screen.getByText("3 本")).toBeInTheDocument();
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

  it("已读完的相册在封面右下角显示已读 chip，且不再显示未读点", () => {
    renderCard(card({ progress: { index: 11, total: 12 } }));

    expect(screen.getByText("已读完", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("未读")).not.toBeInTheDocument();
  });

  it("在读的相册不再显示未读点，状态由封面底部的进度条承担", () => {
    renderCard(card({ progress: { index: 3, total: 12 } }));

    expect(screen.queryByText("未读")).not.toBeInTheDocument();
    expect(screen.getByText("27%")).toBeInTheDocument();
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
