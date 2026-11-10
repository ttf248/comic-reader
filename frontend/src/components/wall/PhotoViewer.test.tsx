import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
