import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { cacheApi, type CacheStats } from "../../api/cache";
import {
  storageApi,
  type StorageAbsolutePaths,
  type StorageUsage,
} from "../../api/storage";
import StorageSection from "./StorageSection";

vi.mock("../../api/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/cache")>();
  return { ...actual, cacheApi: { stats: vi.fn(), clearCache: vi.fn() } };
});

vi.mock("../../api/storage", () => ({
  storageApi: { usage: vi.fn(), paths: vi.fn(), jobOutput: vi.fn() },
}));

const usage: StorageUsage = {
  scannedAt: "2026-11-12T02:03:04Z",
  durationMs: 12,
  available: true,
  cacheTtlSeconds: 25,
  summary: {
    modelBytes: 1024,
    modelFileCount: 2,
    outputBytes: 2048,
    outputFileCount: 3,
  },
  modules: [
    {
      type: "metadata",
      name: "照片元数据",
      modelDirectory: "",
      modelLocation: "none",
      modelFiles: [],
      modelBytes: 0,
      outputBytes: 512,
      outputFileCount: 1,
      outputs: [
        {
          kind: "batches",
          label: "批次结果",
          path: "derived/metadata/metadata",
          bytes: 512,
          fileCount: 1,
          available: true,
        },
      ],
    },
    {
      type: "embedding",
      name: "向量索引",
      modelDirectory: "derived/ai/models",
      modelLocation: "cache",
      modelFiles: [
        {
          name: "clip_cn_vit-b-16.pt",
          path: "derived/ai/models/clip_cn_vit-b-16.pt",
          location: "cache",
          sizeBytes: 1024,
          exists: true,
        },
      ],
      modelBytes: 1024,
      outputBytes: 512,
      outputFileCount: 1,
      outputs: [
        {
          kind: "batches",
          label: "批次结果",
          path: "derived/metadata/embedding",
          bytes: 512,
          fileCount: 1,
          available: true,
        },
        {
          kind: "vectors",
          label: "向量索引",
          path: "derived/ai/vectors",
          bytes: 0,
          fileCount: 0,
          available: false,
        },
      ],
    },
    {
      type: "ocr",
      name: "文字识别",
      modelDirectory: "Lib/site-packages/rapidocr/models",
      modelLocation: "python",
      modelFiles: [
        {
          name: "detector.onnx",
          path: "Lib/site-packages/rapidocr/models/detector.onnx",
          location: "python",
          sizeBytes: 512,
          exists: true,
        },
      ],
      modelBytes: 512,
      outputBytes: 1024,
      outputFileCount: 2,
      outputs: [
        {
          kind: "batches",
          label: "批次结果",
          path: "derived/metadata/ocr",
          bytes: 512,
          fileCount: 1,
          available: true,
        },
        {
          kind: "index",
          label: "搜索索引",
          path: "derived/ai/ocr-search-index.json",
          bytes: 512,
          fileCount: 1,
          available: true,
        },
      ],
    },
    {
      type: "face",
      name: "人脸识别",
      modelDirectory: "derived/ai/models/face",
      modelLocation: "cache",
      modelFiles: [],
      modelBytes: 0,
      outputBytes: 0,
      outputFileCount: 0,
      outputs: [
        {
          kind: "batches",
          label: "批次结果",
          path: "derived/metadata/face",
          bytes: 0,
          fileCount: 0,
          available: false,
        },
      ],
    },
  ],
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

const absolutePaths: StorageAbsolutePaths = {
  workingDirectory: "F:\\gallery",
  configFile: "F:\\gallery\\backend\\config.yaml",
  cacheRoot: "F:\\gallery\\.local-gallery",
  stateDirectory: "F:\\gallery\\.local-gallery\\state",
  jobsFile: "F:\\gallery\\.local-gallery\\state\\ai_jobs.json",
  pythonEnvironment: "F:\\gallery\\backend\\aiworker\\.venv",
  pythonExecutable: "F:\\gallery\\backend\\aiworker\\.venv\\Scripts\\python.exe",
  modules: [
    {
      type: "embedding",
      name: "向量索引",
      modelDirectory: "F:\\gallery\\.local-gallery\\derived\\ai\\models",
      modelFiles: [
        {
          name: "clip_cn_vit-b-16.pt",
          path: "F:\\gallery\\.local-gallery\\derived\\ai\\models\\clip_cn_vit-b-16.pt",
          sizeBytes: 1024,
          exists: true,
        },
      ],
    },
  ],
};

const emptySub = { path: "", bytes: 0, fileCount: 0, available: false };

function cacheStats(): CacheStats {
  return {
    path: "cache",
    totalBytes: 9000,
    fileCount: 9,
    scannedAt: "2026-11-12T02:03:04Z",
    durationMs: 5,
    available: true,
    cacheTtlSeconds: 30,
    thumbs: { path: "thumbs", bytes: 1000, fileCount: 2, available: true },
    converted: { path: "converted", bytes: 3000, fileCount: 1, available: true },
    previews: emptySub,
    videoFaststart: emptySub,
    videoTranscode: emptySub,
    mediaBytes: 4000,
    mediaFileCount: 3,
  };
}

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <StorageSection />
    </QueryClientProvider>,
  );
}

