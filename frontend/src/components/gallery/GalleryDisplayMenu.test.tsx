import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import GalleryDisplayMenu from "./GalleryDisplayMenu";
import { useGalleryStore } from "../../store/galleryStore";

describe("GalleryDisplayMenu 窄屏阅读设置", () => {
  it("入口按钮有中文可访问名", () => {
    render(<GalleryDisplayMenu />);
    expect(
      screen.getByRole("button", { name: "阅读设置" }),
    ).toBeInTheDocument();
  });

  it("展开后可以切换阅读模式与适配方式", () => {
    useGalleryStore.setState({ mode: "single", fit: "fit", zoom: 1 });
    render(<GalleryDisplayMenu />);

    fireEvent.click(screen.getByRole("button", { name: "阅读设置" }));
    expect(screen.getByRole("menu", { name: "阅读设置" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: /连续/ }));
    expect(useGalleryStore.getState().mode).toBe("continuous");

    fireEvent.click(screen.getByRole("button", { name: "阅读设置" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /按高/ }));
    expect(useGalleryStore.getState().fit).toBe("height");
  });

  it("缩放与旋转直接作用于当前图片", () => {
    useGalleryStore.setState({ zoom: 1, rotation: 0 });
    render(<GalleryDisplayMenu />);

    fireEvent.click(screen.getByRole("button", { name: "阅读设置" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /放大/ }));
    expect(useGalleryStore.getState().zoom).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole("button", { name: "阅读设置" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /旋转 90°/ }));
    expect(useGalleryStore.getState().rotation).toBe(90);
  });

  it("并排模式下才提供阅读方向", () => {
    useGalleryStore.setState({ mode: "single", direction: "ltr" });
    const single = render(<GalleryDisplayMenu />);
    fireEvent.click(screen.getByRole("button", { name: "阅读设置" }));
    expect(screen.queryByRole("menuitem", { name: /阅读方向/ })).toBeNull();
    single.unmount();

    useGalleryStore.setState({ mode: "double" });
    render(<GalleryDisplayMenu />);
    fireEvent.click(screen.getByRole("button", { name: "阅读设置" }));
    expect(
      screen.getByRole("menuitem", { name: /阅读方向/ }),
    ).toBeInTheDocument();
  });
});
