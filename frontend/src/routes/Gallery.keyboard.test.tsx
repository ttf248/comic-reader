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
import Gallery from "./Gallery";

const mocks = vi.hoisted(() => ({
  getImage: vi.fn(),
  getVideo: vi.fn(),
  setVideo: vi.fn(),
  keepalive: vi.fn(),
  openInExplorer: vi.fn(),
}));

vi.mock("../api/library", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/library")>();
  return {
    ...actual,
    libraryApi: {
      ...actual.libraryApi,
      allMedia: vi.fn(async () => ({
        revision: 1,
        total: 6,
        items: ["image", "video"].flatMap((kind) =>
          [0, 1, 2].map((index) => ({
            id: `f_${kind}_${index}`,
            kind,
            index,
            kindIndex: index,
            name: `${index}.${kind === "image" ? "png" : "webm"}`,
          })),
        ),
      })),
      queryNodes: vi.fn(async () => ({
        revision: 1,
        missing: [],
        items: [{ id: "a_test", name: "键盘测试", imageCount: 3 }],
      })),
    },
  };
});
vi.mock("../api/activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/activity")>()),
  activityApi: { ...mocks, setImage: vi.fn(async () => ({})) },
}));
vi.mock("../api/prefs", () => ({
  historyApi: { add: vi.fn(async () => ({ history: [] })) },
}));
vi.mock("../hooks/useFavorites", () => ({
  useFavorites: () => ({ favorites: [], toggle: vi.fn() }),
}));
vi.mock("../api/videos", () => ({
  videoUrl: (id: string) => `/api/media/${id}`,
  createVideoPlaybackId: () => "keyboard-test",
  getTranscodeStatus: vi.fn(async () => ({ status: "not_needed" })),
}));
vi.mock("../api/fs", () => ({
  fsApi: {
    openInExplorer: mocks.openInExplorer,
    capabilities: vi.fn(async () => ({ allowOsOpen: true })),
  },
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

function renderGallery(type = "video") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[
          "/albums/a_test",
          `/gallery?path=a_test&type=${type}&index=1`,
        ]}
      >
        <Location />
        <Routes>
          <Route path="/gallery" element={<Gallery />} />
          <Route path="/albums/a_test" element={<div>相册列表</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function currentVideo() {
  await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
  const video = document.querySelector("video") as HTMLVideoElement;
  Object.defineProperty(video, "duration", { configurable: true, value: 100 });
  await act(async () => {
    fireEvent.loadedMetadata(video);
  });
  return video;
}

async function pressKey(key: string) {
  await act(async () => {
    fireEvent.keyDown(window, { key });
  });
}

describe("Gallery 按媒体类型隔离快捷键", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getImage.mockResolvedValue({ pageIndex: 1 });
    mocks.getVideo.mockResolvedValue({ positionMs: 0, durationMs: 100_000 });
    mocks.setVideo.mockResolvedValue({});
    useGalleryStore.setState({
      index: 0,
      zoom: 1,
      rotation: 0,
      slideshow: false,
      mode: "single",
      fit: "fit",
      direction: "ltr",
    });
  });

  it("视频左右键只定位当前文件，不同时切换到另一个视频", async () => {
    renderGallery();
    const video = await currentVideo();
    video.currentTime = 20;
    await pressKey("ArrowRight");
    expect(screen.getByTestId("location")).toHaveTextContent(
      "type=video&index=1",
    );
    expect(video.currentTime).toBe(25);
    expect(document.querySelector("video")).toBe(video);
    await pressKey("ArrowLeft");
    expect(video.currentTime).toBe(20);
    expect(screen.getByTestId("location")).toHaveTextContent(
      "type=video&index=1",
    );
  });

  it("视频空格仅切换播放，图片专属按键不修改图片偏好", async () => {
    renderGallery();
    const video = await currentVideo();
    const play = vi.spyOn(video, "play").mockResolvedValue();
    await pressKey(" ");
    expect(play).toHaveBeenCalledOnce();
    expect(useGalleryStore.getState().slideshow).toBe(false);
    for (const key of ["1", "2", "3", "f", "l", "r", "+", "-", "0", "i"]) {
      const before = useGalleryStore.getState();
      await pressKey(key);
      expect(useGalleryStore.getState()).toBe(before);
    }
  });

  it("视频 PageUp/PageDown 与首尾定位独立于图片显示模式", async () => {
    useGalleryStore.setState({ mode: "continuous" });
    renderGallery();
    await currentVideo();
    for (const [key, index] of [
      ["PageDown", 2],
      ["PageUp", 1],
      ["Home", 0],
      ["End", 2],
    ] as const) {
      await pressKey(key);
      expect(screen.getByTestId("location")).toHaveTextContent(
        `type=video&index=${index}`,
      );
    }
  });

  it("视频 Esc 返回相册，不受空图片列表阻挡", async () => {
    renderGallery();
    await currentVideo();
    await pressKey("Escape");
    expect(screen.getByTestId("location")).toHaveTextContent("/albums/a_test");
    expect(screen.getByText("相册列表")).toBeInTheDocument();
  });

  it("视频计数不沿用图片双页显示，并提示独立的换片按键", async () => {
    useGalleryStore.setState({ mode: "double" });
    renderGallery();
    await currentVideo();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "2 / 3",
    );
    expect(screen.getByTitle("上一个视频 (PageUp)")).toBeInTheDocument();
    expect(screen.getByTitle("下一个视频 (PageDown)")).toBeInTheDocument();
  });

  it("图片模式保留左右翻页与空格幻灯片", async () => {
    renderGallery("image");
    await screen.findByTestId("image-gallery");
    await waitFor(() => expect(useGalleryStore.getState().index).toBe(1));
    await pressKey("ArrowRight");
    expect(useGalleryStore.getState().index).toBe(2);
    await pressKey("ArrowLeft");
    expect(useGalleryStore.getState().index).toBe(1);
    await pressKey(" ");
    expect(useGalleryStore.getState().slideshow).toBe(true);
    act(() => useGalleryStore.setState({ slideshow: false }));
  });

  it("视频播到末尾的提示用视频的说法，并说明相册里还有图片", async () => {
    useUIStore.setState({ toasts: [] });
    renderGallery("video");
    await currentVideo();
    await pressKey("End");
    await pressKey("PageDown");
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe(
      "已是最后一个视频 · 相册里另有 3 张图片",
    );
  });

  it("图片播到末尾的提示说明相册里还有视频", async () => {
    useUIStore.setState({ toasts: [] });
    renderGallery("image");
    await screen.findByTestId("image-gallery");
    await waitFor(() => expect(useGalleryStore.getState().index).toBe(1));
    await pressKey("End");
    await pressKey("ArrowRight");
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe(
      "图片已看完 · 还有 3 个视频",
    );
  });

  it("视频阅读器的更多菜单不说图片，也不提供没有实现的图片信息", async () => {
    renderGallery("video");
    await currentVideo();
    await act(async () => {
      fireEvent.click(screen.getByTitle("更多"));
    });
    const items = screen
      .getAllByRole("menuitem")
      .map((el) => el.textContent ?? "")
      .join("|");
    expect(items).toContain("第一个视频");
    expect(items).toContain("最后一个视频");
    expect(items).not.toContain("图片");
  });

  it("图片阅读器的更多菜单保留图片信息与张数说法", async () => {
    renderGallery("image");
    await screen.findByTestId("image-gallery");
    await act(async () => {
      fireEvent.click(screen.getByTitle("更多"));
    });
    const items = screen
      .getAllByRole("menuitem")
      .map((el) => el.textContent ?? "")
      .join("|");
    expect(items).toContain("图片信息");
    expect(items).toContain("第一张");
    expect(items).toContain("最后张");
  });

  it("阅读器右键菜单可以在系统文件管理器中定位当前文件", async () => {
    mocks.openInExplorer.mockResolvedValue({ ok: true });
    renderGallery("image");
    await screen.findByTestId("image-gallery");
    await waitFor(() => expect(useGalleryStore.getState().index).toBe(1));
    await act(async () => {
      fireEvent.contextMenu(document.querySelector("div.relative.bg-neutral-950")!);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("menuitem", { name: "在资源管理器中打开" }),
      );
    });
    expect(mocks.openInExplorer).toHaveBeenCalledWith("f_image_1");
  });
});