describe("本机存储", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(storageApi.usage).mockResolvedValue({ ok: true, usage });
    vi.mocked(storageApi.paths).mockResolvedValue({
      ok: true,
      paths: absolutePaths,
    });
    vi.mocked(cacheApi.stats).mockResolvedValue(cacheStats());
  });

  it("汇总数字给出合计、媒体缓存、分析产物与模型权重", async () => {
    renderSection();

    expect(await screen.findByText("合计")).toBeInTheDocument();
    // 4000（媒体）+ 2048（分析产物）+ 1024（模型）= 7072 字节。
    expect(screen.getByText("6.9 KB")).toBeInTheDocument();
    expect(screen.getByText("AI 分析产物")).toBeInTheDocument();
    expect(screen.getByText("AI 模型权重")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "媒体派生缓存" }),
    ).toBeInTheDocument();
  });

  it("每个模块列出模型文件与产物目录，路径相对缓存根", async () => {
    renderSection();

    expect(
      await screen.findByText("derived/ai/models/clip_cn_vit-b-16.pt"),
    ).toBeInTheDocument();
    expect(screen.getByText("derived/metadata/ocr")).toBeInTheDocument();
    expect(screen.getByText("derived/ai/ocr-search-index.json")).toBeInTheDocument();
    expect(screen.getByText("state/ai_jobs.json")).toBeInTheDocument();
  });

  it("OCR 权重标注在 Python 环境内，元数据模块说明无需权重", async () => {
    renderSection();

    expect(
      await screen.findByText("位于 Python 环境内，路径相对该环境"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("使用 Go 内置 EXIF/GPS 解析器，无需额外模型文件。"),
    ).toBeInTheDocument();
  });

  it("派生缓存按类型细分列出并能单独清理", async () => {
    vi.mocked(cacheApi.clearCache).mockResolvedValue({
      scope: "thumbs",
      thumbs: { deleted: 2, freedBytes: 1000 },
      totalDeleted: 2,
      totalFreedBytes: 1000,
    });
    renderSection();

    // 等占用统计到位，徽章才会给出「清空」入口。
    expect(await screen.findByText(/3\.9 KB · 3 个文件/)).toBeInTheDocument();
    // 「缩略图」在重建范围勾选项里也有一份，这里认的是占用徽章。
    expect(
      screen.getByText("缩略图", { selector: "span.text-fg-muted.text-meta" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("转换图", { selector: "span.text-fg-muted.text-meta" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "清空 缩略图 缓存" }));
    await waitFor(() =>
      expect(cacheApi.clearCache).toHaveBeenCalledWith("thumbs"),
    );
  });

  it("本机绝对路径在回环浏览器里显示", async () => {
    renderSection();

    expect(
      await screen.findByText("F:\\gallery\\.local-gallery"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("F:\\gallery\\backend\\aiworker\\.venv\\Scripts\\python.exe"),
    ).toBeInTheDocument();
  });

  // 局域网客户端拿绝对路径会得到 403。那是预期结果，不是故障。
  it("绝对路径不可读时给中性说明，不报红色错误", async () => {
    vi.mocked(storageApi.paths).mockRejectedValue(
      new ApiError(403, "local-only", undefined, "local_access_required"),
    );
    renderSection();

    expect(
      await screen.findByText(
        "完整路径只在运行服务的计算机上显示；此处列出的是相对缓存根目录的路径。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    // 相对路径照常显示，不因为绝对路径不可见而缺内容。
    expect(screen.getByText("state/ai_jobs.json")).toBeInTheDocument();
  });
});
