import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import {
  act,
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ServerConfigPanel from "./ServerConfigPanel";
import {
  configApi,
  type MediaRootConfig,
  type ServerConfig,
} from "../../api/config";
import { useUIStore } from "../../store/uiStore";
import { ListFilterBar } from "../common/ListFilterBar";
import { useSearchStore } from "../../store/searchStore";
import { authApi } from "../../api/auth";
import { ApiError } from "../../api/client";
import { fsApi } from "../../api/fs";
import { fsCapabilitiesQueryKey } from "../../hooks/useFsCapabilities";
import { libraryQueryKeys } from "../../hooks/useLibrary";

// Mock the config API
vi.mock("../../api/config", () => ({
  configApi: {
    get: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../../api/auth", () => ({
  authApi: {
    login: vi.fn(),
    logout: vi.fn(),
  },
}));
vi.mock("../../api/fs", () => ({
  fsApi: {
    capabilities: vi.fn(),
    openConfiguredPath: vi.fn(),
    openInExplorer: vi.fn(),
    directories: vi.fn(),
  },
}));

const baseConfig = {
  mediaRoots: [{ path: "E:\\漫画", kind: "comic" as const }],
  host: "0.0.0.0",
  port: 8080,
  accessMode: "local" as const,
  accessTokenConfigured: false,
  cacheDir: ".local-gallery",
  thumbSizeW: 320,
  thumbSizeH: 350,
  thumbCacheSize: 500,
  cacheMaxAgeDays: 30,
  cacheMaxSizeMB: 10240,
  allowOsOpen: false,
  staticDir: "dist",
  configPath: "C:\\cfg.yaml",
  // 排除规则三件套:与后端 Config 字段一一对应
  skipHidden: true,
  systemFiles: [],
  excludePatterns: [],
};

beforeAll(() => {
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.open = true;
    },
    close(this: HTMLDialogElement) {
      this.open = false;
    },
  });
});

function renderPanel(queryClient?: QueryClient) {
  const qc =
    queryClient ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { gcTime: Infinity },
      },
    });
  const view = render(
    <QueryClientProvider client={qc}>
      <ServerConfigPanel />
    </QueryClientProvider>,
  );
  return { ...view, queryClient: qc };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function savedConfig(fields: Partial<ServerConfig> = {}) {
  return {
    ok: true,
    config: { ...baseConfig, ...fields },
    requiresRestart: [],
    mediaRootsChanged: false,
  };
}

