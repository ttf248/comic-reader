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
    chinaGeometry: vi.fn(),
    chinaRegionVisits: vi.fn(),
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
    boundaryVersion: "areacity-2025.251231.260403",
    gpsPhotoCount: 8,
    chinaPhotoCount: 8,
    unassignedPhotoCount: 0,
    provinceCount: 2,
    cityCount: 1,
    districtCount: 0,
    provinces: [
      {
        adcode: 330000,
        name: "浙江省",
        photoCount: 5,
        unmatchedAreaPhotoCount: 0,
      },
      {
        adcode: 310000,
        name: "上海市",
        photoCount: 3,
        unmatchedAreaPhotoCount: 0,
      },
    ],
    months: [
      { month: "2019-05", count: 4 },
      { month: "2021-06", count: 4 },
    ],
    trajectory: [
      {
        at: "2019-05-02",
        until: "2019-05-02",
        adcode: 330000,
        name: "浙江省",
        photoCount: 4,
      },
      {
        at: "2021-06-12",
        until: "2021-06-12",
        adcode: 310000,
        name: "上海市",
        photoCount: 4,
      },
    ],
    untimedPhotoCount: 1,
  },
};

const zhejiang = {
  ok: true as const,
  regions: {
    revision: 4,
    boundaryVersion: "areacity-2025.251231.260403",
    region: {
      adcode: 330000,
      name: "浙江省",
      level: "province",
      photoCount: 5,
      unmatchedAreaPhotoCount: 0,
      visitCount: 2,
      firstAt: "2019-05-02",
      lastAt: "2021-06-12",
      coverResourceIds: ["f_1"],
      parentAdcode: null,
      ancestors: [],
    },
    regions: [
      {
        adcode: 330100,
        name: "杭州市",
        level: "city",
        photoCount: 3,
      },
      {
        adcode: 330200,
        name: "宁波市",
        level: "city",
        photoCount: 2,
      },
    ],
    months: [
      { month: "2019-05", count: 3 },
      { month: "2021-06", count: 2 },
    ],
    trajectory: [
      {
        at: "2019-05-02",
        until: "2019-05-02",
        adcode: 330100,
        name: "杭州市",
        photoCount: 3,
      },
    ],
    untimedPhotoCount: 0,
  },
};

const hangzhou = {
  ok: true as const,
  regions: {
    revision: 4,
    boundaryVersion: "areacity-2025.251231.260403",
    region: {
      adcode: 330100,
      name: "杭州市",
      level: "city",
      photoCount: 3,
      unmatchedAreaPhotoCount: 0,
      visitCount: 2,
      firstAt: "2019-05-02",
      lastAt: "2021-06-12",
      coverResourceIds: ["f_1"],
      parentAdcode: 330000,
      ancestors: [{ adcode: 330000, name: "浙江省" }],
    },
    regions: [
      {
        adcode: 330106,
        name: "西湖区",
        level: "district",
        photoCount: 3,
      },
      {
        adcode: 330105,
        name: "拱墅区",
        level: "district",
        photoCount: 0,
      },
    ],
    months: [{ month: "2019-05", count: 3 }],
    trajectory: [],
    untimedPhotoCount: 0,
  },
};

const xihu = {
  ok: true as const,
  regions: {
    revision: 4,
    boundaryVersion: "areacity-2025.251231.260403",
    region: {
      adcode: 330106,
      name: "西湖区",
      level: "district",
      photoCount: 3,
      unmatchedAreaPhotoCount: 3,
      visitCount: 2,
      firstAt: "2019-05-02",
      lastAt: "2021-06-12",
      coverResourceIds: ["f_1"],
      parentAdcode: 330100,
      ancestors: [
        { adcode: 330000, name: "浙江省" },
        { adcode: 330100, name: "杭州市" },
      ],
    },
    regions: [],
    months: [{ month: "2019-05", count: 3 }],
    trajectory: [],
    untimedPhotoCount: 0,
  },
};

const visits = {
  ok: true as const,
  visits: {
    revision: 4,
    boundaryVersion: "areacity-2025.251231.260403",
    region: {
      adcode: 330100,
      name: "杭州市",
      level: "city",
      photoCount: 3,
      unmatchedAreaPhotoCount: 0,
      visitCount: 2,
      firstAt: "2019-05-02",
      lastAt: "2021-06-12",
      coverResourceIds: ["f_1"],
      parentAdcode: 330000,
      ancestors: [{ adcode: 330000, name: "浙江省" }],
    },
    visits: [
      {
        startedAt: "2019-05-02",
        endedAt: "2019-05-04",
        dayCount: 3,
        photoCount: 3,
        regions: [{ adcode: 330200, name: "宁波市", count: 2 }],
      },
    ],
    untimedPhotoCount: 0,
  },
};

