import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Travels from "./Travels";
import { aiJobsApi, type ChinaLocationGeometry } from "../api/aiJobs";

vi.mock("../api/aiJobs", () => ({
  aiJobsApi: {
    chinaLocations: vi.fn(),
    chinaRegions: vi.fn(),
    chinaRegionVisits: vi.fn(),
    chinaRegionMedia: vi.fn(),
    chinaGeometry: vi.fn(),
    chinaPlaces: vi.fn(),
    chinaTrips: vi.fn(),
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
      { adcode: 330000, name: "浙江省", photoCount: 5, unmatchedAreaPhotoCount: 0 },
      { adcode: 310000, name: "上海市", photoCount: 3, unmatchedAreaPhotoCount: 0 },
      { adcode: 410000, name: "河南省", photoCount: 0, unmatchedAreaPhotoCount: 0 },
    ],
    months: [
      { month: "2019-05", count: 4 },
      { month: "2021-06", count: 4 },
    ],
    trajectory: [],
    untimedPhotoCount: 1,
  },
};

const places = {
  ok: true as const,
  places: {
    revision: 4,
    boundaryVersion: "areacity-2025.251231.260403",
    level: "province",
    total: 2,
    gpsPhotoCount: 8,
    chinaPhotoCount: 8,
    unassignedPhotoCount: 0,
    untimedPhotoCount: 1,
    items: [
      {
        adcode: 330000,
        name: "浙江省",
        level: "province",
        photoCount: 5,
        unmatchedCount: 0,
        visitCount: 2,
        firstAt: "2019-05-02",
        lastAt: "2021-06-12",
        coverResourceIds: ["f_1", "f_2", "f_3"],
      },
      {
        adcode: 310000,
        name: "上海市",
        level: "province",
        photoCount: 3,
        unmatchedCount: 0,
        visitCount: 1,
        firstAt: "2021-06-12",
        lastAt: "2021-06-12",
        coverResourceIds: ["f_4"],
      },
    ],
  },
};

const trips = {
  ok: true as const,
  trips: {
    revision: 4,
    boundaryVersion: "areacity-2025.251231.260403",
    granularity: "city",
    gapDays: 14,
    total: 2,
    untimedPhotoCount: 1,
    items: [
      {
        id: "2019-05-02-330100",
        kind: "trip" as const,
        startedAt: "2019-05-02",
        endedAt: "2019-05-05",
        dayCount: 4,
        photoCount: 6,
        stops: [
          {
            adcode: 330100,
            name: "杭州市",
            level: "city",
            at: "2019-05-02",
            until: "2019-05-03",
            dayCount: 2,
            photoCount: 4,
          },
          {
            adcode: 310000,
            name: "上海市",
            level: "province",
            at: "2019-05-05",
            until: "2019-05-05",
            dayCount: 1,
            photoCount: 2,
          },
        ],
        coverResourceIds: ["f_1", "f_2"],
      },
      {
        id: "2021-06-12-330100",
        kind: "stay" as const,
        startedAt: "2021-06-12",
        endedAt: "2021-06-12",
        dayCount: 1,
        photoCount: 2,
        stops: [
          {
            adcode: 330100,
            name: "杭州市",
            level: "city",
            at: "2021-06-12",
            until: "2021-06-12",
            dayCount: 1,
            photoCount: 2,
          },
        ],
        coverResourceIds: ["f_3"],
      },
    ],
  },
};

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location-search">
      {location.pathname}
      {location.search}
    </div>
  );
}

function renderPage(initialEntry = "/photo/travels") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LocationProbe />
        <Routes>
          <Route path="/photo/travels" element={<Travels />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("足迹页", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aiJobsApi.chinaLocations).mockResolvedValue(summary);
    vi.mocked(aiJobsApi.chinaPlaces).mockResolvedValue(places);
    vi.mocked(aiJobsApi.chinaTrips).mockResolvedValue(trips);
    vi.mocked(aiJobsApi.chinaGeometry).mockResolvedValue({
      ok: true,
      boundaryVersion: "areacity-2025.251231.260403-outline1",
      hash: "outline-hash",
      level: "children",
      parentAdcode: 0,
      features: [
        { adcode: 330000, name: "浙江省", level: "province", geometry: polygon },
        { adcode: 310000, name: "上海市", level: "province", geometry: polygon },
      ],
    });
  });

  it("先给规模，再给地点与行程", async () => {
    renderPage();

    // 数字台：段足迹、去过的地方、张数。
    expect(await screen.findByText("段足迹")).toBeTruthy();
    expect(await screen.findByText("2 个省 · 1 个市")).toBeTruthy();
    expect(await screen.findByText("张带位置的照片")).toBeTruthy();

    // 地点索引只列有照片的地方。
    expect(await screen.findByRole("link", { name: /浙江省/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /上海市/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /河南省/ })).toBeNull();
  });

  it("行程区分走过多个地方与只在一个地方", async () => {
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "行程" }),
    ).toBeTruthy();
    // 走过多个地方叫行程，只在一个地方叫停留。
    expect(await screen.findAllByText("行程")).not.toHaveLength(0);
    expect(await screen.findAllByText("停留")).not.toHaveLength(0);
    // 地点链按顺序排出来。
    expect(await screen.findAllByText("杭州市")).not.toHaveLength(0);
  });

  it("切换归并粒度会换一层地点", async () => {
    renderPage();

    await screen.findByRole("link", { name: /浙江省/ });
    fireEvent.click(screen.getByRole("radio", { name: "市" }));

    await waitFor(() => {
      expect(aiJobsApi.chinaPlaces).toHaveBeenCalledWith(
        "city",
        null,
        expect.anything(),
      );
    });
  });

  it("选年份后地址里带上时间区间", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "2019 年，4 张照片" }));

    await waitFor(() => {
      expect(screen.getByTestId("location-search").textContent).toContain(
        "from=2019-01",
      );
    });
    expect(screen.getByTestId("location-search").textContent).toContain(
      "to=2019-12",
    );
  });

  it("没有拍摄时间的照片如实说明", async () => {
    renderPage();

    expect(
      await screen.findByText("1 张照片没有拍摄时间，未计入时间轴。"),
    ).toBeTruthy();
  });

  it("地图上的省能直接打开这个地方的详情页", async () => {
    renderPage();

    const region = await screen.findByRole("button", {
      name: /^浙江省，/,
    });
    fireEvent.click(region);

    await waitFor(() => {
      expect(screen.getByTestId("location-search").textContent).toContain(
        "/photo/travels/place/330000",
      );
    });
  });
});
