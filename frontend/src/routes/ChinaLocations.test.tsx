import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChinaLocations from "./ChinaLocations";
import { aiJobsApi, type ChinaLocationGeometry } from "../api/aiJobs";

vi.mock("../api/aiJobs", () => ({
  aiJobsApi: {
    chinaLocations: vi.fn(),
    chinaRegions: vi.fn(),
    chinaRegionMedia: vi.fn(),
    metadata: vi.fn(),
  },
}));

vi.mock("../hooks/usePicks", () => ({
  usePicks: () => ({ isPicked: () => false, toggle: vi.fn() }),
}));

vi.mock("../components/wall/PhotoWall", () => ({
  default: ({ items }: { items: { name: string }[] }) => (
    <div data-testid="photo-wall">
      {items.map((item) => (
        <span key={item.name}>{item.name}</span>
      ))}
    </div>
  ),
}));

vi.mock("../components/wall/PhotoViewer", () => ({
  default: () => <div data-testid="photo-viewer" />,
}));

const polygon: ChinaLocationGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [115, 39],
      [117, 39],
      [117, 41],
      [115, 41],
      [115, 39],
    ],
  ],
};

const summary = {
  ok: true as const,
  locations: {
    revision: 4,
    boundaryVersion: "datav-areas_v3-2021.5",
    gpsPhotoCount: 8,
    chinaPhotoCount: 8,
    unassignedPhotoCount: 0,
    provinces: [
      {
        adcode: 330000,
        name: "浙江省",
        photoCount: 5,
        unmatchedAreaPhotoCount: 0,
        geometry: polygon,
      },
      {
        adcode: 310000,
        name: "上海市",
        photoCount: 3,
        unmatchedAreaPhotoCount: 0,
        geometry: polygon,
      },
    ],
  },
};

const zhejiang = {
  ok: true as const,
  regions: {
    revision: 4,
    boundaryVersion: "datav-areas_v3-2021.5",
    region: {
      adcode: 330000,
      name: "浙江省",
      level: "province",
      photoCount: 5,
      unmatchedAreaPhotoCount: 0,
      parentAdcode: null,
    },
    regions: [
      {
        adcode: 330100,
        name: "杭州市",
        level: "city",
        photoCount: 3,
        geometry: polygon,
      },
      {
        adcode: 330200,
        name: "宁波市",
        level: "city",
        photoCount: 2,
        geometry: polygon,
      },
    ],
  },
};

const hangzhou = {
  ok: true as const,
  regions: {
    revision: 4,
    boundaryVersion: "datav-areas_v3-2021.5",
    region: {
      adcode: 330100,
      name: "杭州市",
      level: "city",
      photoCount: 3,
      unmatchedAreaPhotoCount: 0,
      parentAdcode: 330000,
    },
    regions: [],
  },
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

function renderPage(initialEntry = "/photo/locations") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LocationProbe />
        <Routes>
          <Route path="/photo/locations" element={<ChinaLocations />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("拍摄地点逐级下钻", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aiJobsApi.chinaLocations).mockResolvedValue(summary);
    vi.mocked(aiJobsApi.chinaRegions).mockImplementation(
      async (adcode: number) => {
        if (adcode === 330000) return zhejiang;
        if (adcode === 330100) return hangzhou;
        throw new Error(`unexpected adcode ${adcode}`);
      },
    );
    vi.mocked(aiJobsApi.chinaRegionMedia).mockResolvedValue({
      ok: true,
      page: {
        revision: 4,
        total: 1,
        nextCursor: "",
        items: [
          {
            id: "f_1",
            kind: "image",
            index: 0,
            kindIndex: 0,
            name: "西湖.jpg",
            albumId: "a_1",
            albumName: "浙江",
          },
        ],
        albums: [{ id: "a_1", name: "浙江", count: 1 }],
        region: {
          adcode: 330100,
          name: "杭州市",
          level: "city",
          photoCount: 3,
          unmatchedAreaPhotoCount: 0,
          parentAdcode: 330000,
        },
      },
    });
  });

  it("默认显示全国省级地图，并给出排行与图例基准", async () => {
    renderPage();

    const province = await screen.findByRole("button", {
      name: "浙江省，5 张照片，占本层 62.5%",
    });
    expect(province).toBeInTheDocument();
    expect(screen.queryByText("杭州市")).not.toBeInTheDocument();
    expect(screen.getByText("基准：全国 · 8 张")).toBeInTheDocument();
    // 全国层级没有上级，面包屑与返回按钮都不该出现。
    expect(
      screen.queryByRole("navigation", { name: "地点层级" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "返回" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/坐标\s+\d/)).not.toBeInTheDocument();
  });

  it("点省份进入该省地图，并可从面包屑回到全国", async () => {
    renderPage();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "浙江省，5 张照片，占本层 62.5%",
      }),
    );

    expect((await screen.findAllByText("杭州市")).length).toBeGreaterThan(0);
    expect(aiJobsApi.chinaRegions).toHaveBeenCalledWith(330000);
    await waitFor(() => {
      expect(screen.getByTestId("location-search")).toHaveTextContent(
        "?adcode=330000",
      );
    });
    const crumb = screen.getByRole("navigation", { name: "地点层级" });
    expect(crumb).toHaveTextContent("全国");
    expect(crumb).toHaveTextContent("浙江省");
    expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
    expect(screen.getByText("基准：浙江省 · 5 张")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "全国" }));
    await waitFor(() => {
      expect(screen.getByTestId("location-search")).toHaveTextContent("");
    });
    expect(screen.getByText("基准：全国 · 8 张")).toBeInTheDocument();
  });

  it("排行面板也能进入区域", async () => {
    renderPage();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "浙江省，5 张照片，占本层 62.5%，进入",
      }),
    );

    expect((await screen.findAllByText("杭州市")).length).toBeGreaterThan(0);
    expect(aiJobsApi.chinaRegions).toHaveBeenCalledWith(330000);
  });

  it("地图内按 Esc 回到上一级", async () => {
    renderPage("/photo/locations?adcode=330000");

    const region = await screen.findByRole("button", {
      name: "杭州市，3 张照片，占本层 60.0%",
    });
    fireEvent.keyDown(region, { key: "Escape" });

    await waitFor(() => {
      expect(screen.getByTestId("location-search")).toHaveTextContent("");
    });
  });

  it("叶子区域给出该区域的照片墙", async () => {
    renderPage("/photo/locations?adcode=330100");

    expect(await screen.findByText("西湖.jpg")).toBeInTheDocument();
    expect(screen.getByTestId("photo-wall")).toBeInTheDocument();
    const crumb = screen.getByRole("navigation", { name: "地点层级" });
    expect(crumb).toHaveTextContent("全国");
    expect(crumb).toHaveTextContent("浙江省");
    expect(crumb).toHaveTextContent("杭州市");
  });
});
