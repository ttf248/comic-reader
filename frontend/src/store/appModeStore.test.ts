import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppModeStore } from "./appModeStore";
import { prefsApi } from "../api/prefs";

vi.mock("../api/prefs", () => ({
  prefsApi: { patch: vi.fn() },
}));

vi.mock("../api/queryClient", () => ({
  queryClient: { setQueryData: vi.fn() },
}));

describe("appModeStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppModeStore.setState({ mode: "photo", ready: false });
  });

  it("水合服务端返回的模式", () => {
    useAppModeStore.getState().hydrate("comic");
    expect(useAppModeStore.getState().mode).toBe("comic");
    expect(useAppModeStore.getState().ready).toBe(true);
  });

  it("用户选过模式后，服务端稍后返回的旧值不覆盖它", () => {
    vi.mocked(prefsApi.patch).mockResolvedValue({
      favorites: [],
      history: [],
      maxRecent: 10,
      autoSwitchAlbum: true,
      showSwitchNotif: true,
      theme: "system",
      sidebarCollapsed: false,
      appMode: "comic",
    });
    useAppModeStore.getState().setMode("comic");
    useAppModeStore.getState().hydrate("photo");
    expect(useAppModeStore.getState().mode).toBe("comic");
  });

  it("切换模式会写服务端偏好", async () => {
    vi.mocked(prefsApi.patch).mockResolvedValue({
      favorites: [],
      history: [],
      maxRecent: 10,
      autoSwitchAlbum: true,
      showSwitchNotif: true,
      theme: "system",
      sidebarCollapsed: false,
      appMode: "comic",
    });
    useAppModeStore.getState().setMode("comic");
    expect(useAppModeStore.getState().mode).toBe("comic");
    expect(prefsApi.patch).toHaveBeenCalledWith({ appMode: "comic" });
  });

  it("写服务端失败时回到原模式", async () => {
    vi.mocked(prefsApi.patch).mockRejectedValue(new Error("offline"));
    useAppModeStore.getState().setMode("comic");
    await vi.waitFor(() =>
      expect(useAppModeStore.getState().mode).toBe("photo"),
    );
  });
});
