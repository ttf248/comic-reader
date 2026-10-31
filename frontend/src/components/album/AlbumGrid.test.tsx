import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AlbumGrid, { type CardData } from "./AlbumGrid";
import type { ReactNode } from "react";

const virtuoso = vi.hoisted(() => ({
  grid: vi.fn(),
  list: vi.fn(),
}));

interface VirtualizedProps {
  data: readonly CardData[];
  itemContent: (index: number, item: CardData) => ReactNode;
  useWindowScroll?: boolean;
  customScrollParent?: HTMLElement;
  computeItemKey?: (index: number, item: CardData) => string;
  [key: string]: unknown;
}

vi.mock("react-virtuoso", () => ({
  Virtuoso: ({ data, itemContent, ...props }: VirtualizedProps) => {
    virtuoso.list(props);
    return (
      <div data-testid="virtual-list">
        {data.map((item: CardData, index: number) => (
          <div key={item.id}>{itemContent(index, item)}</div>
        ))}
      </div>
    );
  },
  VirtuosoGrid: ({ data, itemContent, ...props }: VirtualizedProps) => {
    virtuoso.grid(props);
    return (
      <div data-testid="virtual-grid">
        {data.map((item: CardData, index: number) => (
          <div key={item.id}>{itemContent(index, item)}</div>
        ))}
      </div>
    );
  },
}));

vi.mock("./AlbumCard", () => ({
  default: ({ data }: { data: CardData }) => <article>{data.title}</article>,
}));
vi.mock("../../hooks/useFavorites", () => ({
  useFavorites: () => ({ favorites: [], toggle: vi.fn() }),
}));
vi.mock("../common/PropertiesDialog", () => ({ default: () => null }));

const cards: CardData[] = [
  {
    id: "a_1",
    variant: "album",
    title: "第一本",
    count: 3,
    imageCount: 3,
    coverPath: "cover-1",
    to: "/albums/a_1",
  },
  {
    id: "a_2",
    variant: "album",
    title: "第二本",
    count: 6,
    imageCount: 6,
    coverPath: "cover-2",
    to: "/albums/a_2",
  },
];

describe("AlbumGrid", () => {
  beforeEach(() => {
    virtuoso.grid.mockClear();
    virtuoso.list.mockClear();
  });

  it("独立网格使用窗口滚动并保留稳定卡片键", () => {
    render(<AlbumGrid items={cards} variant="grid" />);

    expect(screen.getByTestId("virtual-grid")).toBeInTheDocument();
    expect(screen.getByText("第一本")).toBeInTheDocument();
    const props = virtuoso.grid.mock.calls[0]?.[0] as {
      useWindowScroll: boolean;
      computeItemKey: (index: number, item: CardData) => string;
    };
    expect(props.useWindowScroll).toBe(true);
    expect(props.computeItemKey(1, cards[1])).toBe("a_2");
  });

  it("独立列表使用窗口滚动并保留稳定卡片键", () => {
    render(<AlbumGrid items={cards} variant="list" />);

    expect(screen.getByTestId("virtual-list")).toBeInTheDocument();
    const props = virtuoso.list.mock.calls[0]?.[0] as {
      useWindowScroll: boolean;
      computeItemKey: (index: number, item: CardData) => string;
    };
    expect(props.useWindowScroll).toBe(true);
    expect(props.computeItemKey(0, cards[0])).toBe("a_1");
  });

  it.each(["grid", "list"] as const)("%s 模式使用主内容区域滚动", (mode) => {
    render(
      <main style={{ overflowY: "auto" }} data-testid="scroll-area">
        <section>
          <AlbumGrid items={cards} variant={mode} />
        </section>
      </main>,
    );
    const calls = mode === "grid" ? virtuoso.grid : virtuoso.list;
    const props = calls.mock.lastCall?.[0] as VirtualizedProps;
    expect(props.customScrollParent).toBe(screen.getByTestId("scroll-area"));
    expect(props.useWindowScroll).toBe(false);
  });

  it.each(["grid", "list"] as const)(
    "%s 模式优先使用集合内层滚动区域",
    (mode) => {
      render(
        <main style={{ overflowY: "auto" }}>
          <div style={{ overflowY: "auto" }} data-testid="scroll-area">
            <AlbumGrid items={cards} variant={mode} />
          </div>
        </main>,
      );
      const calls = mode === "grid" ? virtuoso.grid : virtuoso.list;
      const props = calls.mock.lastCall?.[0] as VirtualizedProps;
      expect(props.customScrollParent).toBe(screen.getByTestId("scroll-area"));
      expect(props.useWindowScroll).toBe(false);
    },
  );

  it("从空结果加载出卡片后绑定滚动区域", () => {
    const view = (items: CardData[]) => (
      <main style={{ overflowY: "auto" }} data-testid="scroll-area">
        <AlbumGrid items={items} variant="grid" />
      </main>
    );
    const { rerender } = render(view([]));
    expect(virtuoso.grid).not.toHaveBeenCalled();
    rerender(view(cards));
    const props = virtuoso.grid.mock.lastCall?.[0] as VirtualizedProps;
    expect(props.customScrollParent).toBe(screen.getByTestId("scroll-area"));
    expect(props.useWindowScroll).toBe(false);
  });
});