describe("ServerConfigPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(configApi.get).mockResolvedValue(baseConfig);
    vi.mocked(configApi.update).mockResolvedValue({
      ok: true,
      config: { ...baseConfig, allowOsOpen: true },
      requiresRestart: [],
      mediaRootsChanged: false,
    });
    vi.mocked(authApi.login).mockResolvedValue({
      authenticated: true,
      mode: "lan",
    });
    vi.mocked(authApi.logout).mockResolvedValue(undefined);
    vi.mocked(fsApi.capabilities).mockResolvedValue({ allowOsOpen: false });
    vi.mocked(fsApi.openConfiguredPath).mockResolvedValue({ ok: true });
    vi.mocked(fsApi.directories).mockResolvedValue({
      directory: "/other/photos [100%] #",
      parent: "/other",
      roots: ["/"],
      items: [],
      nextAfter: "",
    });
    // 重置 toasts
    useUIStore.setState({ toasts: [] });
  });

  it("渲染当前配置", async () => {
    renderPanel();
    // mediaRoots 数组作为多 input 列表渲染
    expect(await screen.findByDisplayValue("E:\\漫画")).toBeInTheDocument();
    expect(screen.getByDisplayValue(".local-gallery")).toBeInTheDocument();
    expect(screen.getByDisplayValue("0.0.0.0")).toBeInTheDocument();
    expect(screen.getByDisplayValue("8080")).toBeInTheDocument();
  });

  it("配置字段都有可访问名称，屏幕阅读器能读出字段含义", async () => {
    renderPanel();
    await screen.findByDisplayValue("E:\\漫画");
    // 可见标签只是普通文本，屏幕阅读器读不到；输入框必须自带名称。
    for (const label of [
      "缓存目录",
      "LRU 缓存项数",
      "缓存保留天数",
      "派生缓存容量（MiB）",
      "监听地址",
      "监听端口",
      "前端构建目录",
      "媒体根目录 1",
      "排除模式",
      "额外的系统白名单",
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it("浏览或取消目录选择不改配置，确认后自动保存完整媒体根路径", async () => {
    renderPanel();
    const input = await screen.findByPlaceholderText(
      "E:\\照片 或 /home/user/pics",
    );
    const pickerButton = within(input.parentElement!).getByRole("button", {
      name: "选择本地目录",
    });
    fireEvent.click(pickerButton);
    await screen.findByDisplayValue("/other/photos [100%] #");
    expect(configApi.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(input).toHaveValue(baseConfig.mediaRoots[0].path);
    expect(configApi.update).not.toHaveBeenCalled();
    fireEvent.click(pickerButton);
    await screen.findByDisplayValue("/other/photos [100%] #");
    fireEvent.click(screen.getByRole("button", { name: "使用此目录" }));
    await waitFor(() =>
      expect(configApi.update).toHaveBeenCalledWith({
        mediaRoots: [{ path: "/other/photos [100%] #", kind: "comic" }],
      }),
    );
    expect(configApi.update).toHaveBeenCalledOnce();
  });

  it.each(["cacheDir", "staticDir"] as const)(
    "确认选择 %s 后立即保存，不再等待输入框失焦",
    async (key) => {
      renderPanel();
      const input = await screen.findByDisplayValue(baseConfig[key]);
      fireEvent.click(
        within(input.parentElement!).getByRole("button", {
          name: "选择本地目录",
        }),
      );
      await screen.findByDisplayValue("/other/photos [100%] #");
      fireEvent.click(screen.getByRole("button", { name: "使用此目录" }));
      await waitFor(() =>
        expect(configApi.update).toHaveBeenCalledWith({
          [key]: "/other/photos [100%] #",
        }),
      );
      expect(configApi.update).toHaveBeenCalledOnce();
    },
  );

  it("远程访问设置时显示仅本机提示而不是永久加载", async () => {
    vi.mocked(configApi.get).mockRejectedValue(
      new ApiError(
        403,
        "this management endpoint is local-only",
        undefined,
        "local_access_required",
      ),
    );
    renderPanel();
    expect(
      await screen.findByText("服务端设置仅可在运行服务的计算机上管理"),
    ).toBeInTheDocument();
    expect(screen.queryByText("加载中…")).not.toBeInTheDocument();
  });

  it("开启 LAN 时同步写入强令牌并立即换取会话", async () => {
    const token = "0123456789abcdef0123456789abcdef";
    vi.mocked(configApi.update).mockResolvedValue({
      ok: true,
      config: {
        ...baseConfig,
        accessMode: "lan",
        accessTokenConfigured: true,
      },
      requiresRestart: [],
      mediaRootsChanged: false,
    });
    renderPanel();
    const input = await screen.findByLabelText("LAN 访问令牌");
    fireEvent.change(input, { target: { value: token } });
    fireEvent.click(screen.getByRole("button", { name: "开启 LAN 访问" }));
    await waitFor(() =>
      expect(configApi.update).toHaveBeenCalledWith({
        accessMode: "lan",
        accessToken: token,
      }),
    );
    expect(authApi.login).toHaveBeenCalledWith(token);
  });

  it("切换 boolean 立即保存", async () => {
    const { queryClient } = renderPanel();
    // 现在有多个 switch（allowOsOpen + skipHidden）;用 label 文本锁定目标
    const toggle = await screen.findByRole("switch", {
      name: /允许在系统文件管理器中打开/,
    });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(configApi.update).toHaveBeenCalledWith({ allowOsOpen: true });
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(fsCapabilitiesQueryKey)).toEqual({
        allowOsOpen: true,
      }),
    );
    expect(fsApi.capabilities).not.toHaveBeenCalled();
  });

  it.each([
    baseConfig.mediaRoots[0].path,
    baseConfig.cacheDir,
    baseConfig.staticDir,
  ])("配置目录 %s 使用白名单入口打开并反馈结果", async (path) => {
    vi.mocked(configApi.get).mockResolvedValue({
      ...baseConfig,
      allowOsOpen: true,
    });
    renderPanel();
    const input = await screen.findByDisplayValue(path);
    fireEvent.click(
      within(input.parentElement!).getByRole("button", {
        name: "在系统文件管理器中打开此目录",
      }),
    );
    await waitFor(() =>
      expect(fsApi.openConfiguredPath).toHaveBeenCalledWith(path),
    );
    await waitFor(() =>
      expect(useUIStore.getState().toasts).toEqual([
        expect.objectContaining({ kind: "success", message: "已请求打开目录" }),
      ]),
    );
    expect(fsApi.openInExplorer).not.toHaveBeenCalled();
  });

  it("配置目录不在白名单时显示明确提示而不保存原始错误", async () => {
    vi.mocked(configApi.get).mockResolvedValue({
      ...baseConfig,
      allowOsOpen: true,
    });
    vi.mocked(fsApi.openConfiguredPath).mockRejectedValueOnce(
      new ApiError(
        403,
        "C:\\private\\directory",
        undefined,
        "config_path_not_allowed",
      ),
    );
    renderPanel();
    const input = await screen.findByDisplayValue(baseConfig.mediaRoots[0].path);
    fireEvent.click(
      within(input.parentElement!).getByRole("button", {
        name: "在系统文件管理器中打开此目录",
      }),
    );
    await waitFor(() =>
      expect(useUIStore.getState().toasts).toEqual([
        expect.objectContaining({
          kind: "error",
          message: "此目录尚未保存到配置，请保存后重试",
        }),
      ]),
    );
    expect(JSON.stringify(useUIStore.getState().toasts)).not.toContain(
      "private",
    );
  });

  it("修改数字后 debounce 触发保存", async () => {
    renderPanel();
    const portInput = (await screen.findByDisplayValue(
      "8080",
    )) as HTMLInputElement;
    fireEvent.change(portInput, { target: { value: "9090" } });
    // debounce 期间不应立即调用
    expect(configApi.update).not.toHaveBeenCalled();
    // 等待 debounce + flush（默认 600ms + 余量）
    await waitFor(
      () => expect(configApi.update).toHaveBeenCalledWith({ port: 9090 }),
      { timeout: 1500 },
    );
  });

  it("缓存容量可以显式设为零", async () => {
    renderPanel();
    const input = await screen.findByDisplayValue("10240");
    fireEvent.change(input, { target: { value: "0" } });
    await waitFor(
      () =>
        expect(configApi.update).toHaveBeenCalledWith({ cacheMaxSizeMB: 0 }),
      { timeout: 1500 },
    );
  });

  it('修改 port 后弹出"需重启"提示', async () => {
    vi.mocked(configApi.update).mockResolvedValue({
      ok: true,
      config: { ...baseConfig, port: 9090 },
      requiresRestart: ["port"],
      mediaRootsChanged: false,
    });
    renderPanel();
    const portInput = (await screen.findByDisplayValue(
      "8080",
    )) as HTMLInputElement;
    fireEvent.change(portInput, { target: { value: "9090" } });
    await waitFor(
      () => expect(configApi.update).toHaveBeenCalledWith({ port: 9090 }),
      { timeout: 1500 },
    );
    // toast 文本进入 store（ToastViewport 在路由层挂载，单测里查 DOM 不可靠）
    await waitFor(() => {
      const toasts = useUIStore.getState().toasts;
      expect(
        toasts.some((t) => t.message.includes("修改后需要重启后端才能生效")),
      ).toBe(true);
    });
  });

  it.each(["cacheDir", "staticDir"] as const)(
    "%s 按 Esc 撤销未保存编辑，之后 Enter 和失焦仍可正常保存",
    async (key) => {
      renderPanel();
      const input = await screen.findByDisplayValue(baseConfig[key]);
      act(() => input.focus());
      fireEvent.change(input, { target: { value: "/cancelled/path" } });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(input).toHaveValue(baseConfig[key]);
      expect(configApi.update).not.toHaveBeenCalled();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 700));
      });
      expect(configApi.update).not.toHaveBeenCalled();

      act(() => input.focus());
      fireEvent.change(input, { target: { value: "/confirmed/path" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(configApi.update).toHaveBeenCalledWith({
          [key]: "/confirmed/path",
        }),
      );
      fireEvent.blur(input);
      expect(configApi.update).toHaveBeenCalledOnce();

      act(() => input.focus());
      fireEvent.change(input, { target: { value: "/blurred/path" } });
      fireEvent.blur(input);
      await waitFor(() =>
        expect(configApi.update).toHaveBeenLastCalledWith({
          [key]: "/blurred/path",
        }),
      );
      expect(configApi.update).toHaveBeenCalledTimes(2);
    },
  );

  it("媒体根按 Esc 撤销整组未提交修改及空槽位，保留其他设置草稿", async () => {
    const roots = [
      { path: baseConfig.mediaRoots[0].path, kind: "comic" as const },
      { path: "/photos/second", kind: "photo" as const },
    ];
    vi.mocked(configApi.get).mockResolvedValue({
      ...baseConfig,
      mediaRoots: roots,
    });
    vi.mocked(configApi.update).mockResolvedValue({
      ok: true,
      config: { ...baseConfig, mediaRoots: roots, port: 9090 },
      requiresRestart: [],
      mediaRootsChanged: false,
    });
    renderPanel();
    const inputs = await screen.findAllByPlaceholderText(
      "E:\\照片 或 /home/user/pics",
    );
    fireEvent.change(await screen.findByDisplayValue("8080"), {
      target: { value: "9090" },
    });
    fireEvent.change(inputs[0], { target: { value: "/cancelled/first" } });
    fireEvent.change(inputs[1], { target: { value: "/cancelled/second" } });
    fireEvent.click(screen.getByRole("button", { name: "添加根目录" }));
    const added = screen.getAllByPlaceholderText(
      "E:\\照片 或 /home/user/pics",
    )[2];
    act(() => added.focus());
    fireEvent.keyDown(added, { key: "Escape" });
    expect(
      screen.getAllByPlaceholderText("E:\\照片 或 /home/user/pics"),
    ).toHaveLength(2);
    expect(inputs[0]).toHaveValue(roots[0].path);
    expect(inputs[1]).toHaveValue(roots[1].path);
    await waitFor(
      () => expect(configApi.update).toHaveBeenCalledWith({ port: 9090 }),
      { timeout: 1500 },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    expect(configApi.update).toHaveBeenCalledOnce();
  });

  it("Esc 恢复最新确认的媒体根，不会回滚已经完成的自动保存", async () => {
    vi.mocked(configApi.update).mockResolvedValue({
      ok: true,
      config: {
        ...baseConfig,
        mediaRoots: [{ path: "/photos/saved", kind: "comic" }],
      },
      requiresRestart: [],
      mediaRootsChanged: false,
    });
    const { queryClient } = renderPanel();
    const input = await screen.findByPlaceholderText(
      "E:\\照片 或 /home/user/pics",
    );
    fireEvent.change(input, { target: { value: "/photos/saved" } });
    await waitFor(
      () =>
        expect(queryClient.getQueryData(["server-config"])).toEqual(
          expect.objectContaining({
            mediaRoots: [{ path: "/photos/saved", kind: "comic" }],
          }),
        ),
      { timeout: 1500 },
    );
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "/photos/cancelled" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("/photos/saved");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    expect(configApi.update).toHaveBeenCalledOnce();
  });

  it("Esc 不回滚已经发出、随后才确认的媒体根保存", async () => {
    let release:
      | ((result: Awaited<ReturnType<typeof configApi.update>>) => void)
      | undefined;
    vi.mocked(configApi.update).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    renderPanel();
    const input = await screen.findByPlaceholderText(
      "E:\\照片 或 /home/user/pics",
    );
    fireEvent.change(input, { target: { value: "/photos/submitted" } });
    await waitFor(() => expect(configApi.update).toHaveBeenCalledOnce(), {
      timeout: 1500,
    });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "/photos/cancelled" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await act(async () => {
      release?.({
        ok: true,
        config: {
          ...baseConfig,
          mediaRoots: [{ path: "/photos/submitted", kind: "comic" }],
        },
        requiresRestart: [],
        mediaRootsChanged: false,
      });
    });
    expect(input).toHaveValue("/photos/submitted");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    expect(configApi.update).toHaveBeenCalledOnce();
  });

  it.each(["Enter", "Escape"])(
    "中文输入法组合期间的 %s 不保存或取消路径编辑",
    async (key) => {
      renderPanel();
      const input = await screen.findByDisplayValue(baseConfig.cacheDir);
      act(() => input.focus());
      fireEvent.change(input, { target: { value: "/photos/输入中" } });
      fireEvent.keyDown(input, { key, isComposing: true });
      expect(input).toHaveFocus();
      expect(input).toHaveValue("/photos/输入中");
      expect(configApi.update).not.toHaveBeenCalled();
    },
  );

  it.each(["mediaRoots", "host", "port"] as const)(
    "%s 组合输入期间不自动保存，确认文字后重新等待保存间隔",
    async (field) => {
      renderPanel();
      const original =
        field === "mediaRoots"
          ? baseConfig.mediaRoots[0].path
          : String(baseConfig[field]);
      const input = await screen.findByDisplayValue(original);
      const candidate = field === "port" ? "909" : "/photos/候选文字";
      fireEvent.compositionStart(input);
      fireEvent.change(input, { target: { value: candidate } });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 800));
      });
      expect(configApi.update).not.toHaveBeenCalled();
      expect(input).toHaveValue(field === "port" ? 909 : candidate);
      const final =
        field === "mediaRoots"
          ? "/photos/最终目录"
          : field === "port"
            ? "9090"
            : "final.local";
      fireEvent.change(input, { target: { value: final } });
      fireEvent.compositionEnd(input);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      expect(configApi.update).not.toHaveBeenCalled();
      await waitFor(
        () =>
          expect(configApi.update).toHaveBeenCalledWith({
            [field]:
              field === "mediaRoots"
                ? [{ path: final, kind: "comic" }]
                : field === "port"
                  ? Number(final)
                  : final,
          }),
        { timeout: 1500 },
      );
      expect(configApi.update).toHaveBeenCalledOnce();
    },
  );

  it("开始组合输入会暂停该字段的旧计时，但其他设置仍可自动保存", async () => {
    vi.mocked(configApi.update).mockResolvedValueOnce({
      ok: true,
      config: { ...baseConfig, port: 9090 },
      requiresRestart: [],
      mediaRootsChanged: false,
    });
    renderPanel();
    const input = await screen.findByDisplayValue(baseConfig.host);
    fireEvent.change(input, { target: { value: "pending.local" } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    fireEvent.compositionStart(input);
    fireEvent.change(screen.getByDisplayValue("8080"), {
      target: { value: "9090" },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    expect(configApi.update).toHaveBeenCalledOnce();
    expect(configApi.update).toHaveBeenCalledWith({ port: 9090 });
    expect(input).toHaveValue("pending.local");
    // 即使最终文字与组合前相同，也从 compositionend 重新计时。
    fireEvent.compositionEnd(input);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(configApi.update).toHaveBeenCalledOnce();
    await waitFor(
      () =>
        expect(configApi.update).toHaveBeenLastCalledWith({
          host: "pending.local",
        }),
      { timeout: 1500 },
    );
    expect(configApi.update).toHaveBeenCalledTimes(2);
  });

  it("移除正在组合输入的媒体根后可以保存剩余目录，离开页面清理未提交输入", async () => {
    vi.mocked(configApi.get).mockResolvedValue({
      ...baseConfig,
      mediaRoots: [
        { path: baseConfig.mediaRoots[0].path, kind: "comic" as const },
        { path: "/photos/remaining", kind: "photo" as const },
      ],
    });
    vi.mocked(configApi.update).mockResolvedValue({
      ok: true,
      config: {
        ...baseConfig,
        mediaRoots: [{ path: "/photos/remaining", kind: "photo" }],
      },
      requiresRestart: [],
      mediaRootsChanged: false,
    });
    const view = renderPanel();
    const input = await screen.findByDisplayValue(baseConfig.mediaRoots[0].path);
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "/photos/候选" } });
    fireEvent.click(screen.getAllByRole("button", { name: "删除此根目录" })[0]);
    await waitFor(
      () =>
        expect(configApi.update).toHaveBeenCalledWith({
          mediaRoots: [{ path: "/photos/remaining", kind: "photo" }],
        }),
      { timeout: 1500 },
    );
    const remaining = await screen.findByDisplayValue("/photos/remaining");
    fireEvent.compositionStart(remaining);
    fireEvent.change(remaining, { target: { value: "/photos/未确认" } });
    view.unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    expect(configApi.update).toHaveBeenCalledOnce();
  });

  it("目录组合输入失焦保存当前文字，晚到的组合结束事件不会重复提交", async () => {
    renderPanel();
    const input = await screen.findByDisplayValue(baseConfig.cacheDir);
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "/photos/确认文字" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(configApi.update).toHaveBeenCalledWith({
        cacheDir: "/photos/确认文字",
      }),
    );
    fireEvent.compositionEnd(input);
    fireEvent.blur(input);
    expect(configApi.update).toHaveBeenCalledOnce();
  });

  it("媒体根目录停止输入后自动保存并提示重新扫描", async () => {
    vi.mocked(configApi.update).mockResolvedValue({
      ok: true,
      config: {
        ...baseConfig,
        mediaRoots: [{ path: "D:\\new", kind: "comic" }],
      },
      requiresRestart: [],
      mediaRootsChanged: true,
    });
    renderPanel();
    const input = (await screen.findByDisplayValue(
      "E:\\漫画",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "D:\\new" } });
    // 媒体根目录不依赖 blur；停止输入后自动保存。
    await waitFor(
      () =>
        expect(configApi.update).toHaveBeenCalledWith({
          mediaRoots: [{ path: "D:\\new", kind: "comic" }],
        }),
      { timeout: 1500 },
    );
    expect(await screen.findByText(/媒体根目录配置已确认/)).toBeInTheDocument();
  });

  it("多根：补全新增根目录后自动保存", async () => {
    vi.mocked(configApi.update).mockResolvedValue({
      ok: true,
      config: {
        ...baseConfig,
        mediaRoots: [
          { path: "E:\\漫画", kind: "comic" },
          { path: "F:\\照片", kind: "photo" },
        ],
      },
      requiresRestart: [],
      mediaRootsChanged: true,
    });
    renderPanel();
    // 等待首个 input 出现
    const firstInput = (await screen.findByDisplayValue(
      "E:\\漫画",
    )) as HTMLInputElement;
    // 找「添加根目录」按钮并点击
    const addBtn = await screen.findByText(/添加根目录/);
    fireEvent.click(addBtn);
    // 等 React 渲染：新行 input 应该是空值
    const allInputs = await screen.findAllByRole("textbox");
    // 过滤出媒体根 input（placeholder 包含「照片」或「/home/user/pics」）
    const mediaRootInputs = allInputs.filter(
      (el) =>
        (el as HTMLInputElement).placeholder.includes("照片") ||
        (el as HTMLInputElement).placeholder.includes("/home/user/pics"),
    );
    expect(mediaRootInputs.length).toBeGreaterThanOrEqual(2);
    // 修改第二个为空槽位 → F:\\照片
    const secondInput = mediaRootInputs[1] as HTMLInputElement;
    fireEvent.change(secondInput, { target: { value: "F:\\照片" } });
    // 媒体根目录停止输入后自动保存，无需 blur。
    await waitFor(
      () =>
        expect(configApi.update).toHaveBeenCalledWith({
          mediaRoots: [
            { path: "E:\\漫画", kind: "comic" },
            { path: "F:\\照片", kind: "photo" },
          ],
        }),
      { timeout: 1500 },
    );
    expect(firstInput).toBeInTheDocument();
  });

  it("保存失败时显示错误 toast", async () => {
    vi.mocked(configApi.update).mockRejectedValueOnce(
      new Error("invalid port"),
    );
    renderPanel();
    const toggle = await screen.findByRole("switch", {
      name: /允许在系统文件管理器中打开/,
    });
    fireEvent.click(toggle);
    await waitFor(() => {
      const toasts = useUIStore.getState().toasts;
      expect(toasts.some((t) => t.message.includes("invalid port"))).toBe(true);
    });
  });

  it.each(["cacheDir", "mediaRoots"] as const)(
    "%s 保存失败保留输入，显式重试且不自动重复写入",
    async (key) => {
      const retry = deferred<ReturnType<typeof savedConfig>>();
      let attempts = 0;
      vi.mocked(configApi.update).mockImplementation(() =>
        ++attempts === 1
          ? Promise.reject(new Error("连接中断"))
          : retry.promise,
      );
      renderPanel();
      const input = await screen.findByDisplayValue(
        key === "cacheDir" ? baseConfig.cacheDir : baseConfig.mediaRoots[0].path,
      );
      fireEvent.change(input, { target: { value: "/recovery/photos" } });
      if (key === "cacheDir") fireEvent.blur(input);
      await screen.findByLabelText("保存失败");
      expect(input).toHaveValue("/recovery/photos");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 800));
      });
      expect(configApi.update).toHaveBeenCalledOnce();
      const button = screen.getByRole("button", { name: "重试保存" });
      fireEvent.click(button);
      fireEvent.click(button);
      await waitFor(() => expect(configApi.update).toHaveBeenCalledTimes(2));
      const value =
        key === "mediaRoots"
          ? [{ path: "/recovery/photos", kind: "comic" }]
          : "/recovery/photos";
      expect(configApi.update).toHaveBeenLastCalledWith({ [key]: value });
      await act(async () => {
        retry.resolve(savedConfig({ [key]: value }));
      });
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "重试保存" }),
        ).not.toBeInTheDocument(),
      );
      expect(input).toHaveValue("/recovery/photos");
    },
  );

  it.each([
    ["allowOsOpen", false],
    ["cacheMaxSizeMB", 0],
    ["excludePatterns", []],
  ] as const)("%s 的失败值保留 false、零和空数组", async (key, value) => {
    const original = {
      ...baseConfig,
      allowOsOpen: true,
      excludePatterns: ["old_*"],
    };
    vi.mocked(configApi.get).mockResolvedValue(original);
    let attempts = 0;
    vi.mocked(configApi.update).mockImplementation(() =>
      ++attempts === 1
        ? Promise.reject(new Error("保存中断"))
        : Promise.resolve(savedConfig({ [key]: value })),
    );
    renderPanel();
    let input: HTMLElement;
    if (key === "allowOsOpen") {
      input = await screen.findByRole("switch", {
        name: "允许在系统文件管理器中打开",
      });
      fireEvent.click(input);
    } else if (key === "cacheMaxSizeMB") {
      input = await screen.findByDisplayValue(
        String(baseConfig.cacheMaxSizeMB),
      );
      fireEvent.change(input, { target: { value: "0" } });
    } else {
      input = await screen.findByDisplayValue("old_*");
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.blur(input);
    }
    await screen.findByLabelText("保存失败");
    if (key === "allowOsOpen")
      expect(input).toHaveAttribute("aria-checked", "false");
    else expect(input).toHaveValue(key === "cacheMaxSizeMB" ? 0 : "");
    fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    await waitFor(() => expect(configApi.update).toHaveBeenCalledTimes(2));
    expect(configApi.update).toHaveBeenLastCalledWith({ [key]: value });
  });

  it("旧请求失败不恢复到新的组合输入上，之后只保存新值", async () => {
    const first = deferred<ReturnType<typeof savedConfig>>();
    vi.mocked(configApi.update).mockImplementation((patch) =>
      patch.host === "old"
        ? first.promise
        : Promise.resolve(savedConfig({ host: patch.host })),
    );
    renderPanel();
    const input = await screen.findByDisplayValue(baseConfig.host);
    fireEvent.change(input, { target: { value: "old" } });
    await waitFor(() => expect(configApi.update).toHaveBeenCalledOnce());
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "新候选" } });
    await act(async () => {
      first.reject(new Error("旧保存失败"));
    });
    expect(input).toHaveValue("新候选");
    expect(
      screen.queryByRole("button", { name: "重试保存" }),
    ).not.toBeInTheDocument();
    fireEvent.compositionEnd(input, { data: "new", target: { value: "new" } });
    await waitFor(() => expect(configApi.update).toHaveBeenCalledTimes(2));
    expect(configApi.update).toHaveBeenLastCalledWith({ host: "new" });
    await waitFor(() =>
      expect(screen.queryByLabelText("保存失败")).not.toBeInTheDocument(),
    );
  });

  it("离开后发生的失败在重新进入时恢复，并可按 Enter 重试路径", async () => {
    const first = deferred<ReturnType<typeof savedConfig>>();
    let attempts = 0;
    vi.mocked(configApi.update).mockImplementation(() =>
      ++attempts === 1
        ? first.promise
        : Promise.resolve(savedConfig({ cacheDir: "/retry/cache" })),
    );
    const view = renderPanel();
    const input = await screen.findByDisplayValue(baseConfig.cacheDir);
    fireEvent.change(input, { target: { value: "/retry/cache" } });
    fireEvent.blur(input);
    await waitFor(() => expect(configApi.update).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => {
      first.reject(new Error("迟到的失败"));
    });
    renderPanel(view.queryClient);
    const restored = await screen.findByDisplayValue("/retry/cache");
    await screen.findByRole("button", { name: "重试保存" });
    fireEvent.keyDown(restored, { key: "Enter" });
    fireEvent.blur(restored);
    await waitFor(() => expect(configApi.update).toHaveBeenCalledTimes(2));
    expect(configApi.update).toHaveBeenLastCalledWith({
      cacheDir: "/retry/cache",
    });
  });

  it("重新读取失败或取消保留失败输入，迟到响应不能回退后续读取", async () => {
    vi.mocked(configApi.update).mockRejectedValue(new Error("写入中断"));
    const { queryClient } = renderPanel();
    const input = await screen.findByDisplayValue(baseConfig.cacheDir);
    fireEvent.change(input, { target: { value: "/failed/cache" } });
    fireEvent.blur(input);
    await screen.findByLabelText("保存失败");
    vi.mocked(configApi.get).mockRejectedValue(new Error("读取中断"));
    fireEvent.click(screen.getByRole("button", { name: "重新读取配置" }));
    await screen.findByRole("button", { name: "重新读取配置" });
    expect(input).toHaveValue("/failed/cache");
    const late = deferred<ServerConfig>();
    let signal: AbortSignal | undefined;
    vi.mocked(configApi.get).mockImplementation((currentSignal) => {
      signal = currentSignal;
      return late.promise;
    });
    fireEvent.click(screen.getByRole("button", { name: "重新读取配置" }));
    expect(input).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "取消读取" }));
    expect(signal?.aborted).toBe(true);
    expect(input).toBeEnabled();
    vi.mocked(configApi.get).mockResolvedValue({
      ...baseConfig,
      cacheDir: "/confirmed/cache",
    });
    fireEvent.click(screen.getByRole("button", { name: "重新读取配置" }));
    await waitFor(() => expect(input).toHaveValue("/confirmed/cache"));
    await act(async () => {
      late.resolve({ ...baseConfig, cacheDir: "/stale/cache" });
    });
    expect(input).toHaveValue("/confirmed/cache");
    expect(queryClient.getQueryData(["server-config"])).toMatchObject({
      cacheDir: "/confirmed/cache",
    });
    expect(
      screen.queryByRole("button", { name: "重试保存" }),
    ).not.toBeInTheDocument();
    expect(configApi.update).toHaveBeenCalledOnce();
  });

  it("重新读取期间暂停其他草稿的自动保存，成功后保留并继续保存", async () => {
    vi.mocked(configApi.update).mockImplementation((patch) =>
      patch.cacheDir
        ? Promise.reject(new Error("写入中断"))
        : Promise.resolve(savedConfig({ port: patch.port })),
    );
    const view = renderPanel();
    const cache = await screen.findByDisplayValue(baseConfig.cacheDir);
    fireEvent.change(cache, { target: { value: "/failed/cache" } });
    fireEvent.blur(cache);
    await screen.findByLabelText("保存失败");
    const read = deferred<ServerConfig>();
    vi.mocked(configApi.get).mockImplementation(() => read.promise);
    const port = screen.getByDisplayValue(String(baseConfig.port));
    fireEvent.change(port, { target: { value: "9000" } });
    fireEvent.click(screen.getByRole("button", { name: "重新读取配置" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    expect(configApi.update).toHaveBeenCalledOnce();
    expect(port).toHaveValue(9000);
    await act(async () => {
      read.resolve(baseConfig);
    });
    expect(port).toHaveValue(9000);
    await waitFor(() => expect(configApi.update).toHaveBeenCalledTimes(2));
    expect(configApi.update).toHaveBeenLastCalledWith({ port: 9000 });
    view.unmount();
  });

  it("Esc 丢弃缓存目录的失败输入，不重放保存", async () => {
    vi.mocked(configApi.update).mockRejectedValue(new Error("写入中断"));
    renderPanel();
    const input = await screen.findByDisplayValue(baseConfig.cacheDir);
    fireEvent.change(input, { target: { value: "/failed/cache" } });
    fireEvent.blur(input);
    await screen.findByLabelText("保存失败");
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(input).toHaveValue(baseConfig.cacheDir);
    expect(screen.queryByLabelText("保存失败")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "重试保存" }),
    ).not.toBeInTheDocument();
    expect(configApi.update).toHaveBeenCalledOnce();
  });

  it("根目录丢失确认后重试即使返回未变更也清理旧媒体库", async () => {
    let attempts = 0;
    vi.mocked(configApi.update).mockImplementation(() =>
      ++attempts === 1
        ? Promise.reject(new Error("确认丢失"))
        : Promise.resolve(
            savedConfig({
              mediaRoots: [{ path: "/confirmed/root", kind: "comic" }],
            }),
          ),
    );
    const { queryClient } = renderPanel();
    const cachedKey = [...libraryQueryKeys.root, "recovery-check"];
    queryClient.setQueryData(cachedKey, { old: true });
    const input = await screen.findByDisplayValue(baseConfig.mediaRoots[0].path);
    fireEvent.change(input, { target: { value: "/confirmed/root" } });
    await screen.findByLabelText("保存失败");
    fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    await screen.findByText(/媒体根目录配置已确认/);
    expect(queryClient.getQueryData(cachedKey)).toBeUndefined();
    expect(input).toHaveValue("/confirmed/root");
  });

  it.each(["配置写入", "会话建立"] as const)(
    "LAN %s失败不进入通用重试或恢复缓存",
    async (stage) => {
      const token = "recovery-test-token-01234567890123456789";
      vi.mocked(configApi.update).mockResolvedValue(
        savedConfig({ accessMode: "lan", accessTokenConfigured: true }),
      );
      if (stage === "配置写入")
        vi.mocked(configApi.update).mockRejectedValue(
          new Error("配置写入失败"),
        );
      else
        vi.mocked(authApi.login).mockRejectedValue(new Error("会话建立失败"));
      const { queryClient } = renderPanel();
      fireEvent.change(await screen.findByLabelText("LAN 访问令牌"), {
        target: { value: token },
      });
      fireEvent.click(screen.getByRole("button", { name: "开启 LAN 访问" }));
      await screen.findByText("访问配置未完成，请确认令牌后重试");
      expect(
        screen.queryByRole("button", { name: "重试保存" }),
      ).not.toBeInTheDocument();
      expect(
        JSON.stringify(
          queryClient
            .getQueryCache()
            .getAll()
            .map((query) => query.state.data),
        ),
      ).not.toContain(token);
      expect(configApi.update).toHaveBeenCalledOnce();
    },
  );

  it("排除模式：编辑+blur 触发 PATCH,空行 trim 掉", async () => {
    renderPanel();
    // 找到「排除模式」textarea。给它一段内容,验证:onBlur 后空行被丢、
    // 单条非空 pattern 走 PATCH。
    const textarea = (await screen.findByPlaceholderText(
      /node_modules/,
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: "node_modules\n\n  \nbackup_*" },
    });
    fireEvent.blur(textarea);
    await waitFor(() => {
      expect(configApi.update).toHaveBeenCalledWith({
        excludePatterns: ["node_modules", "backup_*"],
      });
    });
  });

  it("skipHidden toggle 切换立即 PATCH", async () => {
    renderPanel();
    const toggle = await screen.findByRole("switch", { name: "跳过隐藏目录" });
    // 默认 baseConfig.skipHidden=true;点一下应变为 false
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(configApi.update).toHaveBeenCalledWith({ skipHidden: false });
    });
  });

  it("连续保存媒体根按顺序执行并持续显示最新待保存值", async () => {
    const first = deferred<ReturnType<typeof savedConfig>>();
    const second = deferred<ReturnType<typeof savedConfig>>();
    vi.mocked(configApi.update).mockImplementation((patch) =>
      patch.mediaRoots?.[0]?.path === "/save/one"
        ? first.promise
        : second.promise,
    );
    const { queryClient } = renderPanel();
    const input = await screen.findByPlaceholderText(
      "E:\\照片 或 /home/user/pics",
    );
    fireEvent.change(input, { target: { value: "/save/one" } });
    await waitFor(() => expect(configApi.update).toHaveBeenCalledOnce(), {
      timeout: 1500,
    });
    expect(input).toHaveValue("/save/one");
    fireEvent.change(input, { target: { value: "/save/cancelled" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("/save/one");
    fireEvent.change(input, { target: { value: "/save/two" } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(configApi.update).toHaveBeenCalledOnce();
    expect(input).toHaveValue("/save/two");
    await act(async () => {
      first.resolve(
        savedConfig({ mediaRoots: [{ path: "/save/one", kind: "comic" }] }),
      );
    });
    await waitFor(() => expect(configApi.update).toHaveBeenCalledTimes(2));
    expect(input).toHaveValue("/save/two");
    await act(async () => {
      second.resolve(
        savedConfig({ mediaRoots: [{ path: "/save/two", kind: "comic" }] }),
      );
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(["server-config"])).toMatchObject({
        mediaRoots: [{ path: "/save/two", kind: "comic" }],
      }),
    );
    expect(input).toHaveValue("/save/two");
  });

  it("前一次保存失败仍继续后续保存，不把旧错误覆盖到新结果", async () => {
    const first = deferred<ReturnType<typeof savedConfig>>();
    vi.mocked(configApi.update).mockImplementation((patch) =>
      patch.cacheDir === "/save/one"
        ? first.promise
        : Promise.resolve(savedConfig({ cacheDir: "/save/two" })),
    );
    const { queryClient } = renderPanel();
    const input = await screen.findByDisplayValue(baseConfig.cacheDir);
    fireEvent.change(input, { target: { value: "/save/one" } });
    fireEvent.blur(input);
    await waitFor(() => expect(configApi.update).toHaveBeenCalledOnce());
    fireEvent.change(input, { target: { value: "/save/two" } });
    fireEvent.blur(input);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(configApi.update).toHaveBeenCalledOnce();
    await act(async () => {
      first.reject(new Error("first save failed"));
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(["server-config"])).toMatchObject({
        cacheDir: "/save/two",
      }),
    );
    expect(input).toHaveValue("/save/two");
    expect(screen.queryByLabelText("保存失败")).not.toBeInTheDocument();
    expect(configApi.update).toHaveBeenCalledTimes(2);
  });

  it("旧保存确认不把仍在组合输入的新草稿标为已保存", async () => {
    const first = deferred<ReturnType<typeof savedConfig>>();
    vi.mocked(configApi.update).mockImplementation(() => first.promise);
    const { queryClient } = renderPanel();
    const input = await screen.findByDisplayValue(baseConfig.host);
    fireEvent.change(input, { target: { value: "old.local" } });
    await waitFor(() => expect(configApi.update).toHaveBeenCalledOnce(), {
      timeout: 1500,
    });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "新候选.local" } });
    await act(async () => {
      first.resolve(savedConfig({ host: "old.local" }));
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(["server-config"])).toMatchObject({
        host: "old.local",
      }),
    );
    expect(input).toHaveValue("新候选.local");
    expect(
      within(input.parentElement!).queryByLabelText("已保存"),
    ).not.toBeInTheDocument();
  });

  it("离开后重新进入沿用保存队列与待保存值", async () => {
    const first = deferred<ReturnType<typeof savedConfig>>();
    const second = deferred<ReturnType<typeof savedConfig>>();
    vi.mocked(configApi.update).mockImplementation((patch) =>
      patch.cacheDir === "/save/one" ? first.promise : second.promise,
    );
    const initial = renderPanel();
    const input = await screen.findByDisplayValue(baseConfig.cacheDir);
    fireEvent.change(input, { target: { value: "/save/one" } });
    fireEvent.blur(input);
    await waitFor(() => expect(configApi.update).toHaveBeenCalledOnce());
    initial.unmount();
    const next = renderPanel(initial.queryClient);
    const resumed = await screen.findByDisplayValue("/save/one");
    fireEvent.change(resumed, { target: { value: "/save/two" } });
    fireEvent.blur(resumed);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(configApi.update).toHaveBeenCalledOnce();
    await act(async () => {
      first.resolve(savedConfig({ cacheDir: "/save/one" }));
    });
    await waitFor(() => expect(configApi.update).toHaveBeenCalledTimes(2));
    expect(resumed).toHaveValue("/save/two");
    await act(async () => {
      second.resolve(savedConfig({ cacheDir: "/save/two" }));
    });
    await waitFor(() =>
      expect(initial.queryClient.getQueryData(["server-config"])).toMatchObject(
        { cacheDir: "/save/two" },
      ),
    );
    next.unmount();
  });

  it("保存确认会取消期间开始的旧配置读取", async () => {
    const write = deferred<ReturnType<typeof savedConfig>>();
    const read = deferred<ServerConfig>();
    vi.mocked(configApi.update).mockImplementation(() => write.promise);
    const { queryClient } = renderPanel();
    const input = await screen.findByDisplayValue(baseConfig.cacheDir);
    fireEvent.change(input, { target: { value: "/save/current" } });
    fireEvent.blur(input);
    await waitFor(() => expect(configApi.update).toHaveBeenCalledOnce());
    vi.mocked(configApi.get).mockImplementation(() => read.promise);
    const refetch = queryClient.refetchQueries({
      queryKey: ["server-config"],
      exact: true,
    });
    await waitFor(() => expect(configApi.get).toHaveBeenCalledTimes(2));
    await act(async () => {
      write.resolve(savedConfig({ cacheDir: "/save/current" }));
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(["server-config"])).toMatchObject({
        cacheDir: "/save/current",
      }),
    );
    await act(async () => {
      read.resolve(baseConfig);
      await refetch;
    });
    expect(queryClient.getQueryData(["server-config"])).toMatchObject({
      cacheDir: "/save/current",
    });
    expect(configApi.get).toHaveBeenLastCalledWith(expect.any(AbortSignal));
  });

  it("切换 LAN 后建立会话完成前不发送后续配置写请求", async () => {
    const token = "0123456789abcdef0123456789abcdef";
    const login = deferred<Awaited<ReturnType<typeof authApi.login>>>();
    vi.mocked(authApi.login).mockImplementation(() => login.promise);
    vi.mocked(configApi.update).mockImplementation(async (patch) =>
      savedConfig({
        accessMode: "lan",
        accessTokenConfigured: true,
        ...(patch.cacheDir ? { cacheDir: patch.cacheDir } : {}),
      }),
    );
    renderPanel();
    fireEvent.change(await screen.findByLabelText("LAN 访问令牌"), {
      target: { value: token },
    });
    fireEvent.click(screen.getByRole("button", { name: "开启 LAN 访问" }));
    await waitFor(() => expect(authApi.login).toHaveBeenCalledWith(token));
    const input = screen.getByDisplayValue(baseConfig.cacheDir);
    fireEvent.change(input, { target: { value: "/save/after-login" } });
    fireEvent.blur(input);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(configApi.update).toHaveBeenCalledOnce();
    await act(async () => {
      login.resolve({ authenticated: true, mode: "lan" });
    });
    await waitFor(() => expect(configApi.update).toHaveBeenCalledTimes(2));
    expect(configApi.update).toHaveBeenLastCalledWith({
      cacheDir: "/save/after-login",
    });
  });

  it("重复保存同一字段后，已保存提示完整保留 1.5 秒", async () => {
    vi.mocked(configApi.update).mockImplementation(async (patch) => ({
      ok: true,
      config: { ...baseConfig, ...patch },
      requiresRestart: [],
      mediaRootsChanged: false,
    }));
    const { unmount, queryClient } = renderPanel();
    const toggle = await screen.findByRole("switch", { name: "跳过隐藏目录" });
    vi.useFakeTimers();
    try {
      fireEvent.click(toggle);
      await act(() => vi.advanceTimersByTimeAsync(600));
      expect(screen.getByLabelText("已保存")).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(100));
      fireEvent.click(toggle);
      await act(() => vi.advanceTimersByTimeAsync(600));
      expect(configApi.update).toHaveBeenCalledTimes(2);
      expect(screen.getByLabelText("已保存")).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(1499));
      expect(screen.getByLabelText("已保存")).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(screen.queryByLabelText("已保存")).not.toBeInTheDocument();
    } finally {
      unmount();
      queryClient.clear();
      vi.useRealTimers();
    }
  });

  it("离开设置面板时取消待清除的保存提示", async () => {
    const { unmount, queryClient } = renderPanel();
    const toggle = await screen.findByRole("switch", { name: "跳过隐藏目录" });
    vi.useFakeTimers();
    try {
      fireEvent.click(toggle);
      await act(() => vi.advanceTimersByTimeAsync(600));
      expect(screen.getByLabelText("已保存")).toBeInTheDocument();
      unmount();
      queryClient.clear();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      unmount();
      queryClient.clear();
      vi.useRealTimers();
    }
  });

  it("保存响应在离开后返回时更新共享配置，不再创建页面定时器", async () => {
    let finish!: (
      response: Awaited<ReturnType<typeof configApi.update>>,
    ) => void;
    vi.mocked(configApi.update).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { unmount, queryClient } = renderPanel();
    const toggle = await screen.findByRole("switch", { name: "跳过隐藏目录" });
    vi.useFakeTimers();
    try {
      fireEvent.click(toggle);
      await act(() => vi.advanceTimersByTimeAsync(600));
      expect(configApi.update).toHaveBeenCalledWith({ skipHidden: false });
      unmount();
      await act(async () => {
        finish({
          ok: true,
          config: { ...baseConfig, skipHidden: false },
          requiresRestart: [],
          mediaRootsChanged: false,
        });
      });
      expect(queryClient.getQueryData(["server-config"])).toMatchObject({
        skipHidden: false,
      });
      queryClient.clear();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      unmount();
      queryClient.clear();
      vi.useRealTimers();
    }
  });

  // 回归:之前 `draft.systemFiles ?? data.systemFiles` 在 data.systemFiles
  // 自身是 null (后端没显式设过该字段时返回 null) 时,直接把 null 传给了
  // listToLines,导致 .join('\n') 在 null 上炸,整个 Settings 页空白。
  it("排除模式/系统白名单/mediaRoots 为 null 时也能正常渲染", async () => {
    vi.mocked(configApi.get).mockResolvedValueOnce({
      ...baseConfig,
      systemFiles: null as unknown as string[],
      excludePatterns: null as unknown as string[],
      mediaRoots: null as unknown as MediaRootConfig[],
    });
    expect(() => renderPanel()).not.toThrow();
    await waitFor(() => {
      expect(screen.getByText("排除模式")).toBeTruthy();
      expect(screen.getByText("额外的系统白名单")).toBeTruthy();
    });
  });
});

// sort menu 的 'viewed' 选项出现(用 store 直接改 sortBy 验证)
describe("ListFilterBar - sort menu", () => {
  beforeEach(() => {
    useSearchStore.setState({
      sortBy: "name",
      query: "",
      view: "all",
      yearFilter: null,
    });
  });
  it("包含「按最近看」选项", async () => {
    render(<ListFilterBar totalCount={10} />);
    // 打开 sort menu
    const sortBtn = screen.getByRole("button", { name: /排序/ });
    fireEvent.click(sortBtn);
    await waitFor(() => {
      expect(screen.getByText("按最近看")).toBeInTheDocument();
    });
  });
});
