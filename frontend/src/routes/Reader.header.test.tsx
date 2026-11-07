import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { useGalleryStore } from "../store/galleryStore";
import Reader from "./Reader";

const mocks = vi.hoisted(() => ({
  media: vi.fn(),
  nodes: vi.fn(),
  getImage: vi.fn(),
  historyAdd: vi.fn(),
}));

vi.mock("../api/library", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/library")>();
  return {
    ...actual,
    libraryApi: {
      ...actual.libraryApi,
      allMedia: mocks.media,
      queryNodes: mocks.nodes,
    },
  };
});

vi.mock("../api/activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/activity")>();
  return {
    ...actual,
    activityApi: {
      ...actual.activityApi,
      getImage: mocks.getImage,
      setImage: vi.fn(async () => ({})),
      keepalive: vi.fn(async () => ({})),
    },
  };
});

vi.mock("../api/prefs", () => ({
  historyApi: { add: mocks.historyAdd },
  prefsApi: {
    get: vi.fn(async () => ({
      favorites: [],
      history: [],
      maxRecent: 10,
      autoSwitchAlbum: false,
      showSwitchNotif: false,
      theme: "system",
      sidebarCollapsed: false,
    })),
  },
}));

vi.mock("../hooks/useKeyboard", () => ({ useKeyboard: vi.fn() }));
vi.mock("../hooks/useFavorites", () => ({
  useFavorites: () => ({ favorites: [], toggle: vi.fn() }),
}));
vi.mock("../utils/fullscreen", () => ({ toggleFullscreen: vi.fn() }));
vi.mock("../components/gallery/ImageGallery", () => ({
  default: () => <div data-testid="image-gallery" />,
}));
vi.mock("../components/gallery/VideoPlayer", () => ({
  default: () => <div data-testid="video-player" />,
}));
vi.mock("../components/gallery/PageSlider", () => ({ default: () => null }));
vi.mock("../components/gallery/GalleryHeader", () => ({
  default: ({ name }: { name: string }) => <h1>{name}</h1>,
}));
vi.mock("../components/gallery/GalleryAlbumNav", () => ({ default: () => null }));
vi.mock("../components/gallery/GalleryToolbar", () => ({ default: () => null }));
vi.mock("../components/common/ImageInfoPanel", () => ({ default: () => null }));
vi.mock("../components/common/HelpOverlay", () => ({ default: () => null }));

const albumId = "a_0000000000000000000001";

function renderReader() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Providers(_props: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/read/${albumId}`]}>
          <Routes>
            <Route path="/read/:albumId" element={<Reader />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }
  render(<Reader />, { wrapper: Providers });
}

// 漫画的卷名只写「第1卷」：顶栏只写卷名时，这一卷属于哪部作品
// 看不出来。作品名补在前面，与书封上的写法一致。
it("顶栏在卷名前面补上所属作品", async () => {
  mocks.nodes.mockResolvedValue({
    revision: 1,
    missing: [],
    items: [
      {
        id: albumId,
        kind: "album",
        contentKind: "comic",
        name: "第1卷",
        displayName: "第1卷",
        parentName: "星海漫步",
        coverImages: [],
        imageCount: 3,
      },
    ],
  });
  mocks.media.mockResolvedValue({
    revision: 1,
    items: ["f_1", "f_2", "f_3"].map((id, index) => ({
      id,
      kind: "image",
      name: `${index}.jpg`,
      index,
      kindIndex: index,
    })),
    total: 3,
  });
  mocks.getImage.mockResolvedValue({ pageIndex: 0 });

  renderReader();

  await waitFor(() =>
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "星海漫步 · 第1卷",
    ),
  );
});

it("没有所属作品时只写卷名", async () => {
  mocks.nodes.mockResolvedValue({
    revision: 1,
    missing: [],
    items: [
      {
        id: albumId,
        kind: "album",
        contentKind: "comic",
        name: "第1卷",
        displayName: "第1卷",
        coverImages: [],
        imageCount: 3,
      },
    ],
  });
  mocks.media.mockResolvedValue({
    revision: 1,
    items: ["f_1", "f_2", "f_3"].map((id, index) => ({
      id,
      kind: "image",
      name: `${index}.jpg`,
      index,
      kindIndex: index,
    })),
    total: 3,
  });
  mocks.getImage.mockResolvedValue({ pageIndex: 0 });

  renderReader();

  await waitFor(() =>
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("第1卷"),
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.historyAdd.mockResolvedValue({ history: [] });
  useGalleryStore.setState({ index: -1, mode: "single" });
});
