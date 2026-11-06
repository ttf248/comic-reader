import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
