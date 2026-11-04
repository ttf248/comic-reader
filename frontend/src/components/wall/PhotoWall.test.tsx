import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ListRange } from "react-virtuoso";
import { beforeEach, expect, it, vi } from "vitest";
import PhotoWall from "./PhotoWall";

interface MockRow {
  key: string;
  height: number;
  tileHeight: number;
  tiles: { id: string; ratio: number; width: number }[];
}

const virtuoso = vi.hoisted(() => ({
  overscan: 0,
  increaseViewportBy: { top: 0, bottom: 0 },
}));

const pagination = vi.hoisted(() => ({ rangeChanged: vi.fn() }));

vi.mock("../../hooks/useMediaGridPagination", () => ({
  useMediaGridPagination: () => pagination.rangeChanged,
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
    rangeChanged,
    overscan,
    increaseViewportBy,
  }: {
    data: MockRow[];
    itemContent: (index: number, row: MockRow) => ReactNode;
    rangeChanged: (range: ListRange) => void;
    overscan: number;
    increaseViewportBy: { top: number; bottom: number };
  }) => {
    virtuoso.overscan = overscan;
    virtuoso.increaseViewportBy = increaseViewportBy;
    return (
      <>
        <button
          onClick={() => rangeChanged({ startIndex: 0, endIndex: data.length - 1 })}
        >
          滚动到末行
        </button>
        {data.map((row, index) => (
          <div key={row.key} data-testid="wall-row">
            {itemContent(index, row)}
          </div>
        ))}
      </>
    );
  },
}));

vi.mock("../../hooks/useElementWidth", () => ({
  useElementWidth: () => ({ ref: { current: null }, width: 1200 }),
}));

vi.mock("../common/ThumbImage", () => ({
  default: ({ alt }: { alt: string }) => <span>{alt}</span>,
}));
vi.mock("../common/VideoCoverImage", () => ({
  default: () => <span>视频封面</span>,
}));

const items = [
  { id: "f_1", kind: "image" as const, name: "1.jpg", index: 0, kindIndex: 0 },
  { id: "f_2", kind: "image" as const, name: "2.jpg", index: 1, kindIndex: 1 },
  { id: "f_3", kind: "video" as const, name: "3.mp4", index: 2, kindIndex: 0 },
];

beforeEach(() => {
  virtuoso.overscan = 0;
  virtuoso.increaseViewportBy = { top: 0, bottom: 0 };
  pagination.rangeChanged.mockClear();
});

it("按真实宽高比排布，并把已加载与未加载的条目都算进滚动长度", () => {
  render(
    <PhotoWall
      items={items}
      total={30}
      targetHeight={200}
      hasNextPage
      isLoadingMore={false}
      onLoadMore={() => {}}
      onOpen={() => {}}
    />,
  );

  // 30 个条目按 1200px 宽、200px 目标行高分成多行。
  const rows = screen.getAllByTestId("wall-row");
  expect(rows.length).toBeGreaterThan(1);
  expect(screen.getByText("1.jpg")).toBeInTheDocument();
  expect(screen.getByText("视频封面")).toBeInTheDocument();
});

it("回报的分页范围换算回原始媒体序号", () => {
  render(
    <PhotoWall
      items={items}
      total={30}
      targetHeight={200}
      hasNextPage
      isLoadingMore={false}
      onLoadMore={() => {}}
      onOpen={() => {}}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "滚动到末行" }));

  // 末行末尾对应整本相册的最后一张，序号按服务端媒体顺序换算。
  expect(pagination.rangeChanged).toHaveBeenCalledTimes(1);
  const range = pagination.rangeChanged.mock.calls[0][0];
  expect(range.startIndex).toBe(0);
  expect(range.endIndex).toBe(29);
});

it("虚拟窗口保持在安全范围内，避免 Virtuoso 一次性测量过多条目", () => {
  render(
    <PhotoWall
      items={items}
      total={5000}
      targetHeight={200}
      hasNextPage
      isLoadingMore={false}
      onLoadMore={() => {}}
      onOpen={() => {}}
    />,
  );

  // overscan / increaseViewportBy 贪心会让 Virtuoso 的尺寸树在一次测量里
  // 展开过深，触发「Maximum call stack size exceeded」。
  expect(virtuoso.overscan).toBeLessThanOrEqual(720);
  expect(virtuoso.increaseViewportBy.bottom).toBeLessThanOrEqual(720);
  expect(virtuoso.increaseViewportBy.top).toBeLessThanOrEqual(720);
});

it("点击图片把对应条目交给上层打开", () => {
  const onOpen = vi.fn();
  render(
    <PhotoWall
      items={items}
      total={3}
      targetHeight={200}
      hasNextPage={false}
      isLoadingMore={false}
      onLoadMore={() => {}}
      onOpen={onOpen}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "查看 1.jpg" }));
  expect(onOpen).toHaveBeenCalledWith(items[0], 0);
});
