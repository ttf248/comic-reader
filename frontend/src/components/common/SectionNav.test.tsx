import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import SectionNav from "./SectionNav";
import { TASK_SECTIONS } from "../../utils/pageSections";

describe("页面分区条", () => {
  it("列出全部分区并标出当前分区", () => {
    render(
      <SectionNav
        sections={TASK_SECTIONS}
        active="history"
        onSelect={() => {}}
      />,
    );

    const nav = screen.getByRole("navigation", { name: "页面分区" });
    expect(nav).toBeInTheDocument();
    for (const section of TASK_SECTIONS) {
      const button = screen.getByRole("button", { name: new RegExp(section.label) });
      expect(button).toBeInTheDocument();
      if (section.id === "history") {
        expect(button).toHaveAttribute("aria-current", "true");
      } else {
        expect(button).not.toHaveAttribute("aria-current");
      }
    }
  });

  it("点分区条即回调该分区", () => {
    const onSelect = vi.fn();
    render(
      <SectionNav sections={TASK_SECTIONS} active="run" onSelect={onSelect} />,
    );

    screen.getByRole("button", { name: /本机存储/ }).click();
    expect(onSelect).toHaveBeenCalledWith("storage");
  });

  it("没有分区时不渲染", () => {
    const { container } = render(
      <SectionNav sections={[]} active="" onSelect={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
