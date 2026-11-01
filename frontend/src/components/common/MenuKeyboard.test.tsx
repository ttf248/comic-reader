import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import ContextMenu from "../album/ContextMenu";
import Popover, { PopoverItem } from "./Popover";

type MenuKind = "popover" | "context";

function MenuHarness({
  kind,
  disabled = false,
  action,
}: {
  kind: MenuKind;
  disabled?: boolean;
  action: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const items = [
    { id: "first", label: "第一项", disabled },
    { id: "disabled", label: "不可用", disabled: true },
    { id: "second", label: "第二项", disabled },
    { id: "third", label: "第三项", disabled },
  ];
  return (
    <>
      {kind === "popover" ? (
        <Popover trigger={<button>来源</button>}>
          {items.map((item) => (
            <PopoverItem
              key={item.id}
              disabled={item.disabled}
              onClick={() => action(item.id)}
            >
              {item.label}
            </PopoverItem>
          ))}
        </Popover>
      ) : (
        <>
          <button onClick={() => setOpen(true)}>来源</button>
          {open && (
            <ContextMenu
              x={20}
              y={20}
              items={items}
              onClose={() => setOpen(false)}
              onSelect={(id) => {
                action(id);
                setOpen(false);
              }}
            />
          )}
        </>
      )}
      <input aria-label="外部输入" />
    </>
  );
}

async function openMenu(kind: MenuKind, disabled = false) {
  const action = vi.fn();
  render(<MenuHarness kind={kind} disabled={disabled} action={action} />);
  const source = screen.getByRole("button", { name: "来源" });
  source.focus();
  fireEvent.click(source);
  const menu = await screen.findByRole("menu");
  return { source, menu, action };
}

it.each(["popover", "context"] as const)(
  "%s 方向键循环跳过禁用项，Home/End 定位首尾",
  async (kind) => {
    await openMenu(kind);
    const first = screen.getByRole("menuitem", { name: "第一项" });
    const second = screen.getByRole("menuitem", { name: "第二项" });
    const third = screen.getByRole("menuitem", { name: "第三项" });
    expect(first).toHaveFocus();
    for (const [key, target] of [
      ["ArrowDown", second],
      ["ArrowUp", first],
      ["ArrowUp", third],
      ["Home", first],
      ["End", third],
      ["ArrowDown", first],
    ] as const) {
      expect(fireEvent.keyDown(document.activeElement ?? first, { key })).toBe(
        false,
      );
      expect(target).toHaveFocus();
    }
  },
);

it.each(["popover", "context"] as const)(
  "%s Esc 只关闭当前菜单并恢复来源焦点",
  async (kind) => {
    const { source } = await openMenu(kind);
    const background = vi.fn();
    window.addEventListener("keydown", background);
    try {
      fireEvent.keyDown(screen.getByRole("menuitem", { name: "第一项" }), {
        key: "Escape",
      });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(source).toHaveFocus();
      expect(background).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", background);
    }
  },
);

it.each(["popover", "context"] as const)(
  "%s 内按键不触发背景，保留 Space/Enter 默认激活",
  async (kind) => {
    const { action } = await openMenu(kind);
    const first = screen.getByRole("menuitem", { name: "第一项" });
    const background = vi.fn();
    window.addEventListener("keydown", background);
    try {
      for (const key of ["r", "ArrowLeft", "ArrowRight", "PageDown"])
        fireEvent.keyDown(first, { key });
      for (const key of [" ", "Enter"])
        expect(fireEvent.keyDown(first, { key })).toBe(true);
      expect(background).not.toHaveBeenCalled();
      fireEvent.click(first);
      expect(action).toHaveBeenCalledOnce();
      expect(action).toHaveBeenCalledWith("first");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    } finally {
      window.removeEventListener("keydown", background);
    }
  },
);

it.each(["popover", "context"] as const)(
  "%s 焦点移出后关闭且不抢回外部焦点",
  async (kind) => {
    await openMenu(kind);
    const outside = screen.getByRole("textbox", { name: "外部输入" });
    act(() => outside.focus());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
  },
);

it.each(["popover", "context"] as const)(
  "%s 全部禁用时聚焦菜单本身，仍可用 Esc 关闭",
  async (kind) => {
    const { source, menu } = await openMenu(kind, true);
    expect(menu).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(source).toHaveFocus();
  },
);

it.each(["popover", "context"] as const)(
  "%s 不用组合键、输入法或已处理事件移动焦点",
  async (kind) => {
    await openMenu(kind);
    const first = screen.getByRole("menuitem", { name: "第一项" });
    for (const init of [
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
      { isComposing: true },
    ]) {
      expect(fireEvent.keyDown(first, { key: "ArrowDown", ...init })).toBe(
        true,
      );
      expect(first).toHaveFocus();
    }
    const handled = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    fireEvent(first, handled);
    expect(first).toHaveFocus();
  },
);
