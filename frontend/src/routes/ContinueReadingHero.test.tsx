import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ContinueHero } from "../components/home/HomeHeroes";

function makeCard(path: string, name: string, index: number, total: number) {
  return {
    id: "i:" + path,
    variant: "album" as const,
    title: name,
    count: total,
    imageCount: total,
    videoCount: 0,
    coverPath: path + "/cover.jpg",
    coverKind: "image" as const,
    to: `/albums/${encodeURIComponent(path)}`,
    progress: { index, total },
  };
}

function renderHero(cards: ReturnType<typeof makeCard>[]) {
  const onContinue = vi.fn();
  const onRemove = vi.fn();
  const onClearAll = vi.fn();
  return {
    onContinue,
    onRemove,
    onClearAll,
    ...render(
      <MemoryRouter>
        <ContinueHero
          cards={cards}
          mode="comic"
          onContinue={onContinue}
          onRemove={onRemove}
          onClearAll={onClearAll}
        />
      </MemoryRouter>,
    ),
  };
}

describe("ContinueReadingHero", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("显示进度中相册数 + 第一张的进度文本", () => {
    renderHero([
      makeCard("/a", "A", 5, 20), // 5/20
    ]);
    // 标题:1 本还没看完
    const heroSection = screen.getByTestId("continue-hero");
    expect(heroSection.textContent).toMatch(/1\s*本还没看完/);
    // 进度文本 读到 6/20(index+1 / total)
    expect(screen.getByText(/读到\s*6\s*\/\s*20/)).toBeInTheDocument();
  });

  it("点击卡片触发 onContinue + 拿到对应 card", () => {
    const { onContinue } = renderHero([
      makeCard("/a", "A", 5, 20),
      makeCard("/b", "B", 12, 30),
    ]);
    const bCard = screen.getByRole("button", { name: "继续阅读「B」" });
    expect(bCard.tagName).toBe("BUTTON");
    fireEvent.click(bCard);
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onContinue.mock.calls[0][0].title).toBe("B");
    expect(onContinue.mock.calls[0][0].progress?.index).toBe(12);
  });

  it("在读预览最多四本，更多记录仍有最近阅读入口", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      makeCard(`/p${i}`, `P${i}`, i, 30),
    );
    const { container } = renderHero(many);
    const cardButtons = container.querySelectorAll(
      'button[aria-label^="将"][aria-label$="标记为已读完"]',
    );
    expect(cardButtons.length).toBe(4);
    expect(
      screen.getByRole("link", { name: /还有 16 本在读/ }),
    ).toHaveAttribute("href", "/recents");
  });

  it("没有在读相册时不渲染空阅读区", () => {
    renderHero([]);
    expect(screen.queryByTestId("continue-hero")).toBeNull();
  });

  it("点 X 触发 onRemove 且不冒泡到外层 onContinue", () => {
    const { onContinue, onRemove } = renderHero([makeCard("/a", "A", 5, 20)]);
    const xBtn = screen.getByLabelText("将A标记为已读完");
    fireEvent.click(xBtn);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove.mock.calls[0][0].title).toBe("A");
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("焦点在 X 按钮上按 Enter 时不会触发外层跳转", () => {
    const { onContinue } = renderHero([makeCard("/a", "A", 5, 20)]);
    const xBtn = screen.getByLabelText("将A标记为已读完");
    // keydown 从按钮冒泡；外层卡片不得把它当成自己的主操作。
    fireEvent.keyDown(xBtn, { key: "Enter" });
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("卡片的可访问名不包含 X 按钮的文案", () => {
    const { container } = renderHero([makeCard("/a", "A", 5, 20)]);
    const card = container.querySelector(".reading-cover") as HTMLElement;
    expect(card).not.toHaveAccessibleName(/标记为已读/);
  });

  it("点 清空 链接触发 onClearAll", () => {
    const { onClearAll } = renderHero([makeCard("/a", "A", 1, 10)]);
    const clearBtn = screen.getByTitle(/把当前所有继续阅读相册标记为已读/);
    fireEvent.click(clearBtn);
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });
});

it("主封面使用清晰预览，加载失败后仍可继续阅读", () => {
  const { container, onContinue } = renderHero([makeCard("/a", "A", 5, 20)]);
  const cover = container.querySelector(
    ".reading-cover img",
  ) as HTMLImageElement;
  expect(cover.src).toContain("/api/previews/");
  fireEvent.error(cover);
  expect(container.querySelector(".reading-cover img")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "继续阅读「A」" }));
  expect(onContinue).toHaveBeenCalledTimes(1);
});
