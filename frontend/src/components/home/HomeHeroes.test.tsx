import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { ContinueHero, UnreadHero } from "./HomeHeroes";
import type { CardData } from "../album/AlbumGrid";

vi.mock("../../hooks/useFavorites", () => ({
  useFavorites: () => ({
    favorites: [],
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useToggleFavorite: () => vi.fn(),
}));

vi.mock("../common/HoverPreview", () => ({
  default: () => <div data-testid="hover-preview" />,
}));

vi.mock("../common/TranscodeStatusBadge", () => ({
  default: () => null,
}));

function card(index: number): CardData {
  return {
    id: `a_${index}`,
    variant: "album",
    title: `第${index}卷`,
    count: 10,
    imageCount: 10,
    coverPath: `cover-${index}`,
    coverKind: "image",
    to: `/comic/albums/a_${index}`,
    contentKind: "comic",
  };
}

function renderContinue(cards: CardData[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ContinueHero
          cards={cards}
          onContinue={vi.fn()}
          onRemove={vi.fn()}
          onClearAll={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderHero(count: number, cards: CardData[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <UnreadHero
          cards={cards}
          count={count}
          onShuffle={vi.fn()}
          onMarkRead={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// 面板只摆四本预览，标题上写的却是未读的总数。两个数字必须对得上，
// 否则读者会以为少渲染了两本。
it("未读总数多于摆出来的本数时补一句差额", () => {
  renderHero(6, [card(1), card(2), card(3), card(4)]);

  expect(screen.getByText(/还有 2 卷没读/)).toBeInTheDocument();
});

it("总数与摆出来的本数相同时不说差额", () => {
  renderHero(4, [card(1), card(2), card(3), card(4)]);

  expect(screen.queryByText(/还有/)).not.toBeInTheDocument();
});

it("只摆得下四本时按实际摆出来的数算差额", () => {
  renderHero(3, [card(1), card(2)]);

  expect(screen.getByText(/还有 1 卷没读/)).toBeInTheDocument();
});

// 主角那一栏写的是「第1卷」：不补上所属作品，这一卷属于哪部作品
// 看不出来 —— 与书封、阅读器顶栏同一套写法。
it("继续阅读的主角补上所属作品", () => {
  renderContinue([{ ...card(1), parentName: "星海漫步" }]);

  expect(screen.getByText("星海漫步")).toBeInTheDocument();
  expect(screen.getByText("第1卷")).toBeInTheDocument();
});

it("没有所属作品时只写卷名", () => {
  renderContinue([card(1)]);

  expect(screen.getByText("第1卷")).toBeInTheDocument();
});
