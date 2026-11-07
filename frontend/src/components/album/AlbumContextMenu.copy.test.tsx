import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AlbumContextMenu from "./AlbumContextMenu";
import type { CardData } from "./AlbumCard";
import ToastViewport from "../common/Toast";
import { useUIStore } from "../../store/uiStore";

vi.mock("../../hooks/useFavorites", () => ({
  useFavorites: () => ({ favorites: [], toggle: vi.fn() }),
}));
vi.mock("../../api/fs", () => ({
  fsApi: { capabilities: vi.fn().mockResolvedValue({ allowOsOpen: false }) },
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
const album: CardData = {
  id: "a_sample",
  variant: "album",
  title: "相册",
  count: 1,
  coverPath: "f_cover",
  to: "/albums/a_sample",
};

function Menu({ item }: { item: CardData }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>来源卡片</button>
      {open && (
        <AlbumContextMenu
          item={item}
          x={100}
          y={100}
          onClose={() => setOpen(false)}
          onShowProperties={() => {}}
        />
      )}
      <ToastViewport />
    </>
  );
}

function openMenu(item = album) {
  const client = new QueryClient({
    defaultOptions: { mutations: { gcTime: Infinity } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Menu item={item} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const source = screen.getByRole("button", { name: "来源卡片" });
  source.focus();
  fireEvent.click(source);
  return source;
}

beforeEach(() => {
  writeText.mockReset().mockResolvedValue();
  execCommand.mockReset().mockReturnValue(true);
  useUIStore.setState({ toasts: [] });
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
  if (originalClipboard)
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  if (originalExecCommand)
    Object.defineProperty(document, "execCommand", originalExecCommand);
  else Reflect.deleteProperty(document, "execCommand");
  document.querySelectorAll("textarea").forEach((element) => element.remove());
});

it.each([
  album,
  { ...album, id: "c_sample", variant: "collection", to: "/albums/c_sample" },
  {
    ...album,
    id: "smart:字面%2F",
    variant: "smart",
    title: "字面%2F",
    to: "/tags/%E5%AD%97%E9%9D%A2%252F",
  },
] satisfies CardData[])(
  "$variant 复制可打开的完整链接并反馈成功",
  async (item) => {
    const source = openMenu(item);
    fireEvent.click(screen.getByRole("menuitem", { name: "复制链接" }));
    await screen.findByText("已复制链接", { exact: true });
    expect(writeText).toHaveBeenCalledWith(window.location.origin + item.to);
    expect(execCommand).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(source).toHaveFocus();
  },
);

it("菜单卸载后 API 拒绝仍能回退并恢复来源焦点", async () => {
  let fail!: (error: Error) => void;
  writeText.mockReturnValue(
    new Promise<void>((_, reject) => {
      fail = reject;
    }),
  );
  let copiedValue = "";
  let selectionFocused = false;
  execCommand.mockImplementation(() => {
    const textarea = document.querySelector("textarea")!;
    copiedValue = textarea.value.slice(
      textarea.selectionStart,
      textarea.selectionEnd,
    );
    selectionFocused = document.activeElement === textarea;
    return true;
  });
  const source = openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "复制链接" }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(source).toHaveFocus();
  await act(async () => fail(new Error("test denied")));
  await screen.findByText("已复制链接", { exact: true });
  expect(copiedValue).toBe(window.location.origin + "/albums/a_sample");
  expect(selectionFocused).toBe(true);
  expect(document.querySelector("textarea")).toBeNull();
  expect(source).toHaveFocus();
});

it("剪贴板 API 缺失时尝试选区复制", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  const source = openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "复制链接" }));
  await screen.findByText("已复制链接", { exact: true });
  expect(execCommand).toHaveBeenCalledWith("copy");
  expect(document.querySelector("textarea")).toBeNull();
  expect(source).toHaveFocus();
});

it.each(["false", "throw"] as const)(
  "回退 %s 时清理选区并反馈失败，重新打开菜单可重试",
  async (failure) => {
    writeText.mockRejectedValue(new Error("test denied"));
    execCommand.mockImplementationOnce(() => {
      if (failure === "throw") throw new Error("test copy failed");
      return false;
    });
    const source = openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "复制链接" }));
    await screen.findByText("复制失败，请检查浏览器权限", { exact: true });
    expect(screen.queryByText("已复制链接")).toBeNull();
    expect(document.querySelector("textarea")).toBeNull();
    expect(source).toHaveFocus();
    fireEvent.click(source);
    fireEvent.click(screen.getByRole("menuitem", { name: "复制链接" }));
    await screen.findByText("已复制链接", { exact: true });
    await waitFor(() => expect(execCommand).toHaveBeenCalledTimes(2));
  },
);
