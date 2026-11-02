import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import ImageInfoPanel from "./ImageInfoPanel";
import { imageInfoApi } from "../../api/imageInfo";
import { ApiError } from "../../api/client";

vi.mock("../../api/imageInfo", () => ({
  imageInfoApi: { get: vi.fn() },
}));

describe("ImageInfoPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("读取失败时显示中文提示，而不是后端英文原文", async () => {
    vi.mocked(imageInfoApi.get).mockRejectedValue(
      new ApiError(
        400,
        "resource type does not support this operation",
        undefined,
        "invalid_resource_kind",
      ),
    );
    render(<ImageInfoPanel absPath="f_1" onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/该目录不是相册/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/does not support/)).not.toBeInTheDocument();
  });

  it("未知错误码显示兜底文案", async () => {
    vi.mocked(imageInfoApi.get).mockRejectedValue(
      new ApiError(500, "boom", undefined, "weird_code"),
    );
    render(<ImageInfoPanel absPath="f_1" onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/无法读取图片信息/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
  });
});
