import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import YearPhotos from "./YearPhotos";

const feed = vi.hoisted(() => ({
  items: [] as {
    id: string;
    kind: "image";
    name: string;
    index: number;
    kindIndex: number;
    albumId: string;
    albumName: string;
  }[],
  albums: [] as { id: string; name: string; count: number }[],
  sources: [] as { id: string; name: string; kind: string }[],
  total: 0,
}));

vi.mock("../hooks/useMediaFeed", () => ({
  useMediaFeed: () => ({
    items: feed.items,
    albums: feed.albums,
    sources: feed.sources,
    total: feed.total,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  }),
}));

// 虚拟列表在 jsdom 里没有尺寸：换成直接渲染全部行。
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: {
      key: string;
      height: number;
      tileHeight: number;
      tiles: { id: string; ratio: number; width: number }[];
    }[];
    itemContent: (index: number, row: never) => React.ReactNode;
  }) => (
    <>
      {data.map((row, index) => (
        <div key={row.key}>{itemContent(index, row as never)}</div>
      ))}
    </>
  ),
}));

// 照片墙按容器宽度排布：测试里给一个固定宽度。
vi.mock("../hooks/useElementSize", () => ({
  useElementSize: () => ({ ref: { current: null }, width: 1200, height: 800 }),
}));

vi.mock("../hooks/usePicks", () => ({
  usePicks: () => ({
    isPicked: () => false,
    toggle: vi.fn(),
    total: 0,
    isLoading: false,
  }),
}));

beforeEach(() => {
  feed.items = [
    {
      id: "f_1",
      kind: "image",
      name: "1.jpg",
      index: 0,
      kindIndex: 0,
      albumId: "a_1",
      albumName: "第一本",
    },
  ];
  feed.albums = [{ id: "a_1", name: "第一本", count: 1 }];
  feed.sources = [{ id: "c_1", name: "2024年", kind: "collection" }];
  feed.total = 449;
});

function renderYear() {
  return render(
    <MemoryRouter initialEntries={["/photo/years/2024"]}>
      <Routes>
        <Route path="/photo/years/:year" element={<YearPhotos />} />
      </Routes>
    </MemoryRouter>,
  );
}

it("页头说清是哪一年、多少张、来自几本相册", async () => {
  renderYear();
  expect(screen.getByRole("heading", { name: "2024 年" })).toBeTruthy();
  await waitFor(() => expect(screen.getByText("449")).toBeTruthy());
  expect(screen.getByText(/来自/)).toBeTruthy();
});

it("来源集合给出回到集合的入口", async () => {
  renderYear();
  const link = screen.getByRole("link", { name: "2024年" });
  expect(link.getAttribute("href")).toBe("/photo/albums/c_1");
});

it("照片墙标出每张照片出自哪本相册", async () => {
  renderYear();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "查看 1.jpg" })).toBeTruthy(),
  );
  // 悬停信息层显示相册名：跨相册的墙上，用户先要知道自己看的是哪本。
  expect(screen.getByText("第一本")).toBeTruthy();
});
