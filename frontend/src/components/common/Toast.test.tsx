import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import ToastViewport from "./Toast";
import { useUIStore } from "../../store/uiStore";

// 恒定深色的沉浸场景（漫画阅读器、照片墙的大图预览）里，沿用应用主题
// 的浅色 toast 会变成"黑底里浮一块白板"，与场景里的其它浮层自相矛盾。
describe("ToastViewport", () => {
  beforeEach(() => {
    useUIStore.setState({ toasts: [] });
  });

  function renderAt(path: string) {
    render(
      <MemoryRouter initialEntries={[path]}>
        <ToastViewport />
      </MemoryRouter>,
    );
    return screen.getByText("测试消息").parentElement as HTMLElement;
  }

  it("普通页面下 toast 跟应用主题（浅色底）", () => {
    useUIStore.setState({
      toasts: [
        { id: "t1", kind: "info", message: "测试消息", ttl: 0 },
      ],
    });
    const card = renderAt("/");
    expect(card.className).toContain("bg-bg-elevated/95");
    expect(card.className).not.toContain("bg-overlay-panel");
  });

  it("漫画阅读器路由下 toast 走深色底", () => {
    useUIStore.setState({
      toasts: [
        { id: "t1", kind: "info", message: "测试消息", ttl: 0 },
      ],
    });
    const card = renderAt("/comic/read/abc");
    expect(card.className).toContain("bg-overlay-panel");
    expect(card.className).not.toContain("bg-bg-elevated/95");
  });

  // 照片墙的大图预览也是深色浮层，路径却不是阅读器 —— 早先按路径前缀
  // 判断时，在预览里弹出的 toast 是一块浅色板。
  it("照片墙的大图预览打开时 toast 也走深色底", () => {
    useUIStore.setState({
      toasts: [
        { id: "t1", kind: "info", message: "测试消息", ttl: 0 },
      ],
      immersiveOverlay: true,
    });
    const card = renderAt("/photo/albums/a_1");
    expect(card.className).toContain("bg-overlay-panel");
    expect(card.className).not.toContain("bg-bg-elevated/95");
    useUIStore.setState({ immersiveOverlay: false });
  });
});
