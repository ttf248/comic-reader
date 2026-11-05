import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppModeStore } from "./appModeStore";
import { prefsApi, type Prefs } from "../api/prefs";

vi.mock("../api/prefs", () => ({
  prefsApi: { patch: vi.fn() },
}));

vi.mock("../api/queryClient", () => ({
  queryClient: { setQueryData: vi.fn() },
}));

const savedPrefs = {
  favorites: [] as string[],
  history: [] as Prefs["history"],
  maxRecent: 10,
  autoSwitchAlbum: true,
  showSwitchNotif: true,
  theme: "system",
  sidebarCollapsed: false,
  appMode: "comic",
} satisfies Prefs;

describe("appModeStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppModeStore.setState({ preference: "photo", hydrated: false });
  });

  it("水合服务端返回的偏好", () => {
    useAppModeStore.getState().hydrate("comic");
    expect(useAppModeStore.getState().preference).toBe("comic");
    expect(useAppModeStore.getState().hydrated).toBe(true);
  });

  it("用户选过模式后，服务端稍后返回的旧值不覆盖它", () => {
    vi.mocked(prefsApi.patch).mockResolvedValue(savedPrefs);
    useAppModeStore.getState().switchPreference("comic");
    useAppModeStore.getState().hydrate("photo");
    expect(useAppModeStore.getState().preference).toBe("comic");
  });

  it("切换模式会写服务端偏好", async () => {
    vi.mocked(prefsApi.patch).mockResolvedValue(savedPrefs);
    useAppModeStore.getState().switchPreference("comic");
    expect(useAppModeStore.getState().preference).toBe("comic");
    expect(prefsApi.patch).toHaveBeenCalledWith({ appMode: "comic" });
  });

  it("写服务端失败时回到原偏好", async () => {
    vi.mocked(prefsApi.patch).mockRejectedValue(new Error("offline"));
    useAppModeStore.getState().switchPreference("comic");
    await vi.waitFor(() =>
      expect(useAppModeStore.getState().preference).toBe("photo"),
    );
  });
});
