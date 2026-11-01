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
      <HelpOverlay context="image" open={open} onClose={() => setOpen(false)} />
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
  const view = render(<HelpOverlay context="image" open onClose={vi.fn()} />);
  const search = screen.getByPlaceholderText("搜索快捷键…");
  fireEvent.change(search, { target: { value: "放大" } });
  const close = screen.getByRole("button", { name: "关闭" });
  close.focus();
  view.rerender(<HelpOverlay context="image" open onClose={vi.fn()} />);
  expect(close).toHaveFocus();
  expect(search).toHaveValue("放大");
});

it.each(["library", "image", "video"] as const)(
  "%s 场景只展示对应页面的快捷键",
  (context) => {
    render(<HelpOverlay context={context} open onClose={vi.fn()} />);
    if (context === "library") {
      expect(screen.getByText("回到主页")).toBeInTheDocument();
      expect(screen.queryByText(/旋转 90°/)).not.toBeInTheDocument();
      expect(screen.queryByText("下一张")).not.toBeInTheDocument();
    } else {
      expect(screen.queryByText("回到主页")).not.toBeInTheDocument();
      expect(screen.getByText("当前内容设为封面")).toBeInTheDocument();
      expect(screen.getByText("清除自定义封面")).toBeInTheDocument();
      if (context === "image") {
        expect(screen.getByText("下一张")).toBeInTheDocument();
        expect(screen.getByText(/旋转 90°/)).toBeInTheDocument();
        expect(screen.queryByText("播放 / 暂停")).not.toBeInTheDocument();
      } else {
        expect(screen.getByText("播放 / 暂停")).toBeInTheDocument();
        expect(screen.getByText("快进 5 秒")).toBeInTheDocument();
        expect(screen.getByText("下一个视频")).toBeInTheDocument();
        expect(screen.getByText("静音 / 取消静音")).toBeInTheDocument();
        expect(screen.queryByText("下一张")).not.toBeInTheDocument();
        expect(screen.queryByText(/幻灯片/)).not.toBeInTheDocument();
      }
    }
  },
);

it("视频帮助搜索不显示图片操作，并可按视频别名查找播放操作", () => {
  render(<HelpOverlay context="video" open onClose={vi.fn()} />);
  const search = screen.getByRole("textbox", { name: "搜索快捷键" });
  fireEvent.change(search, { target: { value: "旋转" } });
  expect(screen.getByText("没有匹配「旋转」的快捷键")).toBeInTheDocument();
  fireEvent.change(search, { target: { value: "Space" } });
  expect(screen.getByText("播放 / 暂停")).toBeInTheDocument();
  expect(screen.getByText("Space / K")).toBeInTheDocument();
});

it("切换媒体场景时保留搜索词，展示该按键在新场景的含义", () => {
  const view = render(<HelpOverlay context="image" open onClose={vi.fn()} />);
  const search = screen.getByRole("textbox", { name: "搜索快捷键" });
  fireEvent.change(search, { target: { value: "Space" } });
  expect(screen.getByText("幻灯片播放/暂停")).toBeInTheDocument();
  view.rerender(<HelpOverlay context="video" open onClose={vi.fn()} />);
  expect(search).toHaveValue("Space");
  expect(search).toHaveFocus();
  expect(screen.getByText("播放 / 暂停")).toBeInTheDocument();
  expect(screen.queryByText(/幻灯片/)).not.toBeInTheDocument();
});
