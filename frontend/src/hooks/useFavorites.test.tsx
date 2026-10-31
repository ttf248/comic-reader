import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { favoritesApi } from "../api/prefs";
import { useFavorites } from "./useFavorites";

vi.mock("../api/prefs", () => ({
  favoritesApi: { list: vi.fn(), add: vi.fn(), remove: vi.fn() },
}));

function setup(initial?: string[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (initial) client.setQueryData(["favorites"], { favorites: initial });
  const hook = renderHook(() => useFavorites(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...hook, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(favoritesApi.list).mockResolvedValue({ favorites: [] });
  vi.mocked(favoritesApi.add).mockResolvedValue({ favorites: ["a_trip"] });
  vi.mocked(favoritesApi.remove).mockResolvedValue({ favorites: [] });
});

it("添加成功后刷新失败仍展示服务端返回的完整收藏", async () => {
  vi.mocked(favoritesApi.list).mockRejectedValue(new Error("offline"));
  vi.mocked(favoritesApi.add).mockResolvedValue({
    favorites: ["a_trip", "a_other"],
  });
  const { result } = setup([]);
  await act(async () => {
    await result.current.add("a_trip");
  });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.favorites).toEqual(["a_trip", "a_other"]);
});

it("移除成功后刷新失败不再回显已移除的收藏", async () => {
  vi.mocked(favoritesApi.list).mockRejectedValue(new Error("offline"));
  vi.mocked(favoritesApi.remove).mockResolvedValue({ favorites: ["a_other"] });
  const { result } = setup(["a_trip", "a_other"]);
  await act(async () => {
    await result.current.remove("a_trip");
  });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.favorites).toEqual(["a_other"]);
});

it("写入成功不等待后台列表刷新结束", async () => {
  vi.mocked(favoritesApi.list).mockReturnValue(new Promise(() => {}));
  const { result } = setup([]);
  let committed = false;
  act(() => {
    void result.current.add("a_trip").then(() => {
      committed = true;
    });
  });
  await waitFor(() => expect(committed).toBe(true));
  expect(result.current.favorites).toEqual(["a_trip"]);
  expect(result.current.isFetching).toBe(true);
});

it.each(["add", "remove"] as const)(
  "%s 失败保留原缓存，不把失败当成功",
  async (operation) => {
    vi.mocked(favoritesApi[operation]).mockRejectedValue(new Error("offline"));
    const { result } = setup(["a_trip"]);
    await act(async () => {
      await expect(result.current[operation]("a_trip")).rejects.toThrow(
        "offline",
      );
    });
    expect(result.current.favorites).toEqual(["a_trip"]);
    expect(favoritesApi.list).not.toHaveBeenCalled();
  },
);

it("先前取得的切换函数也使用当前共享缓存判断操作", async () => {
  const { result, client } = setup([]);
  const toggle = result.current.toggle;
  act(() => {
    client.setQueryData(["favorites"], { favorites: ["a_trip"] });
  });
  await act(async () => {
    await toggle("a_trip");
  });
  expect(favoritesApi.remove).toHaveBeenCalledWith("a_trip");
  expect(favoritesApi.add).not.toHaveBeenCalled();
});

it("首次列表未完成时等待共享查询，再按真实收藏状态切换", async () => {
  let finish: (value: { favorites: string[] }) => void = () => {};
  vi.mocked(favoritesApi.list).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result } = setup();
  const operation = result.current.toggle("a_trip");
  await act(async () => {
    await Promise.resolve();
  });
  expect(favoritesApi.add).not.toHaveBeenCalled();
  expect(favoritesApi.remove).not.toHaveBeenCalled();
  await act(async () => {
    finish({ favorites: ["a_trip"] });
    await operation;
  });
  expect(favoritesApi.remove).toHaveBeenCalledWith("a_trip");
  expect(favoritesApi.list).toHaveBeenCalledTimes(2);
});

it("无法确认首次收藏列表时切换失败，不盲目写入", async () => {
  vi.mocked(favoritesApi.list).mockRejectedValue(new Error("offline"));
  const { result } = setup();
  await waitFor(() => expect(result.current.isError).toBe(true));
  await act(async () => {
    await expect(result.current.toggle("a_trip")).rejects.toThrow("offline");
  });
  expect(favoritesApi.add).not.toHaveBeenCalled();
  expect(favoritesApi.remove).not.toHaveBeenCalled();
});
