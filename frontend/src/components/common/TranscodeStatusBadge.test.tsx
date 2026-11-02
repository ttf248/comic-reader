import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import TranscodeStatusBadge from "./TranscodeStatusBadge";
import { getTranscodeStatus } from "../../api/videos";

vi.mock("../../api/videos", () => ({
  getTranscodeStatus: vi.fn(),
}));

const mockedStatus = vi.mocked(getTranscodeStatus);

describe("TranscodeStatusBadge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("转码失败时显示红色角标", async () => {
    mockedStatus.mockResolvedValue({
      status: "failed",
      progress: 0,
      etaSec: 0,
      error: "ffmpeg failed",
    });

    render(<TranscodeStatusBadge videoPath="f_1" />);

    await waitFor(() => {
      expect(screen.getByText("转码失败")).toBeInTheDocument();
    });
  });

  it("待转码（任务还没开始）时不显示角标", async () => {
    mockedStatus.mockResolvedValue({
      status: "pending",
      progress: 0,
      etaSec: 0,
    });

    render(<TranscodeStatusBadge videoPath="f_1" />);

    await waitFor(() => {
      expect(mockedStatus).toHaveBeenCalled();
    });
    expect(screen.queryByText("转码失败")).not.toBeInTheDocument();
    expect(screen.queryByText("转码中")).not.toBeInTheDocument();
  });

  it("终态后不再继续轮询", async () => {
    mockedStatus.mockResolvedValue({
      status: "not_needed",
      progress: 1,
      etaSec: 0,
    });

    render(<TranscodeStatusBadge videoPath="f_1" pollIntervalMs={10} />);

    await waitFor(() => {
      expect(mockedStatus).toHaveBeenCalledTimes(1);
    });
    // 角标不会再变化，继续轮询只是后台噪音。
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(mockedStatus).toHaveBeenCalledTimes(1);
  });

  it("转码中继续轮询进度", async () => {
    mockedStatus.mockResolvedValue({
      status: "running",
      progress: 0.4,
      etaSec: 10,
    });

    render(<TranscodeStatusBadge videoPath="f_1" pollIntervalMs={10} />);

    await waitFor(() => {
      expect(mockedStatus.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it("转码中显示进度角标", async () => {
    mockedStatus.mockResolvedValue({
      status: "running",
      progress: 0.4,
      etaSec: 10,
    });

    render(<TranscodeStatusBadge videoPath="f_1" />);

    await waitFor(() => {
      expect(screen.getByText("转码中")).toBeInTheDocument();
    });
  });
});
