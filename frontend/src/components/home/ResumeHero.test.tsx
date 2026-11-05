import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ResumeHero from "./ResumeHero";
import type { CardData } from "../album/AlbumGrid";

function card(overrides: Partial<CardData> = {}): CardData {
  return {
    id: "a_1",
    variant: "album",
    title: "2023 年夏天",
    count: 128,
    imageCount: 128,
    videoCount: 0,
    coverPath: "f_1/cover.jpg",
    to: "/photo/albums/a_1",
    contentKind: "photo",
    lastSeenAt: "2024-05-01T00:00:00Z",
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

describe("照片工作台的「接着看」专区", () => {
  it("给出最近看过的那本，并链接回照片侧", () => {
    renderHero(<ResumeHero cards={[card()]} />);

    const hero = screen.getByTestId("resume-hero");
    expect(hero.textContent).toContain("接着看");
    expect(hero.textContent).toContain("2023 年夏天");
    expect(hero.textContent).toContain("128 张");
    // 照片侧的照片墙路由，不能串到漫画侧的阅读器。
    expect(screen.getByRole("link", { name: "接着看" })).toHaveAttribute(
      "href",
      "/photo/albums/a_1",
    );
  });

  it("没有浏览记录时不渲染该区块", () => {
    renderHero(<ResumeHero cards={[]} />);
    expect(screen.queryByTestId("resume-hero")).toBeNull();
  });

  it("其余最近看过的相册以紧凑行列出", () => {
    renderHero(
      <ResumeHero
        cards={[
          card(),
          card({ id: "a_2", title: "海边", to: "/photo/albums/a_2" }),
        ]}
      />,
    );
    expect(screen.getByText("海边")).toBeInTheDocument();
    expect(screen.getByText("2 本最近看过")).toBeInTheDocument();
  });

  it("不出现漫画侧的进度措辞", () => {
    renderHero(<ResumeHero cards={[card()]} />);
    const hero = screen.getByTestId("resume-hero");
    expect(hero.textContent).not.toContain("读到");
    expect(hero.textContent).not.toContain("已读完");
  });
});
