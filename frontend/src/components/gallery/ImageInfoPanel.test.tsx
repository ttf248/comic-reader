import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import ImageInfoPanel from "./ImageInfoPanel";
import { imageInfoApi, type ImageInfo } from "../../api/imageInfo";
import { ApiError } from "../../api/client";

vi.mock("../../api/imageInfo", () => ({
  imageInfoApi: { get: vi.fn() },
}));

const sampleInfo: ImageInfo = {
  name: "a.png",
  path: "f_1",
  dir: "存照",
  size: 1024,
  mtime: "2024-01-01T00:00:00Z",
  width: 100,
  height: 200,
  format: "png",
  checksum: "abc",
};

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

  // 面板跟着阅读器的深色画布走，不跟随应用主题：主题色会让浅色主题下
  // 出现"黑底阅读器里嵌一块白板"。
  it("面板使用阅读器的深色底，不跟随应用主题", () => {
    vi.mocked(imageInfoApi.get).mockResolvedValue(sampleInfo);
    render(<ImageInfoPanel absPath="f_1" onClose={() => {}} />);

    const panel = screen.getByTestId("image-info-panel");
    expect(panel.className).toContain("bg-neutral-900/95");
    expect(panel.className).not.toContain("glass");
    expect(panel.className).not.toContain("border-border-faint");
  });

  it("关闭按钮有可访问名，点击后回调关闭", () => {
    const onClose = vi.fn();
    vi.mocked(imageInfoApi.get).mockResolvedValue(sampleInfo);
    render(<ImageInfoPanel absPath="f_1" onClose={onClose} />);

    const close = screen.getByRole("button", { name: "关闭图片信息" });
    close.click();
    expect(onClose).toHaveBeenCalled();
  });
});
