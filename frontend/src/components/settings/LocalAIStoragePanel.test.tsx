import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiStorageApi, type AIStorageSnapshot } from "../../api/aiStorage";
import LocalAIStoragePanel from "./LocalAIStoragePanel";

vi.mock("../../api/aiStorage", () => ({
  aiStorageApi: { get: vi.fn() },
}));

const root = "C:\\Gallery\\.local-gallery";
const snapshot: AIStorageSnapshot = {
  paths: {
    workingDirectory: "C:\\Gallery\\backend",
    configFile: "C:\\Gallery\\backend\\config.yaml",
    cacheRoot: root,
    stateDirectory: `${root}\\state`,
    jobsFile: `${root}\\state\\ai_jobs.json`,
    metadataDirectory: `${root}\\derived\\metadata`,
    modelDirectory: `${root}\\derived\\ai\\models`,
    vectorDirectory: `${root}\\derived\\ai\\vectors`,
    pythonEnvironment: "C:\\Gallery\\backend\\aiworker\\.venv",
    pythonExecutable:
      "C:\\Gallery\\backend\\aiworker\\.venv\\Scripts\\python.exe",
  },
  summary: {
    modelBytes: 1_073_741_824,
    metadataBytes: 2_048,
    metadataFileCount: 4,
    vectorBytes: 4096,
    vectorFileCount: 2,
  },
  tasks: [
    {
      type: "metadata",
      name: "照片元数据",
      modelFiles: [],
      modelBytes: 0,
      results: {
        path: `${root}\\derived\\metadata\\metadata`,
        bytes: 512,
        fileCount: 1,
        available: true,
      },
    },
    {
      type: "embedding",
      name: "向量索引",
      modelDirectory: `${root}\\derived\\ai\\models`,
      modelFiles: [
        {
          name: "clip_cn_vit-b-16.pt",
          path: `${root}\\derived\\ai\\models\\clip_cn_vit-b-16.pt`,
          sizeBytes: 1_073_741_824,
          exists: true,
        },
      ],
      modelBytes: 1_073_741_824,
      results: {
        path: `${root}\\derived\\metadata\\embedding`,
        bytes: 512,
        fileCount: 1,
        available: true,
      },
    },
    {
      type: "ocr",
      name: "文字识别",
      modelDirectory: "C:\\Gallery\\backend\\aiworker\\.venv\\rapidocr\\models",
      modelFiles: [],
      modelBytes: 0,
      results: {
        path: `${root}\\derived\\metadata\\ocr`,
        bytes: 512,
        fileCount: 1,
        available: true,
      },
    },
    {
      type: "face",
      name: "人脸识别",
      modelDirectory: `${root}\\derived\\ai\\models\\face`,
      modelFiles: [],
      modelBytes: 0,
      results: {
        path: `${root}\\derived\\metadata\\face`,
        bytes: 512,
        fileCount: 1,
        available: true,
      },
    },
  ],
  vectors: {
    path: `${root}\\derived\\ai\\vectors`,
    bytes: 4096,
    fileCount: 2,
    available: true,
  },
};

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LocalAIStoragePanel />
    </QueryClientProvider>,
  );
}

describe("本机 AI 存储面板", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aiStorageApi.get).mockResolvedValue({
      ok: true,
      storage: snapshot,
    });
  });

  it("显示当前路径、模型文件大小与各类结果缓存占用", async () => {
    renderPanel();

    expect(
      await screen.findByText(`${root}\\state\\ai_jobs.json`),
    ).toBeInTheDocument();
    expect(screen.getByText("clip_cn_vit-b-16.pt")).toBeInTheDocument();
    expect(await screen.findAllByText("1 GB")).toHaveLength(2);
    expect(
      screen.getByText("使用 Go 内置 EXIF/GPS 解析器，无需额外模型文件。"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("该模块的分析结果缓存")).toHaveLength(4);
    expect(
      screen.getByText("4 个元数据、OCR、人脸与向量任务批次文件"),
    ).toBeInTheDocument();
  });
});
