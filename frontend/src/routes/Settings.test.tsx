import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { favoritesApi, historyApi, prefsApi, type Prefs } from "../api/prefs";
import { cacheApi } from "../api/cache";
import { useUIStore } from "../store/uiStore";
import Settings from "./Settings";

vi.mock("../api/prefs", () => ({
  prefsApi: { get: vi.fn(), patch: vi.fn() },
  favoritesApi: { prune: vi.fn() },
  historyApi: { clear: vi.fn() },
}));
vi.mock("../api/cache", () => ({
  cacheApi: { stats: vi.fn() },
  formatBytes: (value: number) => `${value} B`,
}));
vi.mock("../hooks/useScanSSE", () => ({
  useScanSSE: () => ({ isRunning: false, startWith: vi.fn() }),
}));
vi.mock("../hooks/useLibrary", () => ({
  libraryQueryKeys: { root: ["library"] },
  useLibraryManifest: () => ({ data: undefined }),
}));
vi.mock("../components/settings/ServerConfigPanel", () => ({
  default: () => <div>服务端设置</div>,
}));

const basePrefs: Prefs = {
  favorites: [],
  history: [],
  maxRecent: 10,
  autoSwitchAlbum: false,
  showSwitchNotif: true,
  theme: "system",
  sidebarCollapsed: false,
};
const clientForTest = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });
function renderSettings(client = clientForTest()) {
  return render(
    <QueryClientProvider client={client}>
      <Settings />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("__APP_VERSION__", "test");
  useUIStore.setState({ toasts: [] });
  vi.mocked(prefsApi.get).mockResolvedValue(basePrefs);
  vi.mocked(prefsApi.patch).mockImplementation(async (patch) => ({
    ...basePrefs,
    ...patch,
  }));
  vi.mocked(favoritesApi.prune).mockResolvedValue({ removed: [] });
  vi.mocked(historyApi.clear).mockResolvedValue({ ok: true });
  const sub = { path: "cache", bytes: 0, fileCount: 0, available: false };
  vi.mocked(cacheApi.stats).mockResolvedValue({
    path: "cache",
    totalBytes: 0,
    fileCount: 0,
    scannedAt: "",
    durationMs: 0,
    available: false,
    cacheTtlSeconds: 0,
    thumbs: sub,
    videoFaststart: sub,
    videoTranscode: sub,
  });
});
afterEach(() => vi.unstubAllGlobals());

it("读取设置期间显示加载状态", () => {
  vi.mocked(prefsApi.get).mockReturnValue(new Promise(() => {}));
  renderSettings();
  expect(screen.getByRole("status")).toHaveTextContent("正在加载设置");
});

it("读取设置失败提供重试，恢复后可操作", async () => {
  vi.mocked(prefsApi.get).mockRejectedValueOnce(new Error("offline"));
  renderSettings();
  expect(await screen.findByRole("alert")).toHaveTextContent("设置加载失败");
  expect(
    screen.queryByText("加载中…", { exact: true }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  expect(
    await screen.findByRole("switch", { name: "阅读到末尾自动切换下一本" }),
  ).toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("后台读取失败保留上次设置", async () => {
  const client = clientForTest();
  client.setQueryData(["prefs"], basePrefs);
  vi.mocked(prefsApi.get).mockRejectedValue(new Error("offline"));
  renderSettings(client);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "仍显示上次加载的设置",
  );
  expect(
    screen.getByRole("switch", { name: "切换时显示通知" }),
  ).toHaveAttribute("aria-checked", "true");
});

it("保存阅读设置失败保留原值并提示，随后可以再次保存", async () => {
  vi.mocked(prefsApi.patch).mockRejectedValueOnce(new Error("offline"));
  renderSettings();
  const toggle = await screen.findByRole("switch", {
    name: "阅读到末尾自动切换下一本",
  });
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(useUIStore.getState().toasts).toContainEqual(
      expect.objectContaining({ kind: "error", message: "保存阅读设置失败" }),
    ),
  );
  expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(toggle).toBeEnabled();
  vi.mocked(prefsApi.get).mockResolvedValue({
    ...basePrefs,
    autoSwitchAlbum: true,
  });
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  expect(prefsApi.patch).toHaveBeenCalledTimes(2);
});

it("保存成功后刷新失败仍展示服务端已确认的新设置", async () => {
  renderSettings();
  const toggle = await screen.findByRole("switch", {
    name: "阅读到末尾自动切换下一本",
  });
  vi.mocked(prefsApi.get).mockRejectedValue(new Error("offline"));
  fireEvent.click(toggle);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "仍显示上次加载的设置",
  );
  expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(useUIStore.getState().toasts).not.toContainEqual(
    expect.objectContaining({ kind: "error", message: "保存阅读设置失败" }),
  );
});

it("阅读设置保存期间禁止重复请求和交错修改", async () => {
  let finish: (value: Prefs) => void = () => {};
  vi.mocked(prefsApi.patch).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  renderSettings();
  const toggle = await screen.findByRole("switch", {
    name: "阅读到末尾自动切换下一本",
  });
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeDisabled());
  expect(screen.getByRole("switch", { name: "切换时显示通知" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "增加最近访问保留条数" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "减少最近访问保留条数" }),
  ).toBeDisabled();
  fireEvent.click(toggle);
  expect(prefsApi.patch).toHaveBeenCalledTimes(1);
  vi.mocked(prefsApi.get).mockResolvedValue({
    ...basePrefs,
    autoSwitchAlbum: true,
  });
  await act(async () => {
    finish({ ...basePrefs, autoSwitchAlbum: true });
  });
  await waitFor(() => expect(toggle).toBeEnabled());
});

for (const kind of ["prune", "history"] as const) {
  const buttonName = kind === "prune" ? "清理" : "清空";
  const message = kind === "prune" ? "清理失效收藏失败" : "清空最近访问失败";
  it(`${buttonName}失败明确提示且可以重新操作`, async () => {
    const operation = kind === "prune" ? favoritesApi.prune : historyApi.clear;
    vi.mocked(operation).mockRejectedValueOnce(new Error("offline"));
    renderSettings();
    const button = await screen.findByRole("button", {
      name: buttonName,
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(useUIStore.getState().toasts).toContainEqual(
        expect.objectContaining({ kind: "error", message }),
      ),
    );
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() =>
      expect(useUIStore.getState().toasts).toContainEqual(
        expect.objectContaining({ kind: "success" }),
      ),
    );
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it(`${buttonName}执行中禁止重复请求`, async () => {
    const operation = kind === "prune" ? favoritesApi.prune : historyApi.clear;
    vi.mocked(operation).mockReturnValue(new Promise<never>(() => {}));
    renderSettings();
    const button = await screen.findByRole("button", {
      name: buttonName,
    });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    expect(operation).toHaveBeenCalledTimes(1);
  });
}
