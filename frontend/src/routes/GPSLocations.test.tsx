import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GPSLocations from "./GPSLocations";
import { aiJobsApi } from "../api/aiJobs";

vi.mock("../api/aiJobs", () => ({
  aiJobsApi: {
    locations: vi.fn(),
    locationMedia: vi.fn(),
    chinaLocations: vi.fn(),
    metadata: vi.fn(),
  },
}));

describe("省级拍摄地点地图", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aiJobsApi.chinaLocations).mockResolvedValue({
      ok: true,
      locations: {
        revision: 4,
        gpsPhotoCount: 8,
        chinaPhotoCount: 8,
        unassignedPhotoCount: 0,
        provinces: [
          {
            adcode: 110000,
            name: "北京市",
            photoCount: 5,
            unmatchedAreaPhotoCount: 0,
            geometry: {
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
            },
          },
          {
            adcode: 310000,
            name: "上海市",
            photoCount: 3,
            unmatchedAreaPhotoCount: 0,
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [120, 30],
                  [122, 30],
                  [122, 32],
                  [120, 32],
                  [120, 30],
                ],
              ],
            },
          },
        ],
        areas: [
          {
            adcode: 110101,
            provinceAdcode: 110000,
            name: "东城区",
            level: "district",
            photoCount: 3,
          },
          {
            adcode: 110102,
            provinceAdcode: 110000,
            name: "西城区",
            level: "district",
            photoCount: 2,
          },
          {
            adcode: 310115,
            provinceAdcode: 310000,
            name: "浦东新区",
            level: "district",
            photoCount: 3,
          },
        ],
      },
    });
  });

  it("显示省级照片数，并可点选省份查看城市与区县", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/photo/locations"]}>
          <Routes>
            <Route path="/photo/locations" element={<GPSLocations />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const beijing = await screen.findByRole("button", {
      name: "北京市，5 张照片",
    });
    expect(screen.getByText("东城区")).toBeInTheDocument();
    expect(screen.getByText("西城区")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "上海市，3 张照片" }));
    expect(screen.getByRole("heading", { name: "上海市" })).toBeInTheDocument();
    expect(screen.getByText("浦东新区")).toBeInTheDocument();
    expect(beijing).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText(/坐标\s+\d/)).not.toBeInTheDocument();
  });
});
