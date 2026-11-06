import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import PropertiesDialog from "./PropertiesDialog";
import { libraryApi, type LibraryNodeSummary } from "../../api/library";
import { imageInfoApi } from "../../api/imageInfo";

vi.mock("../../api/library", () => ({ libraryApi: { queryNodes: vi.fn() } }));
vi.mock("../../api/imageInfo", () => ({ imageInfoApi: { get: vi.fn() } }));

// jsdom 没有原生 dialog 方法；焦点限制、Esc 和背景交互由浏览器用例验证。
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

const node: LibraryNodeSummary = {
  id: "a_trip",
  kind: "album",
  contentKind: "photo",
  name: "旅行记录",
  displayName: "旅行记录",
  sourceName: "素材",
  coverImages: [],
  imageCount: 1,
  videoCount: 2,
  mediaCount: 3,
  folderSize: 1024,
  modTime: "2026-11-01T00:00:00Z",
  tags: ["旅行"],
};
const image = {
  path: "f_picture",
  name: "照片.png",
  dir: "素材/旅行记录",
  size: 256,
  mtime: "2026-11-01T00:00:00Z",
  width: 40,
  height: 50,
  format: "png",
  checksum: "abc123",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(libraryApi.queryNodes).mockResolvedValue({
    revision: 1,
    items: [node],
    missing: [],
  });
  vi.mocked(imageInfoApi.get).mockResolvedValue(image);
});

function renderDialog(target: { kind: "node" | "image"; id: string } | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const onClose = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    onClose,
    ...render(<PropertiesDialog target={target} onClose={onClose} />, {
      wrapper,
    }),
  };
}

it("相册属性读取目录摘要并显示真实统计", async () => {
  renderDialog({ kind: "node", id: "a_trip" });
  expect(await screen.findByText("旅行记录")).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "属性" })).toBeInTheDocument();
  expect(screen.getByText("1 张")).toBeInTheDocument();
  expect(screen.getByText("2 个")).toBeInTheDocument();
  expect(screen.getByText("1.0 KB")).toBeInTheDocument();
  expect(screen.getByText("素材")).toBeInTheDocument();
  expect(libraryApi.queryNodes).toHaveBeenCalledWith(["a_trip"]);
  expect(imageInfoApi.get).not.toHaveBeenCalled();
});

it("集合属性显示聚合媒体和相册数量", async () => {
  vi.mocked(libraryApi.queryNodes).mockResolvedValueOnce({
    revision: 1,
    missing: [],
    items: [
      {
        ...node,
        id: "c_trip",
        kind: "collection",
        contentKind: "photo",
        albumCount: 5,
        childCount: 3,
        mediaCount: 46,
      },
    ],
  });
  renderDialog({ kind: "node", id: "c_trip" });
  expect(await screen.findByText("集合")).toBeInTheDocument();
  expect(screen.getByText("5 本")).toBeInTheDocument();
  expect(screen.getByText("46 项")).toBeInTheDocument();
  expect(imageInfoApi.get).not.toHaveBeenCalled();
});

it("漫画侧的计数单位是页与卷", async () => {
  vi.mocked(libraryApi.queryNodes).mockResolvedValueOnce({
    revision: 1,
    missing: [],
    items: [
      {
        ...node,
        id: "c_comic",
        kind: "collection",
        contentKind: "comic",
        albumCount: 5,
        childCount: 3,
        mediaCount: 46,
      },
    ],
  });
  renderDialog({ kind: "node", id: "c_comic" });
  // 漫画侧的集合叫「作品」—— 与集合页的眉标同一个词。
  expect(await screen.findByText("作品")).toBeInTheDocument();
  expect(screen.getByText("5 卷")).toBeInTheDocument();
});

it("图片属性只请求文件元数据", async () => {
  renderDialog({ kind: "image", id: "f_picture" });
  expect(await screen.findByText("照片.png")).toBeInTheDocument();
  expect(screen.getByText("40 × 50 px")).toBeInTheDocument();
  expect(screen.getByText("PNG")).toBeInTheDocument();
  expect(imageInfoApi.get).toHaveBeenCalledWith("f_picture");
  expect(libraryApi.queryNodes).not.toHaveBeenCalled();
});

it("目录摘要读取失败可以重试", async () => {
  vi.mocked(libraryApi.queryNodes).mockRejectedValueOnce(new Error("offline"));
  renderDialog({ kind: "node", id: "a_trip" });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "无法读取目录属性",
  );
  fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  expect(await screen.findByText("旅行记录")).toBeInTheDocument();
  expect(libraryApi.queryNodes).toHaveBeenCalledTimes(2);
});

it("资源失效时显示不可用提示", async () => {
  vi.mocked(libraryApi.queryNodes).mockResolvedValueOnce({
    revision: 1,
    items: [],
    missing: ["a_trip"],
  });
  const { onClose } = renderDialog({ kind: "node", id: "a_trip" });
  expect(await screen.findByText("此目录已不在媒体库中")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(imageInfoApi.get).not.toHaveBeenCalled();
});

it("图片元数据读取失败可以重试", async () => {
  vi.mocked(imageInfoApi.get).mockRejectedValueOnce(new Error("offline"));
  renderDialog({ kind: "image", id: "f_picture" });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "无法读取图片属性",
  );
  fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  expect(await screen.findByText("照片.png")).toBeInTheDocument();
  expect(imageInfoApi.get).toHaveBeenCalledTimes(2);
});

it("切换资源后不展示上一个目录的字段", async () => {
  const view = renderDialog({ kind: "node", id: "a_trip" });
  expect(await screen.findByText("旅行记录")).toBeInTheDocument();
  view.rerender(
    <PropertiesDialog
      target={{ kind: "image", id: "f_picture" }}
      onClose={view.onClose}
    />,
  );
  expect(await screen.findByText("照片.png")).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText("旅行记录")).toBeNull());
});

it("关闭时不请求属性", () => {
  renderDialog(null);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(libraryApi.queryNodes).not.toHaveBeenCalled();
  expect(imageInfoApi.get).not.toHaveBeenCalled();
});
