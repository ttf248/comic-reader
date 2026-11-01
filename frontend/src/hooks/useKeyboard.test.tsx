import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useKeyboard } from "./useKeyboard";

function Controls({
  onShortcut,
}: {
  onShortcut: (event: KeyboardEvent) => void;
}) {
  useKeyboard({
    space: onShortcut,
    enter: onShortcut,
    r: onShortcut,
    arrowright: onShortcut,
    "ctrl+s": onShortcut,
  });
  return (
    <>
      <button>
        <span data-testid="button-child">按钮</span>
      </button>
      <button>
        <svg>
          <path data-testid="button-icon" />
        </svg>
      </button>
      <a href="#target">链接</a>
      <details>
        <summary>摘要</summary>
      </details>
      <div role="button" tabIndex={0}>
        自定义按钮
      </div>
      <input aria-label="输入" />
      <textarea aria-label="多行输入" />
      <select aria-label="选项">
        <option>A</option>
        <option>B</option>
      </select>
      <div contentEditable suppressContentEditableWarning>
        <span data-testid="editable-child">编辑内容</span>
      </div>
      <div data-testid="handled" onKeyDown={(event) => event.preventDefault()}>
        控件已处理
      </div>
    </>
  );
}

it.each(["button-child", "button-icon", "link", "summary", "custom"])(
  "%s 的空格和回车留给控件激活",
  (kind) => {
    const onShortcut = vi.fn();
    render(<Controls onShortcut={onShortcut} />);
    const target =
      kind === "link"
        ? screen.getByRole("link")
        : kind === "summary"
          ? screen.getByText("摘要")
          : kind === "custom"
            ? screen.getByText("自定义按钮")
            : screen.getByTestId(kind);
    for (const key of [" ", "Enter"])
      expect(fireEvent.keyDown(target, { key })).toBe(true);
    expect(onShortcut).not.toHaveBeenCalled();
  },
);

it.each(["input", "textarea", "select", "editable-child"])(
  "%s 内的按键不触发页面快捷键",
  (kind) => {
    const onShortcut = vi.fn();
    render(<Controls onShortcut={onShortcut} />);
    const target =
      kind === "input"
        ? screen.getByLabelText("输入")
        : kind === "textarea"
          ? screen.getByLabelText("多行输入")
          : kind === "select"
            ? screen.getByRole("combobox")
            : screen.getByTestId(kind);
    for (const key of ["r", "ArrowRight"]) fireEvent.keyDown(target, { key });
    expect(onShortcut).not.toHaveBeenCalled();
  },
);

it("不重复处理已取消的事件和输入法组合事件", () => {
  const onShortcut = vi.fn();
  render(<Controls onShortcut={onShortcut} />);
  fireEvent.keyDown(screen.getByTestId("handled"), { key: "r" });
  fireEvent.keyDown(window, { key: "r", isComposing: true });
  const consumed = new KeyboardEvent("keydown", { key: "r", cancelable: true });
  consumed.preventDefault();
  fireEvent(window, consumed);
  expect(onShortcut).not.toHaveBeenCalled();
});

it("页面普通按键和显式注册的修饰组合仍可用", () => {
  const onShortcut = vi.fn();
  render(<Controls onShortcut={onShortcut} />);
  expect(fireEvent.keyDown(window, { key: " " })).toBe(false);
  expect(fireEvent.keyDown(window, { key: "s", ctrlKey: true })).toBe(false);
  expect(onShortcut).toHaveBeenCalledTimes(2);
});

it("同一事件被首个处理器接管后，不再触发第二份处理器", () => {
  const first = vi.fn();
  const second = vi.fn();
  renderHook(() => {
    useKeyboard({ r: first });
    useKeyboard({ r: second });
  });
  fireEvent.keyDown(window, { key: "r" });
  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
});
