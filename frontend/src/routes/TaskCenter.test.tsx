import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  act,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskCenter from "./TaskCenter";
import { aiJobsApi, type AIJob, type AIJobSnapshot } from "../api/aiJobs";
import { cacheApi } from "../api/cache";
import {
  storageApi,
  type StorageAbsolutePaths,
  type StorageUsage,
} from "../api/storage";

vi.mock("../api/aiJobs", () => ({
  aiJobsApi: {
    list: vi.fn(),
    start: vi.fn(),
    startAll: vi.fn(),
    action: vi.fn(),
    moveQueued: vi.fn(),
    clearQueue: vi.fn(),
    deleteHistoryItem: vi.fn(),
    clearHistory: vi.fn(),
    settings: vi.fn(),
    updateSettings: vi.fn(),
    metadata: vi.fn(),
    embeddingStatus: vi.fn(),
  },
}));

vi.mock("../api/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/cache")>();
  return { ...actual, cacheApi: { stats: vi.fn(), clearCache: vi.fn() } };
});

vi.mock("../api/storage", () => ({
  storageApi: { usage: vi.fn(), paths: vi.fn(), jobOutput: vi.fn() },
}));

const sseHarness = vi.hoisted(() => ({
  onEvent: null as null | ((eventName: string, value: unknown) => void),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    sse: vi.fn(
      (_path: string, onEvent: (eventName: string, value: unknown) => void) => {
        sseHarness.onEvent = onEvent;
        return () => {};
      },
    ),
  };
});

const currentJob: AIJob = {
  id: "job-current",
  type: "metadata",
  mode: "incremental",
  status: "running",
  stage: "metadata",
  moduleVersion: "metadata-v1",
  total: 100,
  processed: 42,
  skipped: 55,
  failed: 1,
  done: 98,
  planned: 45,
  completed: 43,
  estimatedRemainingMs: 12_000,
  speedPerSecond: 1.6,
  results: { parsed: 42, failed: 1 },
  fields: { exifTime: 40, camera: 12 },
  checkpoint: { offset: 98, batch: 3, moduleVersion: "metadata-v1" },
  createdAt: "2026-11-11T02:00:00Z",
  startedAt: "2026-11-11T02:00:01Z",
  updatedAt: "2026-11-11T02:01:00Z",
  elapsedMs: 60_000,
  errors: [
    {
      resourceId: "f_bad",
      code: "analysis_failed",
      message: "EXIF 数据损坏或无法解析",
      at: "2026-11-11T02:01:00Z",
    },
  ],
};

const modules = [
  {
    type: "metadata",
    name: "照片元数据",
    installed: true,
    version: "metadata-v1",
  },
  { type: "embedding", name: "向量索引", installed: false },
] as AIJobSnapshot["modules"];

function snapshot(overrides: Partial<AIJobSnapshot> = {}): AIJobSnapshot {
  return {
    jobs: [currentJob],
    active: currentJob,
    queue: [],
    settings: {
      dailyEnabled: false,
      dailyTime: "03:00",
      dailyModules: ["metadata"],
      peopleEnabled: false,
    },
    modules,
    ...overrides,
  };
}

function renderCenter() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TaskCenter />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const emptySubUsage = {
  path: "",
  bytes: 0,
  fileCount: 0,
  available: false,
};

const emptyUsage: StorageUsage = {
  scannedAt: "",
  durationMs: 0,
  available: true,
  cacheTtlSeconds: 0,
  summary: {
    modelBytes: 0,
    modelFileCount: 0,
    outputBytes: 0,
    outputFileCount: 0,
  },
  modules: [],
  paths: {
    relativeTo: "cacheRoot",
    stateDirectory: "state",
    jobsFile: "state/ai_jobs.json",
    metadataDirectory: "derived/metadata",
    aiDerivedDirectory: "derived/ai",
    vectorDirectory: "derived/ai/vectors",
    modelDirectory: "derived/ai/models",
  },
};

const emptyAbsolutePaths: StorageAbsolutePaths = {
  workingDirectory: "",
  configFile: "",
  cacheRoot: "",
  stateDirectory: "",
  jobsFile: "",
  pythonEnvironment: "",
  pythonExecutable: "",
  modules: [],
};

