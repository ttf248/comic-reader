import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GPSLocations from "./GPSLocations";
import { aiJobsApi } from "../api/aiJobs";

vi.mock("../api/aiJobs", () => ({
  aiJobsApi: {
    locations: vi.fn(),
    locationMedia: vi.fn(),
    metadata: vi.fn(),
  },
}));

describe("GPS 地点相册", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aiJobsApi.locations).mockResolvedValue({
      ok: true,
      page: {
        revision: 4,
        total: 1,
        items: [
          {
            id: "loc_1234567890abcdef",
            name: "坐标 37.5000°, -122.2500°",
            latitude: 37.5,
            longitude: -122.25,
            fileCount: 8,
            albumCount: 2,
            coverResourceId: "f_cover",
            cellPrecision: 5,
          },
        ],
      },
    });
  });

  it("以离线坐标展示地点，并可打开对应相册", async () => {
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

    expect(
      await screen.findByText("坐标 37.5000°, -122.2500°"),
    ).toBeInTheDocument();
    expect(screen.getByText("37.50000°, -122.25000°")).toBeInTheDocument();
    expect(
      document.querySelector('a[href="/photo/locations/loc_1234567890abcdef"]'),
    ).toBeInTheDocument();
  });
});
