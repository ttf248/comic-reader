import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    chinaTripMedia: vi.fn(),
  },
}));

vi.mock("../hooks/usePicks", () => ({
  usePicks: () => ({ isPicked: () => false, toggle: vi.fn() }),
}));

vi.mock("../components/wall/PhotoWall", () => ({
  default: () => <div data-testid="photo-wall" />,
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
    level: "city",
    total: 2,
    gpsPhotoCount: 8,
    chinaPhotoCount: 8,
    unassignedPhotoCount: 0,
    untimedPhotoCount: 1,
    items: [
      {
        adcode: 330100,
        name: "杭州市",
        level: "city",
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
        index: 0,
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
            parentAdcode: 330000,
            at: "2019-05-02",
            until: "2019-05-03",
            dayCount: 2,
            photoCount: 4,
          },
          {
            adcode: 310000,
            name: "上海市",
            level: "province",
            parentAdcode: null,
            at: "2019-05-05",
            until: "2019-05-05",
            dayCount: 1,
            photoCount: 2,
          },
        ],
        coverResourceIds: ["f_1", "f_2"],
        bandResourceIds: ["f_1", "f_2", "f_3"],
      },
      {
        id: "2021-06-12-330100",
        index: 1,
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
            parentAdcode: 330000,
            at: "2021-06-12",
            until: "2021-06-12",
            dayCount: 1,
            photoCount: 2,
          },
        ],
        coverResourceIds: ["f_3"],
        bandResourceIds: ["f_3"],
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
          <Route
            path="/photo/travels/place/:placeId"
            element={<div data-testid="place-page" />}
          />
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

  it("先给规模，再给按时间排的段流", async () => {
    renderPage();

    // 数字台：段足迹、去过的地方、带位置的照片。
    const ledger = await screen.findByRole("region", { name: /规模/ });
    expect(await screen.findByText("段足迹")).toBeTruthy();
    expect(within(ledger).getByText("段足迹")).toBeTruthy();
    expect(within(ledger).getByText("2 个省 · 1 个市")).toBeTruthy();

    // 段流：每一段给出日期、地点链与照片带。
    expect(
      await screen.findByRole("region", { name: "2019-05-02 至 2019-05-05" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "看这一段的照片" }).length).toBe(
      4,
    );
  });

  it("选中一段，右栏才出现这段的说明", async () => {
    renderPage();

    // 面板平时不存在：地图是一件按需出现的配图。
    expect(screen.queryByRole("complementary", { name: "上下文" })).toBeNull();

    fireEvent.click(
      await screen.findByRole("button", {
        name: /2019-05-02 至 2019-05-05，4 天/,
      }),
    );

    const panel = await screen.findByRole("complementary", { name: "上下文" });
    expect(panel.textContent).toContain("这段行程");
    expect(panel.textContent).toContain("杭州市");
    expect(panel.textContent).toContain("上海市");
  });

  it("「地方」列出去过的地方", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "地方" }));

    const panel = await screen.findByRole("complementary", { name: "上下文" });
    expect(panel.textContent).toContain("杭州市");
    expect(panel.textContent).toContain("5 张");
  });

  it("切归并粒度会换一层地方与行程", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("radio", { name: "省" }));

    await waitFor(() => {
      expect(aiJobsApi.chinaPlaces).toHaveBeenCalledWith(
        "province",
        null,
        expect.anything(),
      );
    });
    expect(aiJobsApi.chinaTrips).toHaveBeenCalledWith(
      "province",
      expect.anything(),
      undefined,
    );
  });

  it("选年份后地址里带上时间区间", async () => {
    renderPage();

    fireEvent.click(
      await screen.findByRole("button", { name: "2019 年，4 张照片" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("location-search").textContent).toContain(
        "from=2019-01",
      );
    });
    expect(screen.getByTestId("location-search").textContent).toContain(
      "to=2019-12",
    );
  });

  it("点地名直接进这个地方，并且带着筛选条件", async () => {
    renderPage("/photo/travels?from=2019-01&to=2019-12&level=city");

    const stops = await screen.findAllByRole("button", { name: /杭州市/ });
    fireEvent.click(stops[0]);

    await waitFor(() => {
      expect(screen.getByTestId("location-search").textContent).toContain(
        "/photo/travels/place/330100",
      );
    });
    expect(screen.getByTestId("location-search").textContent).toContain(
      "from=2019-01",
    );
  });

  it("没有拍摄时间的照片如实说明", async () => {
    renderPage();

    expect(
      await screen.findByText("1 张照片没有拍摄时间，未计入时间轴。"),
    ).toBeTruthy();
  });
});
