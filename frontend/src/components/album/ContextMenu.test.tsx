import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import ContextMenu from "./ContextMenu";

describe("ContextMenu", () => {
  it("打开后聚焦第一个可用菜单项，并暴露菜单语义", () => {
    render(
      <ContextMenu
        x={20}
        y={20}
        items={[
          { id: "disabled", label: "不可用", disabled: true },
          { id: "open", label: "打开" },
        ]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("menu", { name: "上下文菜单" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "打开" })).toHaveFocus();
  });

  it("关闭后恢复来源焦点", () => {
    const view = (open: boolean) => (
      <>
        <button type="button">来源</button>
        {open && (
          <ContextMenu
            x={20}
            y={20}
            items={[{ id: "properties", label: "属性" }]}
            onSelect={vi.fn()}
            onClose={vi.fn()}
          />
        )}
      </>
    );
    const { rerender } = render(view(false));
    const source = screen.getByRole("button", { name: "来源" });
    source.focus();
    rerender(view(true));
    expect(screen.getByRole("menuitem", { name: "属性" })).toHaveFocus();
    rerender(view(false));
    expect(source).toHaveFocus();
  });

  it("StrictMode 的假卸载不会抢回焦点，菜单因此不会被自己的 onBlur 关掉", async () => {
    const onClose = vi.fn();
    const view = (open: boolean) => (
      <>
        <button type="button">来源</button>
        {open && (
          <ContextMenu
            x={20}
            y={20}
            items={[{ id: "properties", label: "属性" }]}
            onSelect={vi.fn()}
            onClose={onClose}
          />
        )}
      </>
    );

    // 复现真实场景：右键卡片（卡片链接已获得焦点）后菜单挂载，
    // React 18 StrictMode 会对菜单做一次"挂载 → 卸载 → 再挂载"。
    const { rerender } = render(<StrictMode>{view(false)}</StrictMode>);
    screen.getByRole("button", { name: "来源" }).focus();
    rerender(<StrictMode>{view(true)}</StrictMode>);

    // 等 StrictMode 的"挂载 → 卸载 → 再挂载"以及推迟的焦点归还跑完。
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "属性" })).toHaveFocus();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("关闭时不抢走已经移到外部的焦点", () => {
    const view = (open: boolean) => (
      <>
        <button type="button">来源</button>
        <input aria-label="外部输入" />
        {open && (
          <ContextMenu
            x={20}
            y={20}
            items={[{ id: "properties", label: "属性" }]}
            onSelect={vi.fn()}
            onClose={vi.fn()}
          />
        )}
      </>
    );
    const { rerender } = render(view(false));
    screen.getByRole("button", { name: "来源" }).focus();
    rerender(view(true));
    const outside = screen.getByRole("textbox", { name: "外部输入" });
    outside.focus();
    rerender(view(false));
    expect(outside).toHaveFocus();
  });
});
