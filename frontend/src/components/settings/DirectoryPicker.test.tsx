import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fsApi, type DirectoryPage } from "../../api/fs";
import { ApiError } from "../../api/client";
import DirectoryPicker from "./DirectoryPicker";

vi.mock("../../api/fs", () => ({ fsApi: { directories: vi.fn() } }));

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

const home: DirectoryPage = {
  directory: "/photos/原图 [100%] #",
  parent: "/photos",
  roots: ["/"],
  items: [{ name: "子目录", path: "/photos/原图 [100%] #/子目录" }],
  nextAfter: "",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fsApi.directories).mockResolvedValue(home);
});

function setup(initialDirectory = "old") {
  const onPick = vi.fn();
  const onClose = vi.fn();
  return {
    ...render(
      <DirectoryPicker
        initialDirectory={initialDirectory}
        onPick={onPick}
        onClose={onClose}
      />,
    ),
    onPick,
    onClose,
  };
}

it.each(["/photos/原图 [100%] #", "F:\\other\\原图 [100%] #"])(
  "仅在确认时使用服务端完整路径 %s",
  async (directory) => {
    vi.mocked(fsApi.directories).mockResolvedValue({ ...home, directory });
    const { onPick } = setup();
    const input = await screen.findByDisplayValue(directory);
    expect(input).toHaveFocus();
    expect(fsApi.directories).toHaveBeenCalledWith(
      "old",
      "",
      expect.any(AbortSignal),
    );
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "not-visited" } });
    expect(screen.getByRole("button", { name: "使用此目录" })).toBeDisabled();
    fireEvent.change(input, { target: { value: directory } });
    fireEvent.click(screen.getByRole("button", { name: "使用此目录" }));
    expect(onPick).toHaveBeenCalledWith(directory);
  },
);

it("按服务端路径进入子目录并追加下一页", async () => {
  vi.mocked(fsApi.directories)
    .mockResolvedValueOnce(home)
    .mockResolvedValueOnce({
      ...home,
      directory: home.items[0].path,
      items: [{ name: "A", path: "A-path" }],
      nextAfter: "A",
    })
    .mockResolvedValueOnce({
      ...home,
      directory: home.items[0].path,
      items: [{ name: "B", path: "B-path" }],
    });
  const { onPick } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "子目录" }));
  fireEvent.click(await screen.findByRole("button", { name: "加载更多目录" }));
  expect(await screen.findByRole("button", { name: "B" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "A" })).toBeInTheDocument();
  expect(fsApi.directories).toHaveBeenLastCalledWith(
    home.items[0].path,
    "A",
    expect.any(AbortSignal),
  );
  expect(onPick).not.toHaveBeenCalled();
});

it("读取失败不暴露原始错误，可重试且不会确认旧目录", async () => {
  vi.mocked(fsApi.directories)
    .mockRejectedValueOnce(
      new ApiError(
        500,
        "private C:\\secret",
        undefined,
        "directory_read_failed",
      ),
    )
    .mockResolvedValueOnce(home);
  const { onPick } = setup();
  expect(await screen.findByRole("alert")).not.toHaveTextContent("private");
  expect(screen.getByRole("button", { name: "使用此目录" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByDisplayValue(home.directory);
  expect(onPick).not.toHaveBeenCalled();
});

it("导航时取消旧请求，迟到响应不会覆盖新目录", async () => {
  let release: ((page: DirectoryPage) => void) | undefined;
  vi.mocked(fsApi.directories)
    .mockResolvedValueOnce(home)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce({ ...home, directory: "/home" });
  setup();
  fireEvent.click(await screen.findByRole("button", { name: "子目录" }));
  const oldSignal = vi.mocked(fsApi.directories).mock.calls[1][2];
  fireEvent.click(screen.getByRole("button", { name: "主目录" }));
  await screen.findByDisplayValue("/home");
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => {
    release?.({ ...home, directory: "/stale" });
  });
  expect(screen.getByLabelText("目录路径")).toHaveValue("/home");
});

it("取消及卸载中断请求，不回填路径", async () => {
  vi.mocked(fsApi.directories).mockReturnValue(new Promise(() => {}));
  const { onClose, onPick, unmount } = setup();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(onClose).toHaveBeenCalledOnce();
  const signal = vi.mocked(fsApi.directories).mock.calls[0][2];
  unmount();
  expect(signal?.aborted).toBe(true);
  expect(onPick).not.toHaveBeenCalled();
});
