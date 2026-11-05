import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ACTIVITY_CHANGED_EVENT } from "../api/activity";
import { libraryApi } from "../api/library";
import {
  libraryQueryKeys,
  useLibraryActivitySync,
  useLibraryUnreadAlbums,
} from "./useLibrary";

vi.mock("../api/library", () => ({
  libraryApi: { allUnreadAlbums: vi.fn() },
}));

// 列表查询等模式水合后才发请求；这里直接给出就绪状态。
vi.mock("./useAppMode", () => ({
  useAppMode: () => ({ mode: "photo", ready: true, setMode: vi.fn() }),
}));

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

it("活动变化同时失效未打开页面的阅读摘要，并保留静态库缓存", () => {
  const { client, wrapper } = setup();
  const keys = [
    libraryQueryKeys.activitySummary("photo"),
    libraryQueryKeys.dashboard("photo"),
    libraryQueryKeys.unreadAlbums("photo"),
  ];
  const staticKey = libraryQueryKeys.nodes(["a_one"]);
  for (const key of [...keys, staticKey]) client.setQueryData(key, {});
  renderHook(() => useLibraryActivitySync(), { wrapper });
  act(() => {
    window.dispatchEvent(new Event(ACTIVITY_CHANGED_EVENT));
  });
  for (const key of keys)
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  expect(client.getQueryState(staticKey)?.isInvalidated).toBe(false);
});

it("离开未读页后变化不下载列表，返回时立即刷新未过期的旧缓存", async () => {
  const { wrapper } = setup();
  vi.mocked(libraryApi.allUnreadAlbums)
    .mockResolvedValueOnce({
      revision: 1,
      total: 1,
      items: [
        {
          id: "a_one",
          kind: "album",
          contentKind: "photo",
          name: "单图",
          displayName: "单图",
          coverImages: [],
          imageCount: 1,
        },
      ],
    })
    .mockResolvedValue({ revision: 1, total: 0, items: [] });
  function UnreadCount() {
    const query = useLibraryUnreadAlbums();
    return <output>{query.data?.total ?? "加载中"}</output>;
  }
  function Application({ showUnread }: { showUnread: boolean }) {
    useLibraryActivitySync();
    return showUnread ? <UnreadCount /> : <p>其他页面</p>;
  }
  const { rerender } = render(<Application showUnread />, { wrapper });
  expect(await screen.findByText("1")).toBeInTheDocument();
  rerender(<Application showUnread={false} />);
  act(() => {
    window.dispatchEvent(new Event(ACTIVITY_CHANGED_EVENT));
  });
  expect(libraryApi.allUnreadAlbums).toHaveBeenCalledTimes(1);
  rerender(<Application showUnread />);
  expect(await screen.findByText("0")).toBeInTheDocument();
  expect(libraryApi.allUnreadAlbums).toHaveBeenCalledTimes(2);
});

it("应用卸载后移除活动同步监听", () => {
  const { client, wrapper } = setup();
  const key = libraryQueryKeys.unreadAlbums("photo");
  client.setQueryData(key, {});
  const { unmount } = renderHook(() => useLibraryActivitySync(), { wrapper });
  unmount();
  act(() => {
    window.dispatchEvent(new Event(ACTIVITY_CHANGED_EVENT));
  });
  expect(client.getQueryState(key)?.isInvalidated).toBe(false);
});
