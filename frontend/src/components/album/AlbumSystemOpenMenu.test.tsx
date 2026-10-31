import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import AlbumContextMenu from "./AlbumContextMenu";
import type { CardData } from "./AlbumCard";
import { fsApi } from "../../api/fs";
import { ApiError } from "../../api/client";
import ToastViewport from "../common/Toast";
import { useUIStore } from "../../store/uiStore";
import {
  fsCapabilitiesQueryKey,
  updateFsCapabilities,
} from "../../hooks/useFsCapabilities";

vi.mock("../../api/fs", () => ({
  fsApi: { capabilities: vi.fn(), openInExplorer: vi.fn() },
}));
vi.mock("../../hooks/useFavorites", () => ({
  useFavorites: () => ({ favorites: [], toggle: vi.fn() }),
}));

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
    defaultOptions: {
      queries: { gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
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
  return { client, source };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fsApi.capabilities).mockResolvedValue({ allowOsOpen: true });
  vi.mocked(fsApi.openInExplorer).mockResolvedValue({ ok: true });
  useUIStore.setState({ toasts: [] });
});

it("菜单已打开时响应权限变化", async () => {
  let finish!: (value: { allowOsOpen: boolean }) => void;
  vi.mocked(fsApi.capabilities).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { client } = openMenu();
  const item = screen.getByRole("menuitem", { name: "在资源管理器中打开" });
  expect(item).toBeDisabled();
  await act(async () => finish({ allowOsOpen: true }));
  await waitFor(() => expect(item).toBeEnabled());
  act(() => updateFsCapabilities(client, false));
  await waitFor(() => expect(item).toBeDisabled());
  expect(fsApi.openInExplorer).not.toHaveBeenCalled();
});

it("关闭菜单后仍反馈打开失败，重新打开可重试", async () => {
  let fail!: (error: Error) => void;
  vi.mocked(fsApi.openInExplorer).mockReturnValueOnce(
    new Promise((_, reject) => {
      fail = reject;
    }),
  );
  const { source } = openMenu();
  const item = screen.getByRole("menuitem", { name: "在资源管理器中打开" });
  await waitFor(() => expect(item).toBeEnabled());
  fireEvent.click(item);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(source).toHaveFocus();
  await act(async () =>
    fail(new ApiError(500, "failed", undefined, "os_open_failed")),
  );
  await screen.findByText("系统文件管理器未能打开，请确认目录仍可用后重试");
  fireEvent.click(source);
  fireEvent.click(screen.getByRole("menuitem", { name: "在资源管理器中打开" }));
  await screen.findByText("已请求打开目录");
  expect(fsApi.openInExplorer).toHaveBeenCalledTimes(2);
  expect(fsApi.openInExplorer).toHaveBeenLastCalledWith("a_sample");
});

it("智能视图没有本地目录，即使允许也不开放系统操作", async () => {
  const { client } = openMenu({ ...album, variant: "smart", to: "/tags/tag" });
  await waitFor(() =>
    expect(client.getQueryData(fsCapabilitiesQueryKey)).toEqual({
      allowOsOpen: true,
    }),
  );
  expect(
    screen.getByRole("menuitem", { name: "在资源管理器中打开" }),
  ).toBeDisabled();
  expect(fsApi.openInExplorer).not.toHaveBeenCalled();
});

it("未知失败不把原始错误和绝对路径写入通知", async () => {
  vi.mocked(fsApi.openInExplorer).mockRejectedValue(
    new Error("private: C:\\private\\file"),
  );
  openMenu();
  const item = screen.getByRole("menuitem", { name: "在资源管理器中打开" });
  await waitFor(() => expect(item).toBeEnabled());
  fireEvent.click(item);
  await screen.findByText("打开失败，请稍后重试");
  expect(JSON.stringify(useUIStore.getState().toasts)).not.toContain("private");
});
