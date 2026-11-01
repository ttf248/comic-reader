import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AlbumCard, { type CardData } from "./AlbumCard";
import { useUIStore } from "../../store/uiStore";

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
    expect(screen.getByText("9 张 · 2 个视频")).toHaveAttribute(
      "title",
      "9 张图片 + 2 个视频",
    );
    expect(
      screen.queryByRole("button", { name: "重试" }),
    ).not.toBeInTheDocument();
  });

  it.each(["grid", "list"] as const)(
    "%s 模式使用真实链接、4:5 封面且没有嵌套按钮",
    (variant) => {
      renderCard(card(), variant);

      const link = screen.getByRole("link", { name: "打开相册“周末记录”" });
      expect(link).toHaveAttribute("href", "/albums/album-1");
      expect(link.querySelector("button")).toBeNull();
      expect(screen.getByTestId("card-cover")).toHaveClass("aspect-[4/5]");
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

    expect(screen.getByText("9 张 · 2 个视频")).toBeInTheDocument();
    expect(screen.getByText(/上次/)).toBeInTheDocument();
  });
});
