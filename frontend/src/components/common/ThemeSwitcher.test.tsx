import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useUIStore } from "../../store/uiStore";
import ThemeSwitcher from "./ThemeSwitcher";

beforeEach(() => {
  useUIStore.setState({ theme: "light" });
});

async function openTheme() {
  render(
    <>
      <ThemeSwitcher compact />
      <input aria-label="外部输入" />
    </>,
  );
  const trigger = screen.getByRole("button", { name: /^主题:/ });
  trigger.focus();
  fireEvent.click(trigger);
  const menu = await screen.findByRole("menu", { name: "主题" });
  return { trigger, menu };
}

it("打开后聚焦第一项，公开主题的当前选择", async () => {
  const { trigger, menu } = await openTheme();
  expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(3);
  const themes = within(menu).getByRole("group", { name: "主题" });
  expect(
    within(themes).getByRole("menuitemradio", { checked: true }),
  ).toHaveTextContent("浅色");
  expect(
    within(themes).getByRole("menuitemradio", { name: "浅色" }),
  ).toHaveFocus();
});

it("方向键和 Home/End 遍历全部选项，移动焦点不改变外观偏好", async () => {
  const { menu } = await openTheme();
  const items = within(menu).getAllByRole("menuitemradio");
  for (const [key, index] of [
    ["ArrowDown", 1],
    ["End", 2],
    ["ArrowUp", 1],
    ["Home", 0],
    ["ArrowUp", 2],
    ["ArrowDown", 0],
  ] as const) {
    fireEvent.keyDown(document.activeElement ?? menu, { key });
    expect(items[index]).toHaveFocus();
  }
  expect(useUIStore.getState().theme).toBe("light");
});

it("选择后更新主题，保持面板打开以便连续调整", async () => {
  const { menu } = await openTheme();
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: "深色" }));
  expect(useUIStore.getState().theme).toBe("dark");
  expect(menu).toBeInTheDocument();
  expect(
    within(within(menu).getByRole("group", { name: "主题" })).getByRole(
      "menuitemradio",
      { checked: true },
    ),
  ).toHaveAccessibleName("深色");
});

it("隔离背景快捷键，Esc 关闭后恢复主题按钮焦点", async () => {
  const { trigger, menu } = await openTheme();
  const background = vi.fn();
  window.addEventListener("keydown", background);
  try {
    for (const key of ["u", "r", "?", "/", "ArrowLeft", "PageDown"])
      fireEvent.keyDown(document.activeElement ?? menu, { key });
    fireEvent.keyDown(document.activeElement ?? menu, {
      key: "s",
      ctrlKey: true,
    });
    fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
    expect(background).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  } finally {
    window.removeEventListener("keydown", background);
  }
});

it("焦点移出后关闭并保留外部控件焦点", async () => {
  await openTheme();
  const outside = screen.getByRole("textbox", { name: "外部输入" });
  act(() => outside.focus());
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(outside).toHaveFocus();
});

it("快速卸载不会遗留延迟注册的全局监听任务", () => {
  vi.useFakeTimers();
  const added = vi.spyOn(window, "addEventListener");
  const removed = vi.spyOn(window, "removeEventListener");
  try {
    const { unmount } = render(<ThemeSwitcher compact />);
    fireEvent.click(screen.getByRole("button", { name: /^主题:/ }));
    unmount();
    vi.runOnlyPendingTimers();
    for (const [index, [type, listener]] of added.mock.calls.entries()) {
      if (type !== "keydown" && type !== "mousedown") continue;
      expect(
        removed.mock.calls.some(
          ([removedType, removedListener], removedIndex) =>
            removedType === type &&
            removedListener === listener &&
            removed.mock.invocationCallOrder[removedIndex] >
              added.mock.invocationCallOrder[index],
        ),
      ).toBe(true);
    }
  } finally {
    vi.runOnlyPendingTimers();
    added.mockRestore();
    removed.mockRestore();
    vi.useRealTimers();
  }
});
