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
    chinaFeatures: vi.fn(),
    chinaPlaces: vi.fn(),
    chinaPoints: vi.fn(),
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
    totalPhotoCount: 120,
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
      {
        id: "2021-08-20-330100",
        index: 2,
        kind: "stay" as const,
        startedAt: "2021-08-20",
        endedAt: "2021-08-20",
        dayCount: 1,
        photoCount: 1,
        stops: [
          {
            adcode: 330100,
            name: "杭州市",
            level: "city",
            parentAdcode: 330000,
            at: "2021-08-20",
            until: "2021-08-20",
            dayCount: 1,
            photoCount: 1,
          },
        ],
        coverResourceIds: ["f_5"],
        bandResourceIds: ["f_5"],
      },
    ],
  },
};

const points = {
  ok: true as const,
  points: {
    revision: 4,
    cell: 0.02,
    total: 8,
    cells: 2,
    items: [
      {
        lon: 120.13,
        lat: 30.25,
        count: 5,
        untimed: 0,
        firstAt: "2019-05-02",
        lastAt: "2021-06-12",
      },
      {
        lon: 121.47,
        lat: 31.23,
        count: 3,
        untimed: 1,
        firstAt: "2021-06-12",
        lastAt: "2021-06-12",
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
    vi.mocked(aiJobsApi.chinaPoints).mockResolvedValue(points);
    vi.mocked(aiJobsApi.chinaFeatures).mockResolvedValue({
      ok: true,
      boundaryVersion: "areacity-2025.251231.260403-outline1",
      hash: "outline-hash",
      features: [
        { adcode: 330100, name: "杭州市", level: "city", geometry: polygon },
        { adcode: 310000, name: "上海市", level: "province", geometry: polygon },
      ],
    });
    vi.mocked(aiJobsApi.chinaGeometry).mockResolvedValue({
      ok: true,
      boundaryVersion: "areacity-2025.251231.260403-outline1",
      hash: "outline-hash",
      level: "province",
      parentAdcode: 0,
      features: [
        { adcode: 330000, name: "浙江省", level: "province", geometry: polygon },
        { adcode: 310000, name: "上海市", level: "province", geometry: polygon },
      ],
    });
  });

  it("抬头说清规模，地图升格到正文右栏", async () => {
    renderPage();

    // 抬头：左边是标题，右边是规模，不拆成四个各自占一格的大数字。
    expect(await screen.findByRole("heading", { name: "足迹" })).toBeTruthy();
    const head = document.querySelector(".travel-head") as HTMLElement;
    const stats = head.querySelector(".travel-stats") as HTMLElement;
    await waitFor(() => {
      expect(stats.textContent).toContain("张照片");
    });
    // 主数字是全库照片总数，其余是它的分解。
    expect(stats.textContent).toContain("120");
    expect(stats.textContent).toContain("张照片 · 全库");
    expect(stats.textContent).toContain("8 张带位置");
    expect(stats.textContent).toContain("2 个省");
    expect(stats.textContent).toContain("1 个市");
    expect(stats.textContent).toContain("1 张没有拍摄时间");

    // 地图不在抬头里，搬到了正文右栏，滚动时一直跟着。
    const aside = document.querySelector(".travel-layout__aside") as HTMLElement;
    const map = await screen.findByRole("img", { name: /小地图/ });
    expect(aside.contains(map)).toBe(true);
    // 点云是照片的真实位置：两个网格，两点。
    await waitFor(() => {
      expect(map.querySelectorAll(".travel-mini-map__point").length).toBe(2);
    });
  });

  it("时间轴是一排月格，两端各有一个刷手", async () => {
    renderPage();

    const timeline = await screen.findByRole("region", { name: "时间轴" });
    const handles = within(timeline).getAllByRole("slider");
    expect(handles.length).toBe(2);
    // 尺子是整条历史：2019-05 到 2021-06。
    expect(handles[0].getAttribute("aria-valuetext")).toBe("2019-05");
    expect(handles[1].getAttribute("aria-valuetext")).toBe("2021-06");

    // 一格一个月：2019-05 到 2021-06 共 26 个月，空档的月份也占位。
    const cells = timeline.querySelectorAll(".travel-timeline__cell");
    expect(cells.length).toBe(26);

    // 每段行程是格子上方的一颗钉。
    expect(
      within(timeline).getByRole("button", {
        name: /2019-05-02 至 2019-05-05，4 天，6 张照片/,
      }),
    ).toBeTruthy();
  });

  it("时间跨度可以切换，默认是最近五年", async () => {
    renderPage();

    const timeline = await screen.findByRole("region", { name: "时间轴" });
    const spans = within(timeline).getByRole("radiogroup", { name: "时间跨度" });
    // 缺省是最近五年：不用等全库的历史铺开。
    expect(within(spans).getByRole("radio", { name: "5年" }).getAttribute("aria-checked")).toBe("true");
    // 夹具里的历史只有 26 个月，五年已经全罩住了。
    expect(timeline.querySelectorAll(".travel-timeline__cell").length).toBe(26);

    // 换成最近一年，就只剩十二个月。
    fireEvent.click(within(spans).getByRole("radio", { name: "1年" }));

    await waitFor(() => {
      expect(
        within(timeline).getAllByRole("slider")[0].getAttribute("aria-valuetext"),
      ).toBe("2020-07");
    });
    expect(timeline.querySelectorAll(".travel-timeline__cell").length).toBe(12);
    // 跨度写进地址，刷新与分享都带着它。
    expect(screen.getByTestId("location-search").textContent).toContain("span=1y");
  });

  it("拖动刷手把时间区间写进地址", async () => {
    renderPage();

    const timeline = await screen.findByRole("region", { name: "时间轴" });
    const handle = within(timeline).getAllByRole("slider")[0];
    fireEvent.keyDown(handle, { key: "ArrowRight" });

    await waitFor(() => {
      expect(screen.getByTestId("location-search").textContent).toContain(
        "from=2019-06",
      );
    });
  });

  it("行程按年份倒序，一段一张卡片", async () => {
    renderPage();

    // 年份倒序：最近的排在最前面。
    await waitFor(() => {
      expect(document.querySelectorAll(".travel-trips__year").length).toBe(2);
    });
    const years = Array.from(
      document.querySelectorAll(".travel-trips__year"),
    ).map((element) => element.textContent);
    expect(years).toEqual(["2021", "2019"]);

    // 一段一张卡片；同一年的几段摆在一张列表里（窄屏一列、宽屏两列）。
    expect(document.querySelectorAll(".travel-trip-card").length).toBe(3);
    const lists = document.querySelectorAll(".travel-trips__list");
    expect(lists.length).toBe(2);
    expect(lists[0].querySelectorAll("li").length).toBe(2);
    expect(lists[1].querySelectorAll("li").length).toBe(1);
  });

  it("一段行程是一张卡片，点开才展开照片", async () => {
    renderPage();

    const segment = await screen.findByRole("region", {
      name: "2019-05-02 至 2019-05-05",
    });
    // 收起的时候没有照片带。
    expect(
      within(segment).queryAllByRole("button", { name: "看这一段的照片" }),
    ).toHaveLength(0);

    fireEvent.click(
      within(segment).getByRole("button", { name: /2019-05-02 至 2019-05-05/ }),
    );

    const expanded = await screen.findByRole("region", {
      name: "2019-05-02 至 2019-05-05",
    });
    expect(
      within(expanded).getAllByRole("button", { name: "看这一段的照片" }).length,
    ).toBe(3);
    expect(within(expanded).getByTestId("photo-wall")).toBeTruthy();
  });

  it("「地方」列出去过的地方", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "地方" }));

    const panel = await screen.findByRole("complementary", { name: "去过的地方" });
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
        undefined,
      );
    });
    // 行程不随时间区间重切：段的下标要能寻址到照片。
    expect(aiJobsApi.chinaTrips).toHaveBeenCalledWith(
      "province",
      undefined,
      undefined,
    );
  });

  it("点地名直接进这个地方，并且带着筛选条件", async () => {
    renderPage("/photo/travels?from=2019-01&to=2019-12&level=city");

    const segment = await screen.findByRole("region", {
      name: "2019-05-02 至 2019-05-05",
    });
    const stops = within(segment).getAllByRole("button", { name: /杭州市/ });
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

    const head = document.querySelector(".travel-head") as HTMLElement;
    const stats = head.querySelector(".travel-stats") as HTMLElement;
    await waitFor(() => {
      expect(stats.textContent).toContain("2 个省");
    });
    expect(stats.textContent).toContain("1 张没有拍摄时间");
  });
});
