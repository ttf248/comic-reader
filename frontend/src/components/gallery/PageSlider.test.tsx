import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import PageSlider from "./PageSlider";

it.each([
  { key: "g", ctrlKey: true },
  { key: "g", altKey: true },
  { key: "g", metaKey: true },
  { key: "g", isComposing: true },
])("页码跳转不拦截系统组合或输入法事件 %j", (init) => {
  render(<PageSlider total={3} index={0} onJump={vi.fn()} />);
  fireEvent.keyDown(window, init);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

it("已处理的 G 不打开编辑框，普通 G 仍可定位页码", () => {
  const jump = vi.fn();
  render(<PageSlider total={3} index={0} onJump={jump} />);
  const handled = new KeyboardEvent("keydown", { key: "g", cancelable: true });
  handled.preventDefault();
  fireEvent(window, handled);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  fireEvent.keyDown(window, { key: "g" });
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "2" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(jump).toHaveBeenCalledWith(1);
});
