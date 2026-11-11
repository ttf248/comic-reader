import {
  act,
  fireEvent,
  render as testingRender,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryMediaItem } from "../../api/library";
import PhotoViewer from "./PhotoViewer";

// 图片信息面板自己去取属性；这里只需要它出现 / 消失。
vi.mock("../../hooks/useImageInfo", () => ({
  useImageInfo: () => ({
    info: {
      name: "a.jpg",
      width: 800,
      height: 600,
      format: "jpeg",
      size: 65536,
      mtime: "2024-01-01T00:00:00Z",
    },
    err: null,
    loading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../api/aiJobs", () => ({
  aiJobsApi: { metadata: vi.fn().mockResolvedValue({ status: "pending" }) },
}));

function render(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return testingRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

const items: LibraryMediaItem[] = [
  {
    id: "f_1",
    kind: "image",
    name: "a.jpg",
    width: 800,
    height: 600,
  } as LibraryMediaItem,
  {
    id: "f_2",
    kind: "image",
    name: "b.jpg",
    width: 800,
    height: 600,
  } as LibraryMediaItem,
];

function renderViewer(onClose = vi.fn()) {
  render(
    <PhotoViewer
      items={items}
      index={0}
      albumName="测试相册"
      onIndexChange={vi.fn()}
      onClose={onClose}
    />,
  );
  return onClose;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("大图预览的精选与对比", () => {
  it("P 键切换这张照片的精选", () => {
    const onTogglePick = vi.fn();
    render(
      <PhotoViewer
        items={items}
        index={0}
        albumName="测试相册"
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
        isPicked={false}
        onTogglePick={onTogglePick}
      />,
    );

    fireEvent.keyDown(window, { key: "p" });
    expect(onTogglePick).toHaveBeenCalledTimes(1);
  });

  it("查找相似照片按钮使用当前照片触发搜索", () => {
    const onFindSimilar = vi.fn();
    render(
      <PhotoViewer
        items={items}
        index={1}
        albumName="测试相册"
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
        onFindSimilar={onFindSimilar}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "查找相似照片" }));
    expect(onFindSimilar).toHaveBeenCalledTimes(1);
  });

  it("C 键放进对比", () => {
    const onToggleCompare = vi.fn();
    render(
      <PhotoViewer
        items={items}
        index={0}
        albumName="测试相册"
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
        onToggleCompare={onToggleCompare}
      />,
    );

    fireEvent.keyDown(window, { key: "c" });
    expect(onToggleCompare).toHaveBeenCalledTimes(1);
  });

  it("并排对比开在上层时，预览不接按键：两层浮层不抢同一个键", () => {
    const onClose = vi.fn();
    const onIndexChange = vi.fn();
    render(
      <PhotoViewer
        items={items}
        index={0}
        albumName="测试相册"
        onIndexChange={onIndexChange}
        onClose={onClose}
        compareOpen
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onClose).not.toHaveBeenCalled();
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it("相册级收藏与照片级精选是两种标记，标题各说各的", () => {
    render(
      <PhotoViewer
        items={items}
        index={0}
        albumName="测试相册"
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
        isFavorite
        onToggleFavorite={vi.fn()}
        isPicked
        onTogglePick={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "取消收藏这本相册" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "把这张移出精选" }),
    ).toBeInTheDocument();
  });

  it("总数报相册里的总数，不报已加载的条目数", () => {
    render(
      <PhotoViewer
        items={items}
        index={0}
        albumName="测试相册"
        totalCount={403}
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/共 403 张/)).toBeInTheDocument();
  });

  it("给了相册地址时，标题是可点回那本的链接", () => {
    render(
      <MemoryRouter>
        <PhotoViewer
          items={items}
          index={0}
          albumName="2012年"
          albumHref="/photo/albums/a_1"
          onIndexChange={vi.fn()}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", { name: "2012年" });
    expect(link).toHaveAttribute("href", "/photo/albums/a_1");
  });
});

// 面板开着时 Esc 先收面板：两层浮层分得清，不必连按两次才能退出预览。
describe("大图预览的 Esc", () => {
  it("信息面板开着时，Esc 只关面板，预览还在", async () => {
    const onClose = renderViewer();
    fireEvent.click(screen.getByRole("button", { name: "图片信息" }));
    await waitFor(() =>
      expect(screen.getByTestId("image-info-panel")).toBeInTheDocument(),
    );

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("image-info-panel")).not.toBeInTheDocument(),
    );
    expect(onClose).not.toHaveBeenCalled();
    // 预览本体还在：底栏的缩放控件仍然可点。
    expect(screen.getByRole("button", { name: "放大" })).toBeInTheDocument();
  });

  it("面板没开时，Esc 退出预览", () => {
    const onClose = renderViewer();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// 跨相册连续浏览：年度照片墙有几千张，预览不能停在已加载的那一段。
describe("大图预览的连续浏览", () => {
  const page = [
    { id: "f_3", kind: "image", name: "c.jpg", index: 2, kindIndex: 2 },
    { id: "f_4", kind: "image", name: "d.jpg", index: 3, kindIndex: 3 },
  ] as LibraryMediaItem[];

  it("翻到已加载的末尾时去取下一页，取到后自动接上这一张", async () => {
    const onLoadMore = vi.fn();
    const onIndexChange = vi.fn();
    const { rerender } = render(
      <PhotoViewer
        items={items}
        index={1}
        albumName="测试相册"
        hasNextPage
        onLoadMore={onLoadMore}
        onIndexChange={onIndexChange}
        onClose={vi.fn()}
      />,
    );

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onLoadMore).toHaveBeenCalled();

    // 下一页到了：自动接到第一张新照片上，用户不必再按一次。
    rerender(
      <PhotoViewer
        items={[...items, ...page]}
        index={1}
        albumName="测试相册"
        hasNextPage
        onLoadMore={onLoadMore}
        onIndexChange={onIndexChange}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(onIndexChange).toHaveBeenCalledWith(2));
  });

  it("取页失败时给一个重试的手柄，已加载的内容仍可翻", () => {
    const onLoadMore = vi.fn();
    render(
      <PhotoViewer
        items={items}
        index={0}
        albumName="测试相册"
        hasNextPage
        loadMoreError
        onLoadMore={onLoadMore}
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("后续照片加载失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onLoadMore).toHaveBeenCalled();
  });

  it("还有下一页时下一张不灰：灰掉等于告诉用户后面没有了", () => {
    render(
      <PhotoViewer
        items={items}
        index={1}
        albumName="测试相册"
        hasNextPage
        onLoadMore={vi.fn()}
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "下一张" })).toBeEnabled();
  });

  it("确实没有下一页时下一张才灰", () => {
    render(
      <PhotoViewer
        items={items}
        index={1}
        albumName="测试相册"
        hasNextPage={false}
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "下一张" })).toBeDisabled();
  });

  it("连按「下一张」每一下都翻一张，不被上一拍的序号吞掉", () => {
    const onIndexChange = vi.fn();
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `f_${i}`,
      kind: "image" as const,
      name: `${i}.jpg`,
      index: i,
      kindIndex: i,
    })) as LibraryMediaItem[];
    render(
      <PhotoViewer
        items={many}
        index={0}
        albumName="测试相册"
        onIndexChange={onIndexChange}
        onClose={vi.fn()}
      />,
    );
    // 一次 act 里连按五次：中间不重渲染，序号还停在 props 上。
    // 按 props 算的话，五次都会算成同一张，照片在原地不动。
    act(() => {
      for (let i = 0; i < 5; i += 1) {
        fireEvent.keyDown(window, { key: "ArrowRight" });
      }
    });
    expect(onIndexChange.mock.calls.map((call) => call[0])).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("翻到视频时方向键仍然翻照片，不会被视频的快进抢走", () => {
    const onIndexChange = vi.fn();
    const withVideo: LibraryMediaItem[] = [
      { id: "f_1", kind: "image", name: "a.jpg", index: 0, kindIndex: 0 },
      { id: "f_2", kind: "video", name: "b.mp4", index: 1, kindIndex: 0 },
      { id: "f_3", kind: "image", name: "c.jpg", index: 2, kindIndex: 1 },
    ] as LibraryMediaItem[];
    render(
      <PhotoViewer
        items={withVideo}
        index={1}
        albumName="测试相册"
        onIndexChange={onIndexChange}
        onClose={vi.fn()}
      />,
    );
    // 视频那一格：方向键仍然是「上一张 / 下一张」。
    // （位置记在预览自己身上，所以上一个是第 2 张 —— 上一格。）
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onIndexChange).toHaveBeenCalledWith(2);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  it("按住不放时，页到了就一次翻过按过的那几次", async () => {
    const onIndexChange = vi.fn();
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <PhotoViewer
        items={items}
        index={0}
        albumName="测试相册"
        hasNextPage
        onLoadMore={onLoadMore}
        onIndexChange={onIndexChange}
        onClose={vi.fn()}
      />,
    );
    // 在已加载的末尾连按三次：第一次还在范围内，后两次要等下一页。
    act(() => {
      for (let i = 0; i < 3; i += 1) {
        fireEvent.keyDown(window, { key: "ArrowRight" });
      }
    });
    expect(onIndexChange.mock.calls.map((call) => call[0])).toEqual([1]);
    expect(onLoadMore).toHaveBeenCalled();

    // 下一页到了：那两次按键一次性补上。
    rerender(
      <PhotoViewer
        items={[...items, ...page]}
        index={1}
        albumName="测试相册"
        hasNextPage
        onLoadMore={onLoadMore}
        onIndexChange={onIndexChange}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(onIndexChange.mock.calls.map((call) => call[0])).toEqual([1, 3]),
    );
  });
});
