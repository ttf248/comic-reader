import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ListRange } from "react-virtuoso";
import { beforeEach, expect, it, vi } from "vitest";
import VirtualMediaGrid from "./VirtualMediaGrid";

const viewport = vi.hoisted(() => ({ width: 390 }));
vi.mock("../../hooks/useMediaQuery", () => ({
  useMediaQuery: (query: string) =>
    viewport.width >= Number(query.match(/\d+/)?.[0]),
}));
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
    rangeChanged,
  }: {
    data: { startIndex: number; items: (string | null)[] }[];
    itemContent: (
      index: number,
      row: { startIndex: number; items: (string | null)[] },
    ) => ReactNode;
    rangeChanged: (range: ListRange) => void;
  }) => (
    <>
      <button
        onClick={() =>
          rangeChanged({ startIndex: 1, endIndex: data.length - 1 })
        }
      >
        滚动至末行
      </button>
      {data.map((row, index) => (
        <div key={row.startIndex} data-testid="media-row">
          {itemContent(index, row)}
        </div>
      ))}
    </>
  ),
}));

const items = Array.from({ length: 10 }, (_, index) => `媒体 ${index}`);

beforeEach(() => {
  viewport.width = 390;
});

it("点击分组后的条目仍使用原始媒体序号，分页范围覆盖不满一行的末项", () => {
  const open = vi.fn();
  const rangeChanged = vi.fn();
  render(
    <VirtualMediaGrid
      data={[...items.slice(0, 9), null]}
      computeItemKey={(index, item) => item ?? `placeholder-${index}`}
      rangeChanged={rangeChanged}
      itemContent={(index, item) =>
        item ? (
          <button onClick={() => open(index)}>{item}</button>
        ) : (
          <span>第 {index + 1} 项加载中</span>
        )
      }
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "媒体 4" }));
  expect(open).toHaveBeenCalledWith(4);
  expect(screen.getByText("第 10 项加载中")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "滚动至末行" }));
  expect(rangeChanged).toHaveBeenCalledWith({ startIndex: 3, endIndex: 9 });
});

it("跨断点重排后保持媒体顺序，并按新的列数映射分页范围", () => {
  const rangeChanged = vi.fn();
  const props = {
    data: items,
    computeItemKey: (_: number, item: string) => item,
    rangeChanged,
    itemContent: (_: number, item: string) => <span>{item}</span>,
  };
  const { rerender } = render(<VirtualMediaGrid {...props} />);
  expect(screen.getAllByTestId("media-row")).toHaveLength(4);
  viewport.width = 1440;
  rerender(<VirtualMediaGrid {...props} />);
  expect(screen.getAllByTestId("media-row")).toHaveLength(2);
  expect(
    screen.getAllByText(/^媒体 \d+$/).map((item) => item.textContent),
  ).toEqual(items);
  fireEvent.click(screen.getByRole("button", { name: "滚动至末行" }));
  expect(rangeChanged).toHaveBeenLastCalledWith({ startIndex: 6, endIndex: 9 });
});
