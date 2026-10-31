import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CopyButton from "./CopyButton";

const { pushToast } = vi.hoisted(() => ({ pushToast: vi.fn() }));
vi.mock("../../store/uiStore", () => ({
  useUIStore: (selector: (state: { pushToast: typeof pushToast }) => unknown) =>
    selector({ pushToast }),
}));

const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
const originalExecCommand = Object.getOwnPropertyDescriptor(
  document,
  "execCommand",
);
const writeText = vi.fn<(value: string) => Promise<void>>();
const execCommand = vi.fn<(command: string) => boolean>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  writeText.mockResolvedValue();
  execCommand.mockReturnValue(true);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: execCommand,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (originalClipboard)
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  if (originalExecCommand)
    Object.defineProperty(document, "execCommand", originalExecCommand);
  else Reflect.deleteProperty(document, "execCommand");
  document.querySelectorAll("textarea").forEach((element) => element.remove());
});

async function click(button: HTMLElement) {
  await act(async () => {
    fireEvent.click(button);
  });
}

it("优先使用剪贴板 API 并显示成功反馈", async () => {
  render(<CopyButton value="相册名称" title="复制名称" />);
  await click(screen.getByRole("button", { name: "复制名称" }));
  expect(writeText).toHaveBeenCalledWith("相册名称");
  expect(execCommand).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();
});

it("API 拒绝时在所属弹窗内选择文本并恢复按钮焦点", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  const view = render(
    <dialog open aria-label="属性">
      <CopyButton value="相册名称" title="复制名称" />
    </dialog>,
  );
  const dialog = screen.getByRole("dialog");
  const button = screen.getByRole("button", { name: "复制名称" });
  let parent: Element | null = null;
  let focused = false;
  let text = "";
  execCommand.mockImplementation(() => {
    const textarea = view.baseElement.querySelector("textarea")!;
    parent = textarea.parentElement;
    focused = document.activeElement === textarea;
    text = textarea.value;
    return true;
  });
  button.focus();
  await click(button);
  expect(parent).toBe(dialog);
  expect(focused).toBe(true);
  expect(text).toBe("相册名称");
  expect(button).toHaveFocus();
  expect(document.querySelector("textarea")).toBeNull();
});

it("回退抛错后清理临时元素并允许重试", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  execCommand.mockImplementationOnce(() => {
    throw new Error("failed");
  });
  render(<CopyButton value="相册名称" title="复制名称" />);
  const button = screen.getByRole("button", { name: "复制名称" });
  button.focus();
  await click(button);
  expect(document.querySelector("textarea")).toBeNull();
  expect(button).toHaveFocus();
  expect(button).toHaveAccessibleName("复制失败，重试");
  expect(pushToast).toHaveBeenCalledWith({
    kind: "error",
    message: "复制失败，请检查浏览器权限",
  });
  await click(button);
  expect(button).toHaveAccessibleName("已复制");
});

it("回退返回失败时不显示已复制", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  execCommand.mockReturnValue(false);
  render(<CopyButton value="内容" />);
  await click(screen.getByRole("button"));
  expect(screen.getByRole("button")).toHaveAccessibleName("复制失败，重试");
  expect(document.querySelector("textarea")).toBeNull();
});

it("成功反馈从最后一次复制重新计时", async () => {
  render(<CopyButton value="内容" />);
  const button = screen.getByRole("button");
  await click(button);
  act(() => vi.advanceTimersByTime(500));
  await click(button);
  act(() => vi.advanceTimersByTime(1000));
  expect(button).toHaveAccessibleName("已复制");
  act(() => vi.advanceTimersByTime(500));
  expect(button).toHaveAccessibleName("复制");
});

it("切换内容会清除旧成功反馈和计时器", async () => {
  const view = render(<CopyButton value="第一项" />);
  await click(screen.getByRole("button"));
  view.rerender(<CopyButton value="第二项" />);
  expect(screen.getByRole("button")).toHaveAccessibleName("复制");
  expect(vi.getTimerCount()).toBe(0);
});

it("卸载后取消成功反馈计时器", async () => {
  const view = render(<CopyButton value="内容" />);
  await click(screen.getByRole("button"));
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("等待复制期间合并重复点击并保持按钮可聚焦", async () => {
  let finish!: () => void;
  writeText.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  render(<CopyButton value="内容" />);
  const button = screen.getByRole("button");
  fireEvent.click(button);
  fireEvent.click(button);
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button).not.toBeDisabled();
  await act(async () => finish());
  expect(button).toHaveAccessibleName("已复制");
});

it("卸载后的异步失败不再回退或弹出提示", async () => {
  let fail!: (error: Error) => void;
  writeText.mockReturnValue(
    new Promise<void>((_, reject) => {
      fail = reject;
    }),
  );
  const view = render(<CopyButton value="内容" />);
  fireEvent.click(screen.getByRole("button"));
  view.unmount();
  await act(async () => fail(new Error("late failure")));
  expect(execCommand).not.toHaveBeenCalled();
  expect(pushToast).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("内容切换后的旧请求不覆盖新反馈", async () => {
  let fail!: (error: Error) => void;
  writeText.mockReturnValueOnce(
    new Promise<void>((_, reject) => {
      fail = reject;
    }),
  );
  const view = render(<CopyButton value="第一项" />);
  fireEvent.click(screen.getByRole("button"));
  view.rerender(<CopyButton value="第二项" />);
  await act(async () => fail(new Error("late failure")));
  expect(execCommand).not.toHaveBeenCalled();
  expect(pushToast).not.toHaveBeenCalled();
  expect(screen.getByRole("button")).toHaveAccessibleName("复制");
  await click(screen.getByRole("button"));
  expect(writeText).toHaveBeenLastCalledWith("第二项");
});
