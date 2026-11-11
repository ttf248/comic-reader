import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TaskCenter from "./TaskCenter";
import { aiJobsApi } from "../api/aiJobs";

vi.mock("../api/aiJobs", () => ({
  aiJobsApi: {
    list: vi.fn(),
    start: vi.fn(),
    action: vi.fn(),
    settings: vi.fn(),
    updateSettings: vi.fn(),
    metadata: vi.fn(),
  },
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, sse: vi.fn(() => () => {}) };
});

const currentJob = {
  id: "job-current",
  type: "metadata" as const,
  mode: "incremental" as const,
  status: "running" as const,
  stage: "metadata",
  moduleVersion: "metadata-v1",
  total: 100,
  processed: 42,
  skipped: 55,
  failed: 1,
  done: 98,
  checkpoint: { offset: 98, batch: 3, moduleVersion: "metadata-v1" },
  createdAt: "2026-11-11T02:00:00Z",
  startedAt: "2026-11-11T02:00:01Z",
  updatedAt: "2026-11-11T02:01:00Z",
  elapsedMs: 60_000,
  speedPerSecond: 1.6,
  errors: [
    {
      resourceId: "f_bad",
      code: "analysis_failed",
      message: "EXIF 数据损坏或无法解析",
      at: "2026-11-11T02:01:00Z",
    },
  ],
};

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
      snapshot: {
        jobs: [currentJob],
        active: currentJob,
        settings: { dailyEnabled: false, dailyTime: "03:00" },
      },
    });
    vi.mocked(aiJobsApi.start).mockResolvedValue({
      ok: true,
      job: currentJob,
      reused: false,
    });
    vi.mocked(aiJobsApi.action).mockResolvedValue({ ok: true });
    vi.mocked(aiJobsApi.updateSettings).mockResolvedValue({
      ok: true,
      settings: { dailyEnabled: true, dailyTime: "04:15" },
    });
  });

  it("显示实时进度、各类计数與速度，并支持暂停", async () => {
    renderCenter();

    expect(await screen.findByText("读取照片元数据")).toBeInTheDocument();
    expect(screen.getByText("42", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("1.6 张/秒")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() =>
      expect(aiJobsApi.action).toHaveBeenCalledWith("job-current", "pause"),
    );
  });

  it("发起全量任务并保存每日计划", async () => {
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: {
        jobs: [],
        settings: { dailyEnabled: false, dailyTime: "03:00" },
      },
    });
    renderCenter();
    fireEvent.click(await screen.findByRole("button", { name: "全量分析" }));
    await waitFor(() =>
      expect(aiJobsApi.start).toHaveBeenCalledWith("metadata", "full"),
    );
    fireEvent.click(screen.getByLabelText("每天自动检查变化"));
    fireEvent.change(screen.getByLabelText("每日分析开始时间"), {
      target: { value: "04:15" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存计划" }));
    await waitFor(() =>
      expect(aiJobsApi.updateSettings).toHaveBeenCalledWith({
        dailyEnabled: true,
        dailyTime: "04:15",
      }),
    );
  });

  it("历史记录展开后显示失败原因并支持只重试失败项", async () => {
    const failedJob = {
      ...currentJob,
      id: "job-failed",
      status: "failed" as const,
    };
    vi.mocked(aiJobsApi.list).mockResolvedValue({
      ok: true,
      snapshot: {
        jobs: [failedJob],
        settings: { dailyEnabled: false, dailyTime: "03:00" },
      },
    });
    renderCenter();

    fireEvent.click(await screen.findByText("手动 元数据分析"));
    expect(
      await screen.findByText(/EXIF 数据损坏或无法解析/),
    ).toBeInTheDocument();
    expect(screen.getByText(/f_bad/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "仅重试失败项" }));
    await waitFor(() =>
      expect(aiJobsApi.action).toHaveBeenCalledWith("job-failed", "retry"),
    );
  });
});
