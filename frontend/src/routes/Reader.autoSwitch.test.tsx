import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGalleryStore } from "../store/galleryStore";
import { useUIStore } from "../store/uiStore";
import Reader from "./Reader";

const mocks = vi.hoisted(() => ({
  getImage: vi.fn(),
  getPrefs: vi.fn(),
}));

vi.mock("../api/library", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/library")>();
  return {
    ...actual,
    libraryApi: {
      ...actual.libraryApi,
      allMedia: vi.fn(async () => ({
        revision: 1,
        total: 3,
        items: [0, 1, 2].map((index) => ({
          id: `f_image_${index}`,
          kind: "image",
          index,
          kindIndex: index,
          name: `${index}.png`,
        })),
      })),
      queryNodes: vi.fn(async () => ({
        revision: 1,
        missing: [],
        items: [{ id: "a_test", name: "当前相册", imageCount: 3 }],
      })),
    },
  };
});
vi.mock("../api/activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/activity")>()),
  activityApi: {
    getImage: mocks.getImage,
    setImage: vi.fn(async () => ({})),
    keepalive: vi.fn(),
  },
}));
vi.mock("../api/prefs", () => ({
  historyApi: { add: vi.fn(async () => ({ history: [] })) },
  prefsApi: { get: mocks.getPrefs },
}));
vi.mock("../hooks/useFavorites", () => ({
  useFavorites: () => ({ favorites: [], toggle: vi.fn() }),
}));
vi.mock("../components/gallery/ImageGallery", () => ({
  default: () => <div data-testid="image-gallery" />,
}));

function Location() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname + location.search}
    </output>
  );
}

function setContext(entries: Array<{ key: string; to: string; name: string }>) {
  sessionStorage.setItem(
    "local-gallery-context",
    JSON.stringify({
      source: { type: "home" },
      list: entries,
      index: 0,
      openedAt: Date.now(),
    }),
  );
}

function renderReader(index: number) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[`/read/a_test?index=${index}&name=当前相册`]}
      >
        <Location />
        <Routes>
          <Route path="/read/:albumId" element={<Reader />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Reader 读到末尾自动切换下一本", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.getImage.mockResolvedValue({ pageIndex: 2 });
    mocks.getPrefs.mockResolvedValue({
      favorites: [],
      history: [],
      maxRecent: 10,
      autoSwitchAlbum: true,
      showSwitchNotif: true,
      theme: "system",
      sidebarCollapsed: false,
    });
    useGalleryStore.setState({
      index: 2,
      zoom: 1,
      rotation: 0,
      slideshow: false,
      mode: "single",
      fit: "fit",
      direction: "ltr",
    });
    useUIStore.setState({ toasts: [] });
  });

  it("读完最后一张后进入下一本的阅读器", async () => {
    setContext([
      { key: "a_test", to: "/albums/a_test", name: "当前相册" },
      { key: "a_next", to: "/albums/a_next", name: "下一本" },
    ]);
    renderReader(2);
    await waitFor(() => expect(screen.getByTestId("image-gallery")).toBeInTheDocument());

    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });

    // 下一本要在阅读器里继续读，而不是回到相册首页。
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/read/a_next?index=0",
      );
    });
  });

  it("关闭自动切换后停在最后一张并给出提示", async () => {
    mocks.getPrefs.mockResolvedValue({
      favorites: [],
      history: [],
      maxRecent: 10,
      autoSwitchAlbum: false,
      showSwitchNotif: true,
      theme: "system",
      sidebarCollapsed: false,
    });
    setContext([
      { key: "a_test", to: "/albums/a_test", name: "当前相册" },
      { key: "a_next", to: "/albums/a_next", name: "下一本" },
    ]);
    renderReader(2);
    await waitFor(() => expect(screen.getByTestId("image-gallery")).toBeInTheDocument());

    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });

    expect(screen.getByTestId("location")).toHaveTextContent(
      "/read/a_test?index=2",
    );
  });
});
