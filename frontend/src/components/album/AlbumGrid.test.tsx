import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AlbumGrid, { type CardData } from "./AlbumGrid";
import type { ReactNode } from "react";

const virtuoso = vi.hoisted(() => ({
  grid: vi.fn(),
  list: vi.fn(),
}));

// Virtuoso 的泛型在 mock 里退化成 unknown：列表视图的数据是"行"，
// 网格视图的数据是单张卡片，两者的形状由被测代码决定。
interface VirtualizedProps {
  data: readonly unknown[];
  itemContent: (index: number, item: never) => ReactNode;
  useWindowScroll?: boolean;
  customScrollParent?: HTMLElement;
  computeItemKey?: (index: number, item: never) => string;
  [key: string]: unknown;
}

vi.mock("react-virtuoso", () => ({
  // 列表视图的数据是"行"：单列时一行一张卡，超宽屏时一行两张并排。
  Virtuoso: ({ data, itemContent, ...props }: VirtualizedProps) => {
    virtuoso.list({ ...props, data });
    return (
      <div data-testid="virtual-list">
        {data.map((row: unknown, index: number) => (
          <div key={index}>{itemContent(index, row as never)}</div>
        ))}
      </div>
    );
  },
  VirtuosoGrid: ({ data, itemContent, ...props }: VirtualizedProps) => {
    virtuoso.grid({ ...props, data });
    return (
      <div data-testid="virtual-grid">
        {data.map((item: unknown, index: number) => (
          <div key={index}>{itemContent(index, item as never)}</div>
        ))}
      </div>
    );
  },
}));

// AlbumCard 在本文件里被 mock 掉（避免 react-query 依赖），
// 但把收到的 coverRatio 透出来，供断言"页面语义 → 画幅"这条契约。
const albumCardMock = vi.hoisted(() => ({ props: [] as unknown[] }));
vi.mock("./AlbumCard", () => ({
  default: (props: { data: CardData; coverRatio?: string }) => {
    albumCardMock.props.push(props);
    return <article>{props.data.title}</article>;
  },
}));
vi.mock("../../hooks/useFavorites", () => ({
  useFavorites: () => ({ favorites: [], toggle: vi.fn() }),
}));
vi.mock("../common/PropertiesDialog", () => ({ default: () => null }));

const mediaQuery = vi.hoisted(() => ({ matches: false }));
vi.mock("../../hooks/useMediaQuery", () => ({
  useMediaQuery: () => mediaQuery.matches,
}));

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
    mediaQuery.matches = false;
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

  it("封面画幅与网格密度按页面语义可切换", () => {
    albumCardMock.props.length = 0;
    // 收藏页 = 精选陈列：2:3 海报比例 + 疏朗网格（minmax 224px）
    const { unmount } = render(
      <AlbumGrid items={cards} variant="grid" coverRatio="2/3" cardMinWidth={224} />,
    );
    let props = virtuoso.grid.mock.calls[0]?.[0] as { listClassName: string };
    expect(props.listClassName).toContain("minmax(224px,1fr)");
    expect(
      albumCardMock.props.every(
        (p) => (p as { coverRatio?: string }).coverRatio === "2/3",
      ),
    ).toBe(true);
    unmount();

    // 未读 / 最近 / 全部图像 = 清单与浏览：默认 4:5 + 密集网格
    virtuoso.grid.mockClear();
    albumCardMock.props.length = 0;
    render(<AlbumGrid items={cards} variant="grid" />);
    props = virtuoso.grid.mock.calls[0]?.[0] as { listClassName: string };
    expect(props.listClassName).toContain("minmax(164px,1fr)");
    expect(
      albumCardMock.props.every(
        (p) => (p as { coverRatio?: string }).coverRatio === "4/5",
      ),
    ).toBe(true);
  });

  it("独立列表使用窗口滚动并保留稳定卡片键", () => {
    render(<AlbumGrid items={cards} variant="list" />);

    expect(screen.getByTestId("virtual-list")).toBeInTheDocument();
    const props = virtuoso.list.mock.calls[0]?.[0] as {
      useWindowScroll: boolean;
      data: CardData[][];
      computeItemKey: (index: number, row: CardData[]) => string;
    };
    expect(props.useWindowScroll).toBe(true);
    expect(props.computeItemKey(0, [cards[0]])).toBe("a_1");
  });

  it("窄屏列表一行一张卡，超宽屏列表一行两张并排", () => {
    mediaQuery.matches = false;
    render(<AlbumGrid items={cards} variant="list" />);
    let props = virtuoso.list.mock.calls[0]?.[0] as { data: CardData[][] };
    expect(props.data).toHaveLength(2);
    expect(props.data[0]).toHaveLength(1);

    virtuoso.list.mockClear();
    mediaQuery.matches = true;
    render(<AlbumGrid items={cards} variant="list" />);
    props = virtuoso.list.mock.calls[0]?.[0] as { data: CardData[][] };
    expect(props.data).toHaveLength(1);
    expect(props.data[0].map((c) => c.id)).toEqual(["a_1", "a_2"]);
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
