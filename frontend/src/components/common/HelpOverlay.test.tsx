import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";
import HelpOverlay from "./HelpOverlay";
import { useAppModeStore } from "../../store/appModeStore";

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
    useAppModeStore.setState({ preference: "photo", hydrated: true });
    render(<HelpOverlay context={context} open onClose={vi.fn()} />);
    if (context === "library") {
      expect(screen.getByText("回到照片库")).toBeInTheDocument();
      expect(screen.queryByText(/旋转 90°/)).not.toBeInTheDocument();
      expect(screen.queryByText("下一张")).not.toBeInTheDocument();
    } else {
      expect(screen.queryByText("回到照片库")).not.toBeInTheDocument();
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

// 照片墙是主页面的一种形态：全局操作照旧，再多一组大图预览的操作。
it("photo 场景展示全局操作与大图预览操作", () => {
  useAppModeStore.setState({ preference: "photo", hydrated: true });
  render(<HelpOverlay context="photo" open onClose={vi.fn()} />);
  expect(screen.getByText("回到照片库")).toBeInTheDocument();
  expect(screen.getByText("照片墙")).toBeInTheDocument();
  expect(screen.getByText("恢复适应屏幕")).toBeInTheDocument();
  expect(screen.getByText("关闭预览，回到照片墙")).toBeInTheDocument();
  // 阅读器的专属操作不该出现在照片墙。
  expect(screen.queryByText("当前内容设为封面")).not.toBeInTheDocument();
  expect(screen.queryByText(/旋转 90°/)).not.toBeInTheDocument();
});

// 少数全局操作的措辞随工作台模式变化。
it("全局操作的措辞随工作台模式变化", () => {
  useAppModeStore.setState({ preference: "photo", hydrated: true });
  render(<HelpOverlay context="library" open onClose={vi.fn()} />);
  expect(screen.getByText("随机翻翻")).toBeInTheDocument();
  expect(screen.getByText("回到照片库")).toBeInTheDocument();
  expect(screen.getByText("最近浏览")).toBeInTheDocument();
  expect(screen.getByText("收藏照片")).toBeInTheDocument();

  act(() => {
    useAppModeStore.setState({ preference: "comic", hydrated: true });
  });
  expect(screen.getByText("随机一本")).toBeInTheDocument();
  expect(screen.getByText("回到漫画库")).toBeInTheDocument();
  expect(screen.getByText("最近阅读")).toBeInTheDocument();
  expect(screen.getByText("收藏漫画")).toBeInTheDocument();
  act(() => {
    useAppModeStore.setState({ preference: "photo", hydrated: true });
  });
});

// 未读页只属于漫画工作台：照片模式下按 U 什么也不会发生，
// 帮助浮层也不该列出这个快捷键。
it("未读快捷键只在漫画工作台出现", () => {
  useAppModeStore.setState({ preference: "photo", hydrated: true });
  render(<HelpOverlay context="library" open onClose={vi.fn()} />);
  expect(screen.queryByText("未读相册页")).not.toBeInTheDocument();

  act(() => {
    useAppModeStore.setState({ preference: "comic", hydrated: true });
  });
  expect(screen.getByText("未读相册页")).toBeInTheDocument();
  act(() => {
    useAppModeStore.setState({ preference: "photo", hydrated: true });
  });
});

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

// 阅读器是恒定深色的沉浸场景：帮助浮层必须跟着暗，
// 否则就是"黑底阅读器里嵌一块白板"（与信息面板的约定一致）。
it("tone=reader 时帮助浮层走深色，并标记 data-tone 供焦点环取色", () => {
  render(<HelpOverlay context="image" open onClose={vi.fn()} tone="reader" />);
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveAttribute("data-tone", "reader");
  expect(dialog.className).toContain("bg-overlay-panel");
  expect(dialog.className).not.toContain("bg-bg-elevated");
  // 键帽走暗色变体（.kbd-light），否则白底键帽浮在深色浮层上很扎眼。
  expect(document.querySelector(".kbd-light")).not.toBeNull();
});

it("默认（theme 档）帮助浮层仍跟应用主题走", () => {
  render(<HelpOverlay context="image" open onClose={vi.fn()} />);
  const dialog = screen.getByRole("dialog");
  expect(dialog).not.toHaveAttribute("data-tone");
  expect(dialog.className).toContain("bg-bg-elevated");
});
