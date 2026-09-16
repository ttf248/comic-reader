import { render, screen } from "@testing-library/react";
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
});