/** 绘图轮廓：统计与几何是两份数据，这里补上几何那一半。 */
const outlineFeatures = [
  { adcode: 330000, name: "浙江省", level: "province", geometry: polygon },
  { adcode: 310000, name: "上海市", level: "province", geometry: polygon },
  { adcode: 330100, name: "杭州市", level: "city", geometry: polygon },
  { adcode: 330200, name: "宁波市", level: "city", geometry: polygon },
  { adcode: 330106, name: "西湖区", level: "district", geometry: polygon },
  { adcode: 330105, name: "拱墅区", level: "district", geometry: polygon },
];

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
        if (adcode === 330106) return xihu;
        throw new Error(`unexpected adcode ${adcode}`);
      },
    );
    vi.mocked(aiJobsApi.chinaGeometry).mockResolvedValue({
      ok: true,
      boundaryVersion: "areacity-2025.251231.260403-outline1",
      hash: "outline-hash",
      level: "children",
      parentAdcode: 0,
      features: outlineFeatures,
    });
    vi.mocked(aiJobsApi.chinaRegionVisits).mockResolvedValue(visits);
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
          visitCount: 2,
          firstAt: "2019-05-02",
          lastAt: "2021-06-12",
          coverResourceIds: ["f_1"],
          parentAdcode: 330000,
          ancestors: [{ adcode: 330000, name: "浙江省" }],
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
    expect(
      screen.getByText(/基准：全国 · 全部时间 · 8 张/),
    ).toBeInTheDocument();
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
    expect(aiJobsApi.chinaRegions).toHaveBeenCalledWith(
      330000,
      expect.objectContaining({ from: null, to: null }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("location-search")).toHaveTextContent(
        "?adcode=330000",
      );
    });
    const crumb = screen.getByRole("navigation", { name: "地点层级" });
    expect(crumb).toHaveTextContent("全国");
    expect(crumb).toHaveTextContent("浙江省");
    expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
    expect(
      screen.getByText(/基准：浙江省 · 全部时间 · 5 张/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "全国" }));
    await waitFor(() => {
      expect(screen.getByTestId("location-search")).toHaveTextContent("");
    });
    expect(
      screen.getByText(/基准：全国 · 全部时间 · 8 张/),
    ).toBeInTheDocument();
  });

  it("排行面板也能进入区域", async () => {
    renderPage();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "浙江省，5 张照片，占本层 62.5%，进入",
      }),
    );

    expect((await screen.findAllByText("杭州市")).length).toBeGreaterThan(0);
    expect(aiJobsApi.chinaRegions).toHaveBeenCalledWith(
      330000,
      expect.anything(),
    );
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

  it("城市可继续进入区县，面包屑列出完整层级", async () => {
    renderPage("/photo/locations?adcode=330100");

    expect(await screen.findByText("杭州市地图")).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "西湖区，3 张照片，占本层 100.0%",
      }),
    );
    expect(await screen.findByText("西湖.jpg")).toBeInTheDocument();
    expect(screen.getByTestId("photo-wall")).toBeInTheDocument();
    const crumb = screen.getByRole("navigation", { name: "地点层级" });
    expect(crumb).toHaveTextContent("全国");
    expect(crumb).toHaveTextContent("浙江省");
    expect(crumb).toHaveTextContent("杭州市");
    expect(crumb).toHaveTextContent("西湖区");
  });
});

describe("拍摄地点的时间维度", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aiJobsApi.chinaLocations).mockResolvedValue(summary);
    vi.mocked(aiJobsApi.chinaRegions).mockImplementation(
      async (adcode: number) => {
        if (adcode === 330000) return zhejiang;
        if (adcode === 330100) return hangzhou;
        if (adcode === 330106) return xihu;
        throw new Error(`unexpected adcode ${adcode}`);
      },
    );
    vi.mocked(aiJobsApi.chinaGeometry).mockResolvedValue({
      ok: true,
      boundaryVersion: "areacity-2025.251231.260403-outline1",
      hash: "outline-hash",
      level: "children",
      parentAdcode: 0,
      features: outlineFeatures,
    });
    vi.mocked(aiJobsApi.chinaRegionVisits).mockResolvedValue(visits);
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
          visitCount: 2,
          firstAt: "2019-05-02",
          lastAt: "2021-06-12",
          coverResourceIds: ["f_1"],
          parentAdcode: 330000,
          ancestors: [{ adcode: 330000, name: "浙江省" }],
        },
      },
    });
  });

  it("时间轴按年分格，并如实说明没有拍摄时间的照片", async () => {
    renderPage();

    const year = await screen.findByRole("button", {
      name: "2019 年，4 张照片",
    });
    expect(year).toBeInTheDocument();
    expect(
      screen.getByText("1 张照片没有拍摄时间，未计入时间轴。"),
    ).toBeInTheDocument();
  });

  it("选中年份后地址带上时间区间，接口也带上同样的区间", async () => {
    renderPage();

    fireEvent.click(
      await screen.findByRole("button", { name: "2019 年，4 张照片" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("location-search")).toHaveTextContent(
        "from=2019-01&to=2019-12",
      );
    });
    expect(aiJobsApi.chinaLocations).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: "2019-01", to: "2019-12" }),
    );
  });

  it("下钻时保留时间区间", async () => {
    renderPage("/photo/locations?from=2019-01&to=2019-12");

    fireEvent.click(
      await screen.findByRole("button", {
        name: "浙江省，5 张照片，占本层 62.5%",
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("location-search")).toHaveTextContent(
        "adcode=330000",
      );
    });
    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "from=2019-01",
    );
    expect(aiJobsApi.chinaRegions).toHaveBeenCalledWith(
      330000,
      expect.objectContaining({ from: "2019-01", to: "2019-12" }),
    );
  });

  it("城市层级给出到访清单，点一次到访打开那几天的照片", async () => {
    renderPage("/photo/locations?adcode=330100");
    fireEvent.click(await screen.findByRole("button", { name: "到访" }));

    const visit = await screen.findByRole("button", {
      name: /2019-05-02 至 2019-05-04，3 天，3 张照片/,
    });
    expect(visit).toBeInTheDocument();

    fireEvent.click(visit);
    await waitFor(() => {
      expect(aiJobsApi.chinaRegionMedia).toHaveBeenCalledWith(
        330100,
        undefined,
        expect.anything(),
        0,
      );
    });
  });
});
