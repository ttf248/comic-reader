import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Popover, { PopoverItem, PopoverLabel, PopoverSeparator } from "./Popover";

describe("Popover", () => {
  it("打开后聚焦第一项，点击菜单项后关闭并恢复 trigger 焦点", async () => {
    const onAction = vi.fn();
    render(
      <Popover trigger={<button type="button">打开菜单</button>}>
        <PopoverItem onClick={onAction}>执行操作</PopoverItem>
      </Popover>,
    );

    const trigger = screen.getByRole("button", { name: "打开菜单" });
    fireEvent.click(trigger);

    const item = await screen.findByRole("menuitem", { name: "执行操作" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(item).toHaveFocus();

    fireEvent.click(item);

    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  // 阅读器画布恒为深色：菜单必须跟着暗，否则就是"黑底里嵌一块白板"。
  it("tone=reader 时菜单走深色底，不跟应用主题", async () => {
    render(
      <Popover
        tone="reader"
        trigger={<button type="button">更多</button>}
      >
        <PopoverLabel>内容</PopoverLabel>
        <PopoverItem onClick={vi.fn()}>图片信息</PopoverItem>
        <PopoverSeparator />
        <PopoverItem onClick={vi.fn()}>设为封面</PopoverItem>
      </Popover>,
    );

    fireEvent.click(screen.getByRole("button", { name: "更多" }));

    const menu = await screen.findByRole("menu");
    expect(menu.className).toContain("bg-neutral-900/95");
    expect(menu.className).not.toContain("bg-bg-elevated");

    const item = screen.getByRole("menuitem", { name: "图片信息" });
    expect(item.className).toContain("text-white/80");
  });

  it("默认（theme 档）仍跟应用主题走", async () => {
    render(
      <Popover trigger={<button type="button">更多</button>}>
        <PopoverItem onClick={vi.fn()}>图片信息</PopoverItem>
      </Popover>,
    );

    fireEvent.click(screen.getByRole("button", { name: "更多" }));

    const menu = await screen.findByRole("menu");
    expect(menu.className).toContain("bg-bg-elevated");
    expect(menu.className).not.toContain("bg-neutral-900/95");
  });
});
