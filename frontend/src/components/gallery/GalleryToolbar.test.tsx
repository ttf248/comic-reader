import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import GalleryToolbar from "./GalleryToolbar";
import { useGalleryStore } from "../../store/galleryStore";

function renderToolbar(props: Partial<Parameters<typeof GalleryToolbar>[0]> = {}) {
  const onPrev = vi.fn();
  const onNext = vi.fn();
  const utils = render(
    <GalleryToolbar onPrev={onPrev} onNext={onNext} {...props} />,
  );
  return { onPrev, onNext, ...utils };
}

describe("GalleryToolbar 阅读控制", () => {
  it("是一个有中文可访问名的工具条", () => {
    renderToolbar();
    expect(screen.getByRole("toolbar", { name: "阅读控制" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一页" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一页" })).toBeInTheDocument();
  });

  it("可以直接切换阅读模式", () => {
    useGalleryStore.setState({ mode: "single" });
    renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "连续" }));
    expect(useGalleryStore.getState().mode).toBe("continuous");
    fireEvent.click(screen.getByRole("button", { name: "双页" }));
    expect(useGalleryStore.getState().mode).toBe("double");
  });

  it("适配按钮按 适应→按宽→按高→原始 循环", () => {
    useGalleryStore.setState({ fit: "fit" });
    renderToolbar();
    const fit = screen.getByRole("button", { name: "适配方式：适应" });
    fireEvent.click(fit);
    expect(useGalleryStore.getState().fit).toBe("width");
    expect(
      screen.getByRole("button", { name: "适配方式：按宽" }),
    ).toBeInTheDocument();
  });

  it("缩放与旋转直接作用于当前图片", () => {
    useGalleryStore.setState({ zoom: 1, rotation: 0 });
    renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(useGalleryStore.getState().zoom).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole("button", { name: "缩小" }));
    expect(useGalleryStore.getState().zoom).toBeCloseTo(1, 5);
    fireEvent.click(screen.getByRole("button", { name: /旋转 90 度/ }));
    expect(useGalleryStore.getState().rotation).toBe(90);
  });

  it("首尾位置禁用翻页按钮", () => {
    const { onNext } = renderToolbar({ atStart: true, atEnd: false });
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一页" })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(onNext).toHaveBeenCalled();
  });

  it("翻页按钮把事件交给父组件", () => {
    const { onPrev, onNext } = renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});
