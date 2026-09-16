import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Popover, { PopoverItem } from "./Popover";

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
});
