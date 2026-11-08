import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { favoritesApi } from "../../api/prefs";
import { activityApi } from "../../api/activity";
import { libraryApi } from "../../api/library";
import {
  useSelectionStore,
  type SelectionItem,
} from "../../store/selectionStore";
import { useUIStore } from "../../store/uiStore";
import BulkActions from "./BulkActions";

const mode = vi.hoisted(() => ({ value: "comic" as "photo" | "comic" }));
vi.mock("../../hooks/useAppMode", () => ({
  useAppMode: () => ({ mode: mode.value }),
}));
vi.mock("../../api/prefs", () => ({ favoritesApi: { batch: vi.fn() } }));
vi.mock("../../api/activity", () => ({
  activityApi: { setBatch: vi.fn(), removeImages: vi.fn() },
}));
vi.mock("../../api/library", () => ({ libraryApi: { queryNodes: vi.fn() } }));
const items: SelectionItem[] = [
  {
    id: "a_comic",
    albumId: "a_comic",
    title: "漫画",
    contentKind: "comic",
    imageCount: 3,
  },
  { id: "c_collection", title: "作品", contentKind: "comic", imageCount: 0 },
  {
    id: "a_photo",
    albumId: "a_photo",
    title: "照片",
    contentKind: "photo",
    imageCount: 3,
  },
  {
    id: "a_empty",
    albumId: "a_empty",
    title: "空相册",
    contentKind: "comic",
    imageCount: 0,
  },
];
beforeEach(() => {
  vi.clearAllMocks();
  mode.value = "comic";
  useSelectionStore.setState({
    scope: "one",
    active: true,
    busy: false,
    items: Object.fromEntries(items.map((item) => [item.id, item])),
  });
  useUIStore.setState({ toasts: [] });
});
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BulkActions loaded={items} />
    </QueryClientProvider>,
  );
  return client;
}

it("仅漫画非空相册参与已读，使用服务端当前页数", async () => {
  vi.mocked(libraryApi.queryNodes).mockResolvedValue({
    revision: 1,
    missing: [],
    items: [
      {
        id: "a_comic",
        kind: "album",
        name: "漫画",
        displayName: "漫画",
        contentKind: "comic",
        imageCount: 5,
        coverImages: [],
      },
    ],
  });
  vi.mocked(activityApi.setBatch).mockResolvedValue({ ok: true, updated: 1 });
  setup();
  fireEvent.click(screen.getByRole("button", { name: "标记已读" }));
  await waitFor(() =>
    expect(activityApi.setBatch).toHaveBeenCalledWith([
      { albumId: "a_comic", mediaKind: "image", pageIndex: 4, pageCount: 5 },
    ]),
  );
  await waitFor(() => expect(useSelectionStore.getState().active).toBe(false));
});

it("照片工作台只有收藏动作，失败保留选择可重试", async () => {
  mode.value = "photo";
  vi.mocked(favoritesApi.batch)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ favorites: ["a_comic"], updated: 1 });
  setup();
  expect(
    screen.queryByRole("button", { name: "标记已读" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "重置未读" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "批量收藏" }));
  await waitFor(() => expect(useSelectionStore.getState().busy).toBe(false));
  expect(Object.keys(useSelectionStore.getState().items)).toHaveLength(4);
  fireEvent.click(screen.getByRole("button", { name: "批量收藏" }));
  await waitFor(() => expect(useSelectionStore.getState().active).toBe(false));
  expect(favoritesApi.batch).toHaveBeenCalledTimes(2);
});

it("提交中禁用重复操作，迟到确认仍写入共享收藏缓存", async () => {
  let resolve!: (value: { favorites: string[]; updated: number }) => void;
  vi.mocked(favoritesApi.batch).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const client = setup();
  fireEvent.click(screen.getByRole("button", { name: "批量收藏" }));
  expect(screen.getByRole("button", { name: "批量收藏" })).toBeDisabled();
  useSelectionStore.getState().ensureScope("other");
  resolve({ favorites: ["a_comic"], updated: 1 });
  await waitFor(() =>
    expect(client.getQueryData(["favorites"])).toEqual({
      favorites: ["a_comic"],
    }),
  );
  expect(useSelectionStore.getState().scope).toBe("other");
});
