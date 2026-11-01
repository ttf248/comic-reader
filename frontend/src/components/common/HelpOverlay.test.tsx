import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";
import HelpOverlay from "./HelpOverlay";

// jsdom 不提供原生 dialog 行为；焦点循环和背景点击由浏览器用例验证。
beforeAll(() => {
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.open = true;
    },
    close(this: HTMLDialogElement) {
      this.open = false;
    },
  });
});

function HelpHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>打开帮助</button>
      <HelpOverlay open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function openHelp() {
  render(<HelpHarness />);
  const opener = screen.getByRole("button", { name: "打开帮助" });
  opener.focus();
  fireEvent.click(opener);
  return { opener, dialog: screen.getByRole("dialog") };
}

it("通过具名原生模态 dialog 打开帮助并聚焦搜索", () => {
  const { dialog } = openHelp();
  expect(dialog).toBeInstanceOf(HTMLDialogElement);
  expect(dialog).toHaveAttribute("open");
  expect(dialog).toHaveAccessibleName("快捷键");
  expect(screen.getByRole("textbox", { name: "搜索快捷键" })).toHaveFocus();
});

it("过滤和清除搜索，清除按钮消失时焦点回到搜索框", () => {
  openHelp();
  const search = screen.getByPlaceholderText("搜索快捷键…");
  fireEvent.change(search, { target: { value: "不存在的快捷键" } });
  expect(
    screen.getByText("没有匹配「不存在的快捷键」的快捷键"),
  ).toBeInTheDocument();
  const clear = screen.getByRole("button", { name: "清除" });
  clear.focus();
  fireEvent.click(clear);
  expect(search).toHaveValue("");
  expect(search).toHaveFocus();
  expect(screen.getByText("下一张")).toBeInTheDocument();
});

it("浮层按键不冒泡到背景阅读器和全局快捷键", () => {
  openHelp();
  const background = vi.fn();
  window.addEventListener("keydown", background);
  try {
    const close = screen.getByRole("button", { name: "关闭" });
    for (const key of ["ArrowRight", " ", "k", "u", "Escape"]) {
      fireEvent.keyDown(close, { key });
    }
    expect(background).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("keydown", background);
  }
});

it("原生 Esc 取消关闭受控浮层并恢复来源焦点", () => {
  const { opener, dialog } = openHelp();
  const cancel = new Event("cancel", { cancelable: true });
  fireEvent(dialog, cancel);
  expect(cancel.defaultPrevented).toBe(true);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});

it.each(["button", "backdrop"])(
  "通过 %s 关闭，内部内容点击保留浮层",
  (target) => {
    const { opener, dialog } = openHelp();
    fireEvent.click(screen.getByRole("heading", { name: "快捷键" }));
    expect(dialog).toBeInTheDocument();
    fireEvent.click(
      target === "button"
        ? screen.getByRole("button", { name: "关闭" })
        : dialog,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  },
);

it("关闭后重新打开清空过滤条件", () => {
  openHelp();
  const search = screen.getByPlaceholderText("搜索快捷键…");
  fireEvent.change(search, { target: { value: "放大" } });
  expect(search).toHaveValue("放大");
  expect(search).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  fireEvent.click(screen.getByRole("button", { name: "打开帮助" }));
  expect(screen.getByPlaceholderText("搜索快捷键…")).toHaveValue("");
});

it("父组件重绘并更换回调时，保留当前焦点和搜索状态", () => {
  const view = render(<HelpOverlay open onClose={vi.fn()} />);
  const search = screen.getByPlaceholderText("搜索快捷键…");
  fireEvent.change(search, { target: { value: "放大" } });
  const close = screen.getByRole("button", { name: "关闭" });
  close.focus();
  view.rerender(<HelpOverlay open onClose={vi.fn()} />);
  expect(close).toHaveFocus();
  expect(search).toHaveValue("放大");
});
