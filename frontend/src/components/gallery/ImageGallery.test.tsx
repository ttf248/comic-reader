import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGalleryStore } from "../../store/galleryStore";
import ImageGallery from "./ImageGallery";

const virtuosoMocks = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
}));

function dispatchPointerEvent(
  target: Element,
  type: string,
  init: Record<string, string | number>,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(init)) {
    Object.defineProperty(event, key, {
      configurable: true,
      value,
    });
  }
  target.dispatchEvent(event);
}

vi.mock("react-virtuoso", async () => {
  const React = await import("react");
  interface MockVirtuosoProps {
    rangeChanged?: (range: { startIndex: number; endIndex: number }) => void;
  }

  return {
    Virtuoso: React.forwardRef<
      { scrollToIndex: typeof virtuosoMocks.scrollToIndex },
      MockVirtuosoProps
    >(function MockVirtuoso({ rangeChanged }, ref) {
      React.useImperativeHandle(ref, () => ({
        scrollToIndex: virtuosoMocks.scrollToIndex,
      }));
      return React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "virtuoso-range",
          onClick: () => rangeChanged?.({ startIndex: 2, endIndex: 3 }),
        },
        "更新可见范围",
      );
    }),
  };
});

describe("ImageGallery 连续模式", () => {
  beforeEach(() => {
    virtuosoMocks.scrollToIndex.mockClear();
    useGalleryStore.setState({
      index: 0,
      mode: "continuous",
      zoom: 1,
      rotation: 0,
      fit: "fit",
      direction: "ltr",
    });
  });

  it("把顶部可见图片索引上报给父组件且不产生反向滚动", () => {
    const onVisibleRangeChange = vi.fn((startIndex: number) => {
      useGalleryStore.getState().setIndex(startIndex);
    });
    render(
      <ImageGallery
        images={["/1.jpg", "/2.jpg", "/3.jpg", "/4.jpg"]}
        onVisibleRangeChange={onVisibleRangeChange}
      />,
    );
    virtuosoMocks.scrollToIndex.mockClear();

    fireEvent.click(screen.getByTestId("virtuoso-range"));

    expect(onVisibleRangeChange).toHaveBeenCalledWith(2, 3);
    expect(useGalleryStore.getState().index).toBe(2);
    expect(virtuosoMocks.scrollToIndex).not.toHaveBeenCalled();
  });

  it("外部页码变化时驱动虚拟列表定位到目标图片", async () => {
    render(<ImageGallery images={["/1.jpg", "/2.jpg", "/3.jpg", "/4.jpg"]} />);
    virtuosoMocks.scrollToIndex.mockClear();

    act(() => useGalleryStore.getState().setIndex(3));

    await waitFor(() => {
      expect(virtuosoMocks.scrollToIndex).toHaveBeenCalledWith({
        index: 3,
        align: "start",
      });
    });
  });
});

describe("ImageGallery 单页触摸手势", () => {
  beforeEach(() => {
    useGalleryStore.setState({
      index: 0,
      mode: "single",
      zoom: 1,
      rotation: 0,
      fit: "fit",
      direction: "ltr",
    });
  });

  it("左滑翻到下一张且不会再被合成 click 重复触发", () => {
    const onClickNavigate = vi.fn();
    render(
      <ImageGallery
        images={["/1.jpg", "/2.jpg", "/3.jpg"]}
        onClickNavigate={onClickNavigate}
      />,
    );
    const container = document.querySelector("[data-image-gallery]");
    if (!container) throw new Error("image gallery container not found");

    dispatchPointerEvent(container, "pointerdown", {
      pointerId: 1,
      pointerType: "touch",
      clientX: 300,
      clientY: 200,
    });
    dispatchPointerEvent(container, "pointermove", {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 205,
    });
    dispatchPointerEvent(container, "pointerup", {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 205,
    });

    expect(onClickNavigate).toHaveBeenCalledTimes(1);
    expect(onClickNavigate).toHaveBeenCalledWith(1);

    fireEvent.click(container, { clientX: 300, clientY: 200 });
    expect(onClickNavigate).toHaveBeenCalledTimes(1);
  });

  it("右滑翻到上一张", () => {
    const onClickNavigate = vi.fn();
    render(
      <ImageGallery
        images={["/1.jpg", "/2.jpg", "/3.jpg"]}
        onClickNavigate={onClickNavigate}
      />,
    );
    const container = document.querySelector("[data-image-gallery]");
    if (!container) throw new Error("image gallery container not found");

    dispatchPointerEvent(container, "pointerdown", {
      pointerId: 2,
      pointerType: "touch",
      clientX: 100,
      clientY: 200,
    });
    dispatchPointerEvent(container, "pointerup", {
      pointerId: 2,
      pointerType: "touch",
      clientX: 280,
      clientY: 205,
    });

    expect(onClickNavigate).toHaveBeenCalledWith(-1);
  });
});
