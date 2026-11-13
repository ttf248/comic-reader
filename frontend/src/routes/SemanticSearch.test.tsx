import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SemanticSearch from "./SemanticSearch";

const mocks = vi.hoisted(() => ({
  embeddingStatus: vi.fn(),
  locations: vi.fn(),
  people: vi.fn(),
  semanticSearch: vi.fn(),
  albumSearch: vi.fn(),
}));

vi.mock("../api/aiJobs", () => ({
  aiJobsApi: {
    embeddingStatus: mocks.embeddingStatus,
    locations: mocks.locations,
    people: mocks.people,
    semanticSearch: mocks.semanticSearch,
  },
}));

vi.mock("../api/albums", () => ({
  albumsApi: { search: mocks.albumSearch },
}));

vi.mock("../components/wall/PhotoWall", () => ({
  default: ({
    items,
    itemBadge,
  }: {
    items: {
      id: string;
      kind: "image";
      name: string;
      index: number;
      kindIndex: number;
      width: number;
      height: number;
      albumId: string;
      albumName: string;
      similarity?: number;
      matchReasons?: (
        "semantic" | "similar_image" | "ocr_exact" | "ocr_approximate"
      )[];
    }[];
    itemBadge?: (item: {
      id: string;
      kind: "image";
      name: string;
      index: number;
      kindIndex: number;
      width: number;
      height: number;
      albumId: string;
      albumName: string;
      similarity?: number;
      matchReasons?: (
        "semantic" | "similar_image" | "ocr_exact" | "ocr_approximate"
      )[];
    }) => string | undefined;
  }) => (
    <div>
      {items.map((item) => (
        <span key={item.id}>{itemBadge?.(item)}</span>
      ))}
    </div>
  ),
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
        cudaExecutionProviderAvailable: true,
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
    mocks.locations.mockResolvedValue({
      ok: true,
      page: {
        items: [
          {
            id: "gps_abc",
            name: "北京",
            latitude: 39.9,
            longitude: 116.4,
            fileCount: 2,
            albumCount: 1,
            cellPrecision: 5,
          },
        ],
      },
    });
    mocks.people.mockResolvedValue({
      ok: true,
      people: [
        {
          id: "p_123456",
          name: "旅行同伴",
          faceCount: 2,
          photoCount: 2,
          hidden: false,
        },
      ],
      groupingLimited: false,
      threshold: 0.363,
      revision: 1,
    });
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
    expect(screen.getByRole("button", { name: /高级筛选/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByLabelText("GPS 地点")).not.toBeInTheDocument();
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

  it("将语义、OCR、相册、年份、地点、人物、收藏和精选条件一起提交", async () => {
    mocks.albumSearch.mockResolvedValue({
      results: [{ kind: "album", path: "a_album123", name: "旅行相册" }],
    });
    renderSearch();
    fireEvent.click(screen.getByRole("button", { name: /高级筛选/ }));

    fireEvent.change(
      await screen.findByPlaceholderText(
        "例如：夜晚街道上的霓虹灯、海边散步的人",
      ),
      { target: { value: "海边散步" } },
    );
    fireEvent.change(
      screen.getByPlaceholderText("例如：车站名称、招牌或照片里的日期"),
      {
        target: { value: "入口" },
      },
    );
    fireEvent.change(screen.getByPlaceholderText("输入相册名搜索"), {
      target: { value: "旅行" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "旅行相册" }));
    fireEvent.change(screen.getByPlaceholderText("例如 2024"), {
      target: { value: "2024" },
    });
    fireEvent.change(screen.getByLabelText("GPS 地点"), {
      target: { value: "gps_abc" },
    });
    fireEvent.change(screen.getByLabelText("人物"), {
      target: { value: "p_123456" },
    });
    fireEvent.click(screen.getByLabelText("仅来自收藏相册"));
    fireEvent.click(screen.getByLabelText("仅精选照片"));
    fireEvent.click(screen.getByRole("button", { name: "搜索照片" }));

    await waitFor(() =>
      expect(mocks.semanticSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "海边散步",
          ocrText: "入口",
          albumId: "a_album123",
          year: "2024",
          locationId: "gps_abc",
          personId: "p_123456",
          favoriteOnly: true,
          pickedOnly: true,
          kind: "photo",
          offset: 0,
          limit: 60,
        }),
        undefined,
      ),
    );
  });

  it("向结果角标说明语义分数与 OCR 近似匹配", async () => {
    mocks.semanticSearch.mockResolvedValue({
      ok: true,
      results: [
        {
          item: {
            id: "f_result",
            kind: "image",
            name: "station.jpg",
            index: 0,
            kindIndex: 0,
            width: 800,
            height: 600,
            albumId: "a_album123",
            albumName: "旅行相册",
          },
          similarity: 0.42,
          matchReasons: ["semantic", "ocr_approximate"],
        },
      ],
      total: 1,
      offset: 0,
      nextOffset: 1,
      revision: 1,
    });
    renderSearch();
    fireEvent.change(
      await screen.findByPlaceholderText(
        "例如：夜晚街道上的霓虹灯、海边散步的人",
      ),
      { target: { value: "车站" } },
    );
    fireEvent.change(
      screen.getByPlaceholderText("例如：车站名称、招牌或照片里的日期"),
      { target: { value: "中关村科技园" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "搜索照片" }));

    expect(await screen.findByText("语义 0.42 · 文字近似")).toBeInTheDocument();
  });
});
