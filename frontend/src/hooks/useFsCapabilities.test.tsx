import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { fsApi, type FsCapabilities } from "../api/fs";
import {
  fsCapabilitiesQueryKey,
  updateFsCapabilities,
  useFsCapabilities,
} from "./useFsCapabilities";

vi.mock("../api/fs", () => ({ fsApi: { capabilities: vi.fn() } }));

beforeEach(() => vi.resetAllMocks());

function renderCapabilities() {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity } },
  });
  const view = renderHook(() => useFsCapabilities(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...view, client };
}

it("权限请求完成后响应式启用已挂载的入口", async () => {
  let finish!: (value: FsCapabilities) => void;
  vi.mocked(fsApi.capabilities).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = renderCapabilities();
  expect(view.result.current).toBe(false);
  await act(async () => finish({ allowOsOpen: true }));
  await waitFor(() => expect(view.result.current).toBe(true));
  act(() => updateFsCapabilities(view.client, false));
  await waitFor(() => expect(view.result.current).toBe(false));
});

it("已保存权限取消旧读取，迟到响应不能回退确认结果", async () => {
  let finish!: (value: FsCapabilities) => void;
  let signal: AbortSignal | undefined;
  vi.mocked(fsApi.capabilities).mockImplementation((requestedSignal) => {
    signal = requestedSignal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const view = renderCapabilities();
  await waitFor(() => expect(fsApi.capabilities).toHaveBeenCalledTimes(1));
  act(() => updateFsCapabilities(view.client, true));
  await waitFor(() => expect(view.result.current).toBe(true));
  expect(signal?.aborted).toBe(true);
  await act(async () => finish({ allowOsOpen: false }));
  expect(view.client.getQueryData(fsCapabilitiesQueryKey)).toEqual({
    allowOsOpen: true,
  });
  expect(view.result.current).toBe(true);
});

it("首次读取失败时保持关闭，重新读取成功后恢复", async () => {
  vi.mocked(fsApi.capabilities).mockRejectedValueOnce(new Error("offline"));
  const view = renderCapabilities();
  await waitFor(() =>
    expect(view.client.getQueryState(fsCapabilitiesQueryKey)?.status).toBe(
      "error",
    ),
  );
  expect(view.result.current).toBe(false);
  vi.mocked(fsApi.capabilities).mockResolvedValue({ allowOsOpen: true });
  await act(async () => {
    await view.client.invalidateQueries({ queryKey: fsCapabilitiesQueryKey });
  });
  await waitFor(() => expect(view.result.current).toBe(true));
});