describe("任务中心", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    sseHarness.onEvent = null;
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: snapshot(),
    });
    vi.mocked(aiJobsApi.start).mockResolvedValue({
      ok: true,
      job: currentJob,
      reused: false,
    });
    vi.mocked(aiJobsApi.startAll).mockResolvedValue({
      ok: true,
      jobs: [],
      skippedModules: [
        {
          type: "face",
          name: "人脸识别",
          installed: false,
          reason: "face_model_missing_or_checksum_invalid",
        },
      ],
    });
    vi.mocked(aiJobsApi.action).mockResolvedValue({ ok: true });
    vi.mocked(aiJobsApi.moveQueued).mockResolvedValue({
      ok: true,
      snapshot: snapshot(),
    });
    vi.mocked(aiJobsApi.clearQueue).mockResolvedValue({
      ok: true,
      cancelledCount: 0,
      snapshot: snapshot(),
    });
    vi.mocked(aiJobsApi.deleteHistoryItem).mockResolvedValue({ ok: true });
    vi.mocked(aiJobsApi.clearHistory).mockResolvedValue({
      ok: true,
      deletedCount: 0,
      snapshot: snapshot(),
    });
    vi.mocked(aiJobsApi.updateSettings).mockResolvedValue({
      ok: true,
      settings: {
        dailyEnabled: true,
        dailyTime: "04:15",
        dailyModules: ["metadata"],
        peopleEnabled: false,
      },
    });
    vi.mocked(aiJobsApi.embeddingStatus).mockResolvedValue({
      ok: true,
      status: {
        pythonAvailable: true,
        pythonVersion: "3.11.9",
        torchVersion: "2.7.1",
        cudaAvailable: true,
        cudaVersion: "12.6",
        gpuName: "NVIDIA GeForce RTX 3060",
        device: "cuda",
        runtimeReady: true,
        modelAvailable: true,
        modelValid: true,
        modelLoaded: true,
        modelVersion: "clip-v1",
        index: {
          modelVersion: "clip-v1",
          dimension: 512,
          vectors: 100,
          shards: 4,
          indexVersion: 1,
          ready: true,
        },
        coverage: { indexed: 100, total: 100 },
      },
    });
    vi.mocked(cacheApi.stats).mockResolvedValue({
      path: "cache",
      totalBytes: 0,
      fileCount: 0,
      scannedAt: "",
      durationMs: 0,
      available: false,
      cacheTtlSeconds: 0,
      thumbs: emptySubUsage,
      converted: emptySubUsage,
      previews: emptySubUsage,
      videoFaststart: emptySubUsage,
      videoTranscode: emptySubUsage,
      mediaBytes: 0,
      mediaFileCount: 0,
    });
    vi.mocked(storageApi.usage).mockResolvedValue({ ok: true, usage: emptyUsage });
    vi.mocked(storageApi.paths).mockResolvedValue({
      ok: true,
      paths: emptyAbsolutePaths,
    });
    vi.mocked(storageApi.jobOutput).mockResolvedValue({
      ok: true,
      output: {
        jobId: "job-completed",
        type: "metadata",
        batchSize: 32,
        path: "derived/metadata/metadata/batches/job-completed",
        bytes: 2048,
        fileCount: 2,
        available: true,
        scannedAt: "2026-11-11T02:05:00Z",
      },
    });
  });

  it("按编号区块呈现状态、等待队列、每日计划、任务记录与本机存储", async () => {
    renderCenter();

    expect(await screen.findByText("状态")).toBeInTheDocument();
    expect(screen.getByText("等待队列")).toBeInTheDocument();
    expect(screen.getByText("每日计划")).toBeInTheDocument();
    expect(screen.getByText("任务记录")).toBeInTheDocument();
    expect(screen.getByText("本机存储")).toBeInTheDocument();
    expect(screen.getByText("01")).toBeInTheDocument();
    expect(screen.getByText("02")).toBeInTheDocument();
    expect(screen.getByText("03")).toBeInTheDocument();
    expect(screen.getByText("04")).toBeInTheDocument();
    expect(screen.getByText("05")).toBeInTheDocument();
  });

  it("运行中显示阶段、进度口径、速度与预计剩余，并支持暂停", async () => {
    renderCenter();

    expect(await screen.findByText("读取照片元数据")).toBeInTheDocument();
    // 百分比按本次待处理量算：43 / 45。
    expect(screen.getByText("96%")).toBeInTheDocument();
    expect(screen.getByText("43 / 45 张")).toBeInTheDocument();
    expect(screen.getByText("1.6 张/秒")).toBeInTheDocument();
    expect(screen.getByText("12 秒")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() =>
      expect(aiJobsApi.action).toHaveBeenCalledWith("job-current", "pause"),
    );
  });

  it("空闲时给出开始分析的入口与模块清单", async () => {
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: snapshot({ jobs: [], active: undefined }),
    });
    renderCenter();

    expect(await screen.findByText("队列空闲")).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "照片元数据" }),
    ).toBeInTheDocument();
    expect(screen.getByText("未安装")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "全量分析" }));
    await waitFor(() =>
      expect(aiJobsApi.start).toHaveBeenCalledWith("metadata", "full"),
    );
  });

  it("只有等待任务而无活动任务时不显示空闲启动入口", async () => {
    const pendingJob: AIJob = {
      ...currentJob,
      id: "job-pending",
      status: "pending",
      stage: "pending",
    };
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: snapshot({
        jobs: [pendingJob],
        active: undefined,
        queue: [pendingJob.id],
      }),
    });
    renderCenter();

    expect(await screen.findByText("等待队列待启动")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "全量分析" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByTestId("task-queue-row")).toHaveLength(1);
  });

  it("按所选模式一键排入全部模块，并提供服务端设置入口", async () => {
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: snapshot({ jobs: [], active: undefined }),
    });
    renderCenter();

    await screen.findByText("队列空闲");
    expect(
      screen.getByRole("link", { name: "服务设置" }),
    ).toHaveAttribute("href", "/settings");
    fireEvent.change(screen.getByRole("combobox", { name: "全部任务模式" }), {
      target: { value: "full" },
    });
    fireEvent.click(screen.getByRole("button", { name: "按序启动全部任务" }));
    await waitFor(() =>
      expect(aiJobsApi.startAll).toHaveBeenCalledWith("full"),
    );
    expect(
      await screen.findByText(/已跳过未就绪模块：人脸识别/),
    ).toBeInTheDocument();
  });

  it("当前任务结束后刷新快照并显示队列中的下一项", async () => {
    const nextJob: AIJob = {
      ...currentJob,
      id: "job-next",
      type: "embedding",
      mode: "incremental",
      status: "running",
      stage: "embedding",
      currentResourceId: undefined,
    };
    let reads = 0;
    vi.mocked(aiJobsApi.list).mockImplementation(async () => {
      reads += 1;
      return {
        ok: true,
        snapshot:
          reads === 1
            ? snapshot()
            : snapshot({ jobs: [nextJob, currentJob], active: nextJob }),
      };
    });
    renderCenter();

    await screen.findByText("读取照片元数据");
    const completedJob = { ...currentJob, status: "completed" as const };
    act(() => sseHarness.onEvent?.("completed", completedJob));
    expect(await screen.findByText("运行中 · 向量索引")).toBeInTheDocument();
    await waitFor(() => expect(aiJobsApi.list).toHaveBeenCalledTimes(2));
  });

  it("等待队列按服务端顺序展示并提供调整与取消操作", async () => {
    const queuedOCR: AIJob = {
      ...currentJob,
      id: "job-ocr",
      type: "ocr",
      status: "pending",
      stage: "pending",
    };
    const queuedFace: AIJob = {
      ...queuedOCR,
      id: "job-face",
      type: "face",
    };
    const previous: AIJob = {
      ...currentJob,
      id: "job-previous",
      status: "completed",
      createdAt: "2026-11-11T03:00:00Z",
    };
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: snapshot({
        jobs: [queuedFace, queuedOCR, currentJob, previous],
        active: currentJob,
        queue: [queuedOCR.id, queuedFace.id],
      }),
    });
    renderCenter();

    const rows = await screen.findAllByTestId("task-queue-row");
    expect(rows[0].textContent).toContain("文字识别");
    expect(rows[1].textContent).toContain("人脸识别");
    expect(screen.getAllByTestId("task-history-row")).toHaveLength(1);
    fireEvent.click(
      within(rows[1]).getByRole("button", { name: "上移 手动 人脸识别" }),
    );
    await waitFor(() =>
      expect(aiJobsApi.moveQueued).toHaveBeenCalledWith(queuedFace.id, "up"),
    );
    fireEvent.click(
      within(rows[0]).getByRole("button", { name: "取消排队 手动 文字识别" }),
    );
    await waitFor(() =>
      expect(aiJobsApi.action).toHaveBeenCalledWith(queuedOCR.id, "cancel"),
    );
  });

  it("清空等待队列前提示当前任务会继续执行", async () => {
    const queued: AIJob = {
      ...currentJob,
      id: "job-queued",
      type: "ocr",
      status: "pending",
      stage: "pending",
    };
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: snapshot({
        jobs: [queued, currentJob],
        active: currentJob,
        queue: [queued.id],
      }),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderCenter();

    fireEvent.click(
      await screen.findByRole("button", { name: "清空等待队列" }),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("当前任务不会受影响"),
    );
    await waitFor(() => expect(aiJobsApi.clearQueue).toHaveBeenCalled());
  });

  it("可按状态筛选历史并删除单条任务记录", async () => {
    const failedJob: AIJob = {
      ...currentJob,
      id: "job-failed",
      status: "failed",
      finishedAt: "2026-11-11T02:03:00Z",
    };
    const completedJob: AIJob = {
      ...currentJob,
      id: "job-completed",
      status: "completed",
      finishedAt: "2026-11-11T02:02:00Z",
    };
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: snapshot({
        jobs: [failedJob, completedJob],
        active: undefined,
      }),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderCenter();

    fireEvent.click(await screen.findByRole("button", { name: "失败 1" }));
    const rows = await screen.findAllByTestId("task-history-row");
    expect(rows).toHaveLength(1);
    fireEvent.click(within(rows[0]).getByText("手动 元数据分析"));
    fireEvent.click(
      await within(rows[0]).findByRole("button", {
        name: "删除任务记录",
      }),
    );
    await waitFor(() =>
      expect(aiJobsApi.deleteHistoryItem).toHaveBeenCalledWith(failedJob.id),
    );
  });

  it("已取消任务可重新运行未完成部分", async () => {
    const cancelledJob: AIJob = {
      ...currentJob,
      id: "job-cancelled",
      status: "cancelled",
      finishedAt: "2026-11-11T02:03:00Z",
    };
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: snapshot({ jobs: [cancelledJob], active: undefined }),
    });
    renderCenter();

    const row = (await screen.findAllByTestId("task-history-row"))[0];
    fireEvent.click(within(row).getByText("手动 元数据分析"));
    fireEvent.click(
      await within(row).findByRole("button", { name: "重新运行未完成项" }),
    );
    await waitFor(() =>
      expect(aiJobsApi.action).toHaveBeenCalledWith(cancelledJob.id, "retry"),
    );
  });

  it("清理历史前提示结果不会删除", async () => {
    const completedJob: AIJob = {
      ...currentJob,
      id: "job-completed",
      status: "completed",
      finishedAt: "2026-11-11T02:02:00Z",
    };
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: snapshot({ jobs: [completedJob], active: undefined }),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderCenter();

    fireEvent.click(
      await screen.findByRole("button", { name: "清理已结束记录" }),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("分析结果和索引数据会保留"),
    );
    await waitFor(() => expect(aiJobsApi.clearHistory).toHaveBeenCalled());
  });

  it("已安装向量模块时可从同一任务服务启动全量建索引", async () => {
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: snapshot({
        jobs: [],
        active: undefined,
        modules: [
          modules[0],
          { ...modules[1], installed: true, version: "clip-v1" },
        ],
      }),
    });
    renderCenter();

    await screen.findByText("队列空闲");
    fireEvent.change(screen.getByRole("combobox", { name: "分析模块" }), {
      target: { value: "embedding" },
    });
    fireEvent.click(screen.getByRole("button", { name: "全量生成向量" }));
    await waitFor(() =>
      expect(aiJobsApi.start).toHaveBeenCalledWith("embedding", "full"),
    );
  });

  it("已安装 OCR 与人脸模块时显示对应任务入口", async () => {
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: snapshot({
        jobs: [],
        active: undefined,
        settings: {
          dailyEnabled: false,
          dailyTime: "03:00",
          dailyModules: ["metadata"],
          peopleEnabled: true,
        },
        modules: [
          modules[0],
          {
            type: "ocr",
            name: "文字识别",
            installed: true,
            version: "rapidocr-v1",
          },
          {
            type: "face",
            name: "人脸识别",
            installed: true,
            version: "sface-v1",
          },
        ],
      }),
    });
    vi.mocked(aiJobsApi.embeddingStatus).mockResolvedValue({
      ok: true,
      status: {
        pythonAvailable: true,
        cudaAvailable: false,
        device: "cpu",
        runtimeReady: false,
        modelAvailable: false,
        modelValid: false,
        modelLoaded: false,
        modelVersion: "clip-v1",
        index: {
          modelVersion: "clip-v1",
          dimension: 512,
          vectors: 0,
          shards: 0,
          indexVersion: 1,
          ready: false,
        },
        coverage: { indexed: 0, total: 0 },
        modules: {
          ocr: { ready: true, version: "rapidocr-v1" },
          face: { ready: true, version: "sface-v1" },
        },
      },
    });
    renderCenter();

    await screen.findByText("队列空闲");
    fireEvent.change(screen.getByRole("combobox", { name: "分析模块" }), {
      target: { value: "ocr" },
    });
    expect(await screen.findByText(/OCR 识别照片中的文字/)).toBeInTheDocument();
    expect(
      screen.getByText("文字识别已就绪 · rapidocr-v1"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全量识别文字" })).toBeEnabled();

    fireEvent.change(screen.getByRole("combobox", { name: "分析模块" }), {
      target: { value: "face" },
    });
    expect(
      await screen.findByText(/检测照片中的人脸并生成本机特征向量/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全量识别人脸" })).toBeEnabled();
  });

  it("每日计划用开关与时间输入，保存后写回设置", async () => {
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: snapshot({ jobs: [], active: undefined }),
    });
    renderCenter();

    const toggle = await screen.findByRole("switch", {
      name: "每天自动检查变化",
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText("每日分析开始时间"), {
      target: { value: "04:15" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存计划" }));
    await waitFor(() =>
      expect(aiJobsApi.updateSettings).toHaveBeenCalledWith({
        dailyEnabled: true,
        dailyTime: "04:15",
        dailyModules: ["metadata"],
        peopleEnabled: false,
      }),
    );
  });

  it("每日计划会保存用户选择的已安装分析模块", async () => {
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: snapshot({
        jobs: [],
        active: undefined,
        modules: [
          modules[0],
          { ...modules[1], installed: true, version: "clip-v1" },
        ],
      }),
    });
    renderCenter();

    fireEvent.click(await screen.findByRole("checkbox", { name: "向量索引" }));
    fireEvent.click(screen.getByRole("button", { name: "保存计划" }));
    await waitFor(() =>
      expect(aiJobsApi.updateSettings).toHaveBeenCalledWith({
        dailyEnabled: false,
        dailyTime: "03:00",
        dailyModules: ["metadata", "embedding"],
        peopleEnabled: false,
      }),
    );
  });

  it("人物分析默认关闭，显式启用后才能加入每日计划", async () => {
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: snapshot({
        jobs: [],
        active: undefined,
        modules: [
          ...modules,
          {
            type: "face",
            name: "人脸识别",
            installed: true,
            version: "face-v1",
          },
        ],
      }),
    });
    renderCenter();

    const faceModule = await screen.findByRole("checkbox", {
      name: "人脸识别",
    });
    expect(faceModule).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "启用人物分析（默认关闭）" }),
    );
    expect(faceModule).toBeEnabled();
    fireEvent.click(faceModule);
    fireEvent.click(screen.getByRole("button", { name: "保存计划" }));
    await waitFor(() =>
      expect(aiJobsApi.updateSettings).toHaveBeenCalledWith({
        dailyEnabled: false,
        dailyTime: "03:00",
        dailyModules: ["metadata", "face"],
        peopleEnabled: true,
      }),
    );
  });

  it("任务记录展开后按原因分组显示失败项，并支持只重试失败项", async () => {
    const failedJob: AIJob = {
      ...currentJob,
      id: "job-failed",
      status: "failed",
      errors: [
        ...currentJob.errors!,
        {
          resourceId: "f_bad_2",
          code: "analysis_failed",
          message: "EXIF 数据损坏或无法解析",
          at: "2026-11-11T02:01:00Z",
        },
        {
          resourceId: "f_missing",
          code: "source_unavailable",
          message: "无法读取图片或路径校验失败",
          at: "2026-11-11T02:01:00Z",
        },
      ],
    };
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: snapshot({
        jobs: [failedJob],
        active: undefined,
      }),
    });
    renderCenter();

    fireEvent.click(await screen.findByText("手动 元数据分析"));
    const group = (await screen.findByText("EXIF 数据损坏或无法解析")).closest(
      "details",
    );
    expect(group?.textContent).toContain("· 2 项");
    const other = screen
      .getByText("无法读取图片或路径校验失败")
      .closest("details");
    expect(other?.textContent).toContain("· 1 项");
    expect(screen.getByText("已解析")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "仅重试失败项" }));
    await waitFor(() =>
      expect(aiJobsApi.action).toHaveBeenCalledWith("job-failed", "retry"),
    );
  });

  it("失败项展开后给出可复制的路径", async () => {    const failedJob: AIJob = {
      ...currentJob,
      id: "job-failed",
      status: "failed",
      errors: [
        {
          resourceId: "f_bad",
          code: "analysis_failed",
          message: "EXIF 数据损坏或无法解析",
          at: "2026-11-11T02:01:00Z",
          path: "album/a/IMG_0001.jpg",
        },
      ],
    };
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: snapshot({ jobs: [failedJob], active: undefined }),
    });
    renderCenter();

    fireEvent.click(await screen.findByText("手动 元数据分析"));
    const group = (await screen.findByText("EXIF 数据损坏或无法解析")).closest(
      "details",
    );
    expect(group).not.toBeNull();
    expect(
      within(group as HTMLElement).getByText("album/a/IMG_0001.jpg"),
    ).toBeInTheDocument();
    expect(
      within(group as HTMLElement).getByText("album/a/IMG_0001.jpg"),
    ).toHaveAttribute("title", "album/a/IMG_0001.jpg");
    expect(
      within(group as HTMLElement).getByRole("button", { name: /复制/ }),
    ).toBeInTheDocument();
  });
  // 任务记录展开后才去取这次任务自己的产物占用；折叠的列表不该发请求。
  it("任务记录展开后显示本次产物，折叠时不请求", async () => {
    const completedJob: AIJob = {
      ...currentJob,
      id: "job-completed",
      status: "completed",
      finishedAt: "2026-11-11T02:02:00Z",
    };
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: snapshot({ jobs: [completedJob], active: undefined }),
    });
    renderCenter();

    const row = (await screen.findAllByTestId("task-history-row"))[0];
    // 还没展开：一次请求都不该发。
    expect(storageApi.jobOutput).not.toHaveBeenCalled();

    fireEvent.click(within(row).getByText("手动 元数据分析"));
    expect(
      await screen.findByText("本次产物"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(storageApi.jobOutput).toHaveBeenCalledWith("job-completed"),
    );
    expect(
      screen.getByText(
        "derived/metadata/metadata/batches/job-completed",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 KB · 2 个批次文件/)).toBeInTheDocument();
  });
});
