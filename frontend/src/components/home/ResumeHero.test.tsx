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

  it("其余最近看过的相册排成一排小方照", () => {
    renderHero(
      <ResumeHero
        cards={[
          card(),
          card({ id: "a_2", title: "海边", to: "/photo/albums/a_2" }),
        ]}
      />,
    );
    expect(screen.getByText("海边")).toBeInTheDocument();
    expect(screen.getByText("2 本相册")).toBeInTheDocument();
    // 队列是展陈墙上的一排次级展品，不是一列三行 —— 一列三行只占住
    // 面板的右上角，中间与右下都空着。
    expect(document.querySelector(".resume-shelf")).toBeTruthy();
    expect(document.querySelector(".resume-queue")).toBeNull();
  });

  it("还有几本最近看过的出口写在标题行，不飘在面板底下", () => {
    renderHero(
      <ResumeHero
        cards={[
          card(),
          card({ id: "a_2", title: "海边", to: "/photo/albums/a_2" }),
          card({ id: "a_3", title: "山里", to: "/photo/albums/a_3" }),
          card({ id: "a_4", title: "公司", to: "/photo/albums/a_4" }),
          card({ id: "a_5", title: "路上", to: "/photo/albums/a_5" }),
        ]}
      />,
    );
    const link = screen.getByRole("link", { name: /还有 1 本最近看过/ });
    expect(link).toHaveAttribute("href", "/photo/recents");
  });

  it("不出现漫画侧的进度措辞", () => {
    renderHero(<ResumeHero cards={[card()]} />);
    const hero = screen.getByTestId("resume-hero");
    expect(hero.textContent).not.toContain("读到");
    expect(hero.textContent).not.toContain("已读完");
  });
});
