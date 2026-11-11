import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SemanticSearch from "./SemanticSearch";

const mocks = vi.hoisted(() => ({
  embeddingStatus: vi.fn(),
  locations: vi.fn(),
  semanticSearch: vi.fn(),
  albumSearch: vi.fn(),
}));

vi.mock("../api/aiJobs", () => ({
  aiJobsApi: {
    embeddingStatus: mocks.embeddingStatus,
    locations: mocks.locations,
    semanticSearch: mocks.semanticSearch,
  },
}));

vi.mock("../api/albums", () => ({
  albumsApi: { search: mocks.albumSearch },
}));

vi.mock("../hooks/usePicks", () => ({
  usePicks: () => ({
    isPicked: () => false,
    toggle: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../store/photoStore", () => ({
  usePhotoStore: (selector: (state: { density: "cozy" }) => unknown) =>
    selector({ density: "cozy" }),
  wallTargetHeight: () => 210,
}));

vi.mock("../store/uiStore", () => ({
  useUIStore: (selector: (state: { pushToast: () => void }) => unknown) =>
    selector({ pushToast: vi.fn() }),
}));

function renderSearch() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SemanticSearch />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("智能搜索", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.embeddingStatus.mockResolvedValue({
      ok: true,
      status: {
        pythonAvailable: true,
        pythonVersion: "3.11.9",
        torchVersion: "2.7.1+cu126",
        cudaAvailable: true,
        cudaVersion: "12.6",
        gpuName: "NVIDIA GeForce RTX 3060",
        device: "cuda",
        runtimeReady: true,
        modelAvailable: true,
        modelValid: true,
        modelLoaded: true,
        modelVersion: "chinese-clip-vit-b-16",
        index: {
          modelVersion: "chinese-clip-vit-b-16",
          dimension: 512,
          vectors: 0,
          shards: 0,
          indexVersion: 1,
          ready: false,
        },
        coverage: { indexed: 0, total: 0 },
      },
    });
    mocks.locations.mockResolvedValue({ ok: true, page: { items: [] } });
    mocks.semanticSearch.mockResolvedValue({
      ok: true,
      results: [],
      total: 0,
      offset: 0,
      nextOffset: 0,
      revision: 1,
    });
    mocks.albumSearch.mockResolvedValue({ results: [] });
  });

  it("提交中文描述并显示空索引引导", async () => {
    renderSearch();
    expect(screen.getByRole("button", { name: "中文描述" })).toHaveClass(
      "text-accent-contrast",
    );
    fireEvent.change(
      await screen.findByPlaceholderText(
        "例如：夜晚街道上的霓虹灯、海边散步的人",
      ),
      { target: { value: "海边散步的人" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "搜索照片" }));

    await waitFor(() =>
      expect(mocks.semanticSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "海边散步的人",
          kind: "photo",
          offset: 0,
          limit: 60,
        }),
        undefined,
      ),
    );
    expect(await screen.findByText("还没有可搜索的向量")).toBeInTheDocument();
    expect(screen.getByText(/NVIDIA GeForce RTX 3060/)).toBeInTheDocument();
  });

  it("Chinese-CLIP 不可用时仍可提交 OCR 搜索", async () => {
    mocks.embeddingStatus.mockResolvedValue({
      ok: true,
      status: {
        runtimeReady: false,
        modelValid: false,
        device: "cpu",
        coverage: { indexed: 0, total: 0 },
      },
    });
    renderSearch();

    fireEvent.change(
      screen.getByPlaceholderText("例如：车站名称、招牌或照片里的日期"),
      { target: { value: "入口" } },
    );
    const submit = screen.getByRole("button", { name: "搜索照片" });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() =>
      expect(mocks.semanticSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          ocrText: "入口",
          kind: "photo",
          offset: 0,
          limit: 60,
        }),
        undefined,
      ),
    );
    expect(
      await screen.findByText("还没有可搜索的文字结果"),
    ).toBeInTheDocument();
  });
});
