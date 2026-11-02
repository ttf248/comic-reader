import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AlbumGridSkeleton from "./AlbumGridSkeleton";

describe("AlbumGridSkeleton 加载骨架", () => {
  it("网格骨架按真实卡片的 4:5 封面 + 标题行 + 元信息行画，且数量可控", () => {
    const { container } = render(<AlbumGridSkeleton count={6} />);

    const cards = container.querySelectorAll(
      '[data-testid="album-skeleton-cards"] > div',
    );
    expect(cards).toHaveLength(6);
    // 封面块与真实卡片同为 4:5，数据到达时卡片落在同一位置。
    expect(
      container.querySelector('[class*="aspect-[4/5]"]'),
    ).not.toBeNull();
  });

  it("列表骨架按真实行的缩略图 + 两行文字画", () => {
    const { container } = render(
      <AlbumGridSkeleton variant="list" rows={4} />,
    );

    expect(
      container.querySelectorAll('[data-testid="album-skeleton-rows"] > div'),
    ).toHaveLength(4);
    // 缩略图与真实列表一致：56×70。
    expect(container.querySelector('[class*="h-[70px]"]')).not.toBeNull();
  });

  it("对读屏软件是一个状态提示，装饰部分对读屏隐藏", () => {
    render(<AlbumGridSkeleton />);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-label", "正在加载图像…");
    expect(status.querySelector("[aria-hidden='true']")).not.toBeNull();
  });

  it("bare 模式不自带 page-shell，避免与调用方的容器叠加留白", () => {
    const { container } = render(<AlbumGridSkeleton bare />);
    expect(container.firstElementChild?.className).not.toContain("page-shell");

    const withShell = render(<AlbumGridSkeleton />);
    expect(withShell.container.firstElementChild?.className).toContain(
      "page-shell",
    );
  });
});
