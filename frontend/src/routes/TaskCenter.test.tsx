import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TaskCenter from "./TaskCenter";
import { aiJobsApi, type AIJob, type AIJobSnapshot } from "../api/aiJobs";

vi.mock("../api/aiJobs", () => ({
  aiJobsApi: {
    list: vi.fn(),
    start: vi.fn(),
    action: vi.fn(),
    settings: vi.fn(),
    updateSettings: vi.fn(),
    metadata: vi.fn(),
    embeddingStatus: vi.fn(),
  },
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, sse: vi.fn(() => () => {}) };
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
    settings: {
      dailyEnabled: false,
      dailyTime: "03:00",
      dailyModules: ["metadata"],
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

describe("任务中心", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: snapshot(),
    });
    vi.mocked(aiJobsApi.start).mockResolvedValue({
      ok: true,
      job: currentJob,
      reused: false,
    });
    vi.mocked(aiJobsApi.action).mockResolvedValue({ ok: true });
    vi.mocked(aiJobsApi.updateSettings).mockResolvedValue({
      ok: true,
      settings: {
        dailyEnabled: true,
        dailyTime: "04:15",
        dailyModules: ["metadata"],
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
  });

  it("按编号区块呈现状态、每日计划与任务记录", async () => {
    renderCenter();

    expect(await screen.findByText("状态")).toBeInTheDocument();
    expect(screen.getByText("每日计划")).toBeInTheDocument();
    expect(screen.getByText("任务记录")).toBeInTheDocument();
    expect(screen.getByText("01")).toBeInTheDocument();
    expect(screen.getByText("02")).toBeInTheDocument();
    expect(screen.getByText("03")).toBeInTheDocument();
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

  it("失败项展开后给出可复制的路径", async () => {
    const failedJob: AIJob = {
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
});
