import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { configApi, type ServerConfig } from "../api/config";
import { useScanStore } from "../store/scanStore";
import { useUIStore } from "../store/uiStore";
import { useServerConfigSave } from "./useServerConfigSave";

vi.mock("../api/config", () => ({ configApi: { update: vi.fn() } }));
const config: ServerConfig = {
  mediaRoots: [{ path: "/media", kind: "photo" }],
  host: "127.0.0.1",
  port: 8080,
  accessMode: "local",
  accessTokenConfigured: false,
  cacheDir: "cache",
  thumbCacheSize: 100,
  cacheMaxAgeDays: 30,
  cacheMaxSizeMB: 1024,
  allowOsOpen: false,
  staticDir: "dist",
  configPath: "config.yaml",
  skipHidden: true,
  systemFiles: [],
  excludePatterns: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  useScanStore.getState().clear();
  useUIStore.setState({ toasts: [] });
});

it.each([true, false])(
  "配置确认后自动扫描启动=%s，不把启动失败当保存失败",
  async (started) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.mocked(configApi.update).mockResolvedValue({
      ok: true,
      config,
      requiresRestart: [],
      mediaRootsChanged: true,
      scanId: started ? "automatic-scan" : undefined,
      scanStartError: started ? undefined : "scan_start_failed",
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useServerConfigSave({}, vi.fn()), {
      wrapper,
    });
    await act(async () => {
      await result.current.update.mutateAsync({
        mediaRoots: config.mediaRoots,
      });
    });
    await waitFor(() => expect(result.current.needsScan).toBe(!started));
    expect(useScanStore.getState().scanId).toBe(
      started ? "automatic-scan" : null,
    );
    expect(client.getQueryData(["server-config"])).toEqual(config);
    expect(result.current.hasFailures).toBe(false);
    expect(configApi.update).toHaveBeenCalledTimes(1);
    if (!started)
      expect(useUIStore.getState().toasts.at(-1)?.message).toContain(
        "配置已保存",
      );
  },
);
