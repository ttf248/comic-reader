import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import PageSlider from "./PageSlider";

it.each([
  { key: "g", ctrlKey: true },
  { key: "g", altKey: true },
  { key: "g", metaKey: true },
  { key: "g", isComposing: true },
])("张数跳转不拦截系统组合或输入法事件 %j", (init) => {
  render(<PageSlider total={3} index={0} onJump={vi.fn()} />);
  fireEvent.keyDown(window, init);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

it("已处理的 G 不打开编辑框，普通 G 仍可定位张数", () => {
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

it("进入跳转编辑态后预填当前张数并全选，输入直接覆盖而不是追加", async () => {
  const jump = vi.fn();
  render(<PageSlider total={403} index={0} onJump={jump} />);
  fireEvent.keyDown(window, { key: "g" });
  const input = screen.getByRole("textbox") as HTMLInputElement;
  expect(input.value).toBe("1");
  // 预填值必须处于选中态：否则用户输入的张数会接在预填值后面
  // （"1" + "100" = "1100"，被夹到最后一页）。
  await waitFor(() => {
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(1);
  });
  fireEvent.change(input, { target: { value: "100" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(jump).toHaveBeenCalledWith(99);
});

it("跳转输入框有可访问名称", () => {
  render(<PageSlider total={3} index={0} onJump={vi.fn()} />);
  fireEvent.keyDown(window, { key: "g" });
  expect(
    screen.getByRole("textbox", { name: "跳转到第几页" }),
  ).toBeInTheDocument();
});
