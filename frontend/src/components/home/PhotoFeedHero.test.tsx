import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PhotoFeedHero from "./PhotoFeedHero";
import { useAppModeStore } from "../../store/appModeStore";

const requests: { seed?: string }[] = [];

vi.mock("../../api/library", () => ({
  libraryApi: {
    mediaFeed: (query: { seed?: string }) => {
      requests.push({ seed: query.seed });
      return Promise.resolve({
        ok: true,
        page: {
          revision: 1,
          total: 1,
          items: [
            {
              id: `f_${query.seed ?? "none"}`,
              kind: "image",
              name: `${query.seed ?? "none"}.jpg`,
              index: 0,
              kindIndex: 0,
              albumId: "a_1",
              albumName: "第一本",
            },
          ],
        },
      });
    },
  },
}));

vi.mock("../../hooks/usePicks", () => ({
  usePicks: () => ({
    isPicked: () => false,
    toggle: vi.fn(),
    total: 0,
    isLoading: false,
  }),
}));

// 照片条按容器宽度排布：测试里给一个固定宽度。
vi.mock("../../hooks/useElementSize", () => ({
  useElementSize: () => ({ ref: { current: null }, width: 1200, height: 800 }),
}));

function renderHero() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PhotoFeedHero />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("随手看看的换一批", () => {
  beforeEach(() => {
    requests.length = 0;
    useAppModeStore.setState({ preference: "photo", hydrated: true });
  });

  it("换一批换的是取材种子，因此一定换得掉", async () => {
    renderHero();
    await waitFor(() => expect(requests.length).toBe(1));
    const first = requests[0].seed;
    expect(first).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /换一批/ }));
    await waitFor(() => expect(requests.length).toBe(2));
    expect(requests[1].seed).not.toBe(first);
  });

  it("照片到位后墙上摆出照片", async () => {
    renderHero();
    await waitFor(() => expect(requests.length).toBe(1));
    await waitFor(() =>
      expect(document.querySelectorAll("img").length).toBeGreaterThan(0),
    );
  });
});
