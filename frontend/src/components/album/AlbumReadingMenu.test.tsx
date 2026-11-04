import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import AlbumCard, { type CardData } from "./AlbumCard";
import AlbumGrid from "./AlbumGrid";
import { activityApi } from "../../api/activity";
import { useUIStore } from "../../store/uiStore";

vi.mock("../../api/activity", () => ({
  activityApi: {
    setImage: vi.fn(),
    removeImage: vi.fn(),
    setPhoto: vi.fn(),
    removePhoto: vi.fn(),
  },
}));
vi.mock("../../hooks/useFavorites", () => ({
  useFavorites: () => ({
    favorites: [],
    toggle: vi.fn().mockResolvedValue([]),
  }),
  useToggleFavorite: () => vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../hooks/useAlbumActions", () => ({
  useAlbumActions: () => ({
    canOpenInExplorer: false,
    open: vi.fn(),
    openInExplorer: vi.fn().mockResolvedValue(undefined),
    copyLink: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock("../common/PropertiesDialog", () => ({ default: () => null }));
vi.mock("../common/TranscodeStatusBadge", () => ({ default: () => null }));
vi.mock("../../hooks/useVideoCover", () => ({
  useVideoCover: () => ({
    status: "error",
    url: "",
    retry: vi.fn(),
    enabled: true,
  }),
}));
vi.mock("react-virtuoso", () => {
  function Items({
    data,
    itemContent,
  }: {
    data: CardData[];
    itemContent: (index: number, item: CardData) => ReactNode;
  }) {
    return (
      <>
        {data.map((item, index) => (
          <div key={item.id}>{itemContent(index, item)}</div>
        ))}
      </>
    );
  }
  return { Virtuoso: Items, VirtuosoGrid: Items };
});

function renderCards(
  variant: "grid" | "list",
  overrides: Partial<CardData> = {},
  standalone = false,
) {
  const data: CardData = {
    id: "a_one",
    variant: "album",
    title: "单图相册",
    count: 1,
    imageCount: 1,
    videoCount: 0,
    coverPath: "f_cover",
    to: "/albums/a_one",
    contentKind: "photo",
    ...overrides,
  };
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {standalone ? (
          <AlbumCard data={data} variant={variant} />
        ) : (
          <AlbumGrid items={[data]} variant={variant} />
        )}
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.contextMenu(screen.getByRole("link"), {
    clientX: 120,
    clientY: 160,
  });
  return client;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(activityApi.setPhoto).mockResolvedValue({
    albumId: "a_one",
    mediaKind: "photo",
    pageIndex: 0,
    pageCount: 1,
    status: "completed",
    updated: "2026-11-01T00:00:00Z",
  });
  vi.mocked(activityApi.removePhoto).mockResolvedValue({
    ok: true,
    removed: true,
  });
  useUIStore.setState({ toasts: [] });
});

it.each(["grid", "list"] as const)(
  "%s 未读单图可通过唯一菜单标记已读",
  async (variant) => {
    const client = renderCards(variant);
    const batchKey = ["activity-query", "image", ["a_one"]];
    const detailKey = ["activity", "image", "a_one"];
    client.setQueryData(batchKey, {});
    client.setQueryData(detailKey, null);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    const menu = within(screen.getByRole("menu"));
    expect(menu.getByRole("menuitem", { name: "打开" })).toBeEnabled();
    expect(menu.getByRole("menuitem", { name: "收藏" })).toBeEnabled();
    expect(menu.getByRole("menuitem", { name: "取消已看完" })).toBeDisabled();
    fireEvent.click(menu.getByRole("menuitem", { name: "标记为已看完" }));
    await waitFor(() =>
      expect(activityApi.setPhoto).toHaveBeenCalledWith("a_one", 0, 1),
    );
    await waitFor(() =>
      expect(
        useUIStore
          .getState()
          .toasts.some((toast) => toast.message === "已看完"),
      ).toBe(true),
    );
    expect(activityApi.setPhoto).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(batchKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true);
  },
);

it.each(["grid", "list"] as const)(
  "%s 在读相册只打开一个菜单并按当前图片数标记末页",
  async (variant) => {
    renderCards(variant, {
      count: 3,
      imageCount: 3,
      progress: { index: 0, total: 2 },
    });
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "标记为已看完" }));
    await waitFor(() =>
      expect(activityApi.setPhoto).toHaveBeenCalledWith("a_one", 2, 3),
    );
  },
);

it.each(["grid", "list"] as const)(
  "%s 已读单图可以取消已读",
  async (variant) => {
    const client = renderCards(variant, { progress: { index: 0, total: 1 } });
    const detailKey = ["activity", "image", "a_one"];
    client.setQueryData(detailKey, { pageIndex: 0, pageCount: 1 });
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menuitem", { name: "标记为已看完" })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "取消已看完" }));
    await waitFor(() =>
      expect(activityApi.removePhoto).toHaveBeenCalledWith("a_one"),
    );
    await waitFor(() =>
      expect(
        useUIStore
          .getState()
          .toasts.some((toast) => toast.message === "已重置为未浏览"),
      ).toBe(true),
    );
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true);
  },
);

it.each(["grid", "list"] as const)(
  "独立 %s 卡片也提供同一组操作",
  async (variant) => {
    renderCards(variant, {}, true);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menuitem", { name: "收藏" })).toBeEnabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "标记为已看完" }));
    await waitFor(() =>
      expect(activityApi.setPhoto).toHaveBeenCalledWith("a_one", 0, 1),
    );
  },
);

it.each(["grid", "list"] as const)(
  "%s 纯视频相册不提供图片阅读标记",
  (variant) => {
    renderCards(variant, {
      imageCount: 0,
      count: 0,
      videoCount: 2,
      coverKind: "video",
    });
    expect(screen.queryByRole("menuitem", { name: "标记为已看完" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "取消已看完" })).toBeNull();
    expect(activityApi.setPhoto).not.toHaveBeenCalled();
  },
);

it("标记失败提示错误，保留未读显示并允许重新操作", async () => {
  vi.mocked(activityApi.setPhoto).mockRejectedValueOnce(new Error("offline"));
  renderCards("grid");
  fireEvent.click(screen.getByRole("menuitem", { name: "标记为已看完" }));
  await waitFor(() =>
    expect(
      useUIStore
        .getState()
        .toasts.some((toast) => toast.message === "标记失败"),
    ).toBe(true),
  );
  expect(screen.queryByText("已读", { exact: true })).toBeNull();
  fireEvent.contextMenu(screen.getByRole("link"));
  fireEvent.click(screen.getByRole("menuitem", { name: "标记为已看完" }));
  await waitFor(() => expect(activityApi.setPhoto).toHaveBeenCalledTimes(2));
});

it.each(["collection", "smart"] as const)(
  "%s 聚合卡片不提供相册阅读标记",
  (variant) => {
    renderCards("grid", { variant });
    expect(screen.getByRole("menuitem", { name: "收藏" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "属性" })).toHaveProperty(
      "disabled",
      variant === "smart",
    );
    expect(screen.queryByRole("menuitem", { name: "标记为已看完" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "取消已看完" })).toBeNull();
  },
);
