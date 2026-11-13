import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TravelPlace from "./TravelPlace";
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

const region = {
  adcode: 330000,
  name: "浙江省",
  level: "province",
  photoCount: 30,
  unmatchedAreaPhotoCount: 0,
  visitCount: 30,
  firstAt: "2019-05-02",
  lastAt: "2021-06-12",
  coverResourceIds: ["f_1"],
  parentAdcode: null,
  ancestors: [],
};

const regions = {
  ok: true as const,
  regions: {
    revision: 4,
    boundaryVersion: "areacity-2025.251231.260403",
    region,
    regions: [
      { adcode: 330100, name: "杭州市", level: "city", photoCount: 20 },
      { adcode: 330200, name: "宁波市", level: "city", photoCount: 10 },
    ],
    months: [{ month: "2019-05", count: 20 }],
    trajectory: [],
    untimedPhotoCount: 0,
  },
};

function visit(index: number) {
  return {
    startedAt: `2019-05-${String(index + 1).padStart(2, "0")}`,
    endedAt: `2019-05-${String(index + 1).padStart(2, "0")}`,
    dayCount: 1,
    photoCount: 1,
    regions: [],
  };
}

const visits = {
  ok: true as const,
  visits: {
    revision: 4,
    boundaryVersion: "areacity-2025.251231.260403",
    region,
    visits: Array.from({ length: 30 }, (_, index) => visit(index)),
    untimedPhotoCount: 0,
  },
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/photo/travels/place/330000"]}>
        <Routes>
          <Route path="/photo/travels/place/:placeId" element={<TravelPlace />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("地点详情页", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aiJobsApi.chinaRegions).mockResolvedValue(regions);
    vi.mocked(aiJobsApi.chinaRegionVisits).mockResolvedValue(visits);
    vi.mocked(aiJobsApi.chinaRegionMedia).mockResolvedValue({
      ok: true,
      page: {
        revision: 4,
        items: [],
        total: 0,
        albums: [],
        region,
      },
    });
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

  it("位置图把当前这个地方标出来", async () => {
    renderPage();

    const locator = await screen.findByRole("group", {
      name: /浙江省照片地图/,
    });
    expect(locator).toBeTruthy();
    // 只有当前这个地方是品牌色，其余是中性底。
    const brand = document.querySelectorAll(".travel-map path.fill-brand");
    expect(brand).toHaveLength(1);
  });

  it("到访记录每一条都能展开看照片", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "到访记录" })).toBeTruthy();
    expect(screen.getAllByText(/^2019-05-\d\d$/)).toHaveLength(30);

    // 照片在展开时才去取：到访常常上百条，一次全取既慢又没人看。
    expect(
      vi
        .mocked(aiJobsApi.chinaRegionMedia)
        .mock.calls.filter((call) => call[3] !== undefined),
    ).toHaveLength(0);
    fireEvent.click(screen.getAllByRole("button", { name: /看照片/ })[0]);
    await waitFor(() => {
      expect(aiJobsApi.chinaRegionMedia).toHaveBeenCalledWith(
        330000,
        undefined,
        undefined,
        0,
      );
    });
  });

  it("下级地点是横排的入口", async () => {
    renderPage();

    expect(await screen.findByRole("link", { name: /杭州市/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /宁波市/ })).toBeTruthy();
  });
});
