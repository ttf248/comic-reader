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
