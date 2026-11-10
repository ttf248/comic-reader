import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { picksApi } from "../api/picks";
import { usePicks } from "./usePicks";

vi.mock("../api/picks", () => ({
  picksApi: { list: vi.fn(), batch: vi.fn(), media: vi.fn() },
}));

function setup(initial?: string[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (initial)
    client.setQueryData(["picks"], { picks: initial, total: initial.length, revision: 1 });
  const hook = renderHook(() => usePicks(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...hook, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(picksApi.list).mockResolvedValue({
    picks: [],
    total: 0,
    revision: 1,
  });
  vi.mocked(picksApi.batch).mockResolvedValue({
    ok: true,
    updated: 1,
    total: 1,
    revision: 2,
  });
});

it("集合是精选状态的唯一来源：跨页面共享同一份", async () => {
  const { result } = setup(["f_a"]);
  await waitFor(() => expect(result.current.isPicked("f_a")).toBe(true));
  expect(result.current.isPicked("f_b")).toBe(false);
  expect(result.current.total).toBe(1);
});

it("加入精选立刻反映到界面上，不用等服务端确认", async () => {
  let resolveBatch: (value: unknown) => void = () => {};
  vi.mocked(picksApi.batch).mockReturnValue(
    new Promise((resolve) => {
      resolveBatch = resolve;
    }) as never,
  );
  const { result } = setup([]);
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  let pending: Promise<void> | undefined;
  act(() => {
    pending = result.current.add(["f_new"]);
  });

  // 乐观更新：网络还没回来，界面已经是新状态。
  await waitFor(() => expect(result.current.isPicked("f_new")).toBe(true));
  expect(result.current.total).toBe(1);

  await act(async () => {
    resolveBatch({ ok: true, updated: 1, total: 1, revision: 2 });
    await pending;
  });
});

it("写入失败时退回原样，界面不停在服务端并不认可的状态上", async () => {
  vi.mocked(picksApi.batch).mockRejectedValue(new Error("offline"));
  const { result } = setup(["f_a"]);
  await waitFor(() => expect(result.current.isPicked("f_a")).toBe(true));

  await act(async () => {
    await expect(result.current.add(["f_new"])).rejects.toThrow("offline");
  });

  expect(result.current.isPicked("f_new")).toBe(false);
  expect(result.current.isPicked("f_a")).toBe(true);
});

it("切换精选按当前状态决定加入还是移出", async () => {
  const { result } = setup(["f_a"]);
  await waitFor(() => expect(result.current.isPicked("f_a")).toBe(true));

  await act(async () => {
    await result.current.toggle("f_a");
  });
  expect(vi.mocked(picksApi.batch)).toHaveBeenCalledWith(["f_a"], "remove");

  await act(async () => {
    await result.current.toggle("f_b");
  });
  expect(vi.mocked(picksApi.batch)).toHaveBeenCalledWith(["f_b"], "add");
});

it("集合还没回来时，媒体项自带的精选标记先把状态画出来", async () => {
  vi.mocked(picksApi.list).mockReturnValue(new Promise(() => {}) as never);
  const { result } = setup();
  await waitFor(() => expect(result.current.isLoading).toBe(true));

  await act(async () => {
    result.current.mergeServerFlags([
      { id: "f_picked", picked: true },
      { id: "f_plain", picked: false },
    ]);
  });

  await waitFor(() => expect(result.current.isPicked("f_picked")).toBe(true));
  expect(result.current.isPicked("f_plain")).toBe(false);
});
