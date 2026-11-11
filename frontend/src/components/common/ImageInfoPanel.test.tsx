import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render as testingRender,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import ImageInfoPanel from "./ImageInfoPanel";
import { imageInfoApi, type ImageInfo } from "../../api/imageInfo";
import { aiJobsApi } from "../../api/aiJobs";
import { ApiError } from "../../api/client";

vi.mock("../../api/imageInfo", () => ({
  imageInfoApi: { get: vi.fn() },
}));

vi.mock("../../api/aiJobs", () => ({
  aiJobsApi: {
    metadata: vi.fn().mockResolvedValue({ status: "pending" }),
    analysis: vi.fn().mockResolvedValue({
      ok: true,
      resourceId: "f_1",
      ocr: { status: "pending" },
      face: { status: "pending" },
    }),
    faceSearch: vi.fn(),
  },
}));

function render(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return testingRender(ui, {
    wrapper: ({ children }) => (
      <MemoryRouter>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </MemoryRouter>
    ),
  });
}

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
  it("面板使用阅读器的深色底，不跟随应用主题", async () => {
    vi.mocked(imageInfoApi.get).mockResolvedValue(sampleInfo);
    render(<ImageInfoPanel absPath="f_1" onClose={() => {}} />);

    expect(await screen.findByText("a.png")).toBeInTheDocument();

    const panel = screen.getByTestId("image-info-panel");
    expect(panel.className).toContain("bg-overlay-panel");
    expect(panel.className).not.toContain("glass");
    expect(panel.className).not.toContain("border-border-faint");
  });

  it("关闭按钮有可访问名，点击后回调关闭", async () => {
    const onClose = vi.fn();
    vi.mocked(imageInfoApi.get).mockResolvedValue(sampleInfo);
    render(<ImageInfoPanel absPath="f_1" onClose={onClose} />);

    expect(await screen.findByText("a.png")).toBeInTheDocument();
    const close = screen.getByRole("button", { name: "关闭图片信息" });
    close.click();
    expect(onClose).toHaveBeenCalled();
  });

  it("显示已保存的 OCR 文字和人脸识别状态", async () => {
    vi.mocked(imageInfoApi.get).mockResolvedValue(sampleInfo);
    vi.mocked(aiJobsApi.analysis).mockResolvedValue({
      ok: true,
      resourceId: "f_1",
      ocr: { status: "recognized", text: "海边散步", lines: [] },
      face: { status: "no_faces", faces: [] },
    });
    render(<ImageInfoPanel absPath="f_1" onClose={() => {}} />);

    expect(await screen.findByText("海边散步")).toBeInTheDocument();
    expect(screen.getByText("未检测到人脸")).toBeInTheDocument();
  });

  it("可查询相似人脸并展示匹配照片", async () => {
    vi.mocked(imageInfoApi.get).mockResolvedValue(sampleInfo);
    vi.mocked(aiJobsApi.analysis).mockResolvedValue({
      ok: true,
      resourceId: "f_1",
      ocr: { status: "no_text", text: "", lines: [] },
      face: {
        status: "faces_found",
        faces: [{ box: [10, 12, 40, 42], score: 0.9 }],
      },
    });
    vi.mocked(aiJobsApi.faceSearch).mockResolvedValue({
      ok: true,
      threshold: 0.363,
      total: 1,
      results: [
        {
          item: {
            id: "f_2",
            kind: "image",
            name: "聚会.jpg",
            index: 0,
            kindIndex: 0,
            albumId: "album_1",
            albumName: "家庭聚会",
          },
          faceIndex: 0,
          similarity: 0.78,
        },
      ],
    });
    render(<ImageInfoPanel absPath="f_1" onClose={() => {}} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "人脸 1 · 找相似" }),
    );
    expect(await screen.findByText("聚会.jpg")).toBeInTheDocument();
    expect(screen.getByText("78%")).toBeInTheDocument();
    expect(aiJobsApi.faceSearch).toHaveBeenCalledWith("f_1", 0);
  });
});
