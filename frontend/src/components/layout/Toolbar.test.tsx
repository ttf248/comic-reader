import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import Toolbar from "./Toolbar";

const manifest = {
  manifest: {
    statistics: {
      albumCount: 104,
      collectionCount: 28,
      tagCount: 3,
      photoAlbumCount: 60,
      comicAlbumCount: 44,
      photoCollectionCount: 20,
      comicCollectionCount: 8,
      warningCount: 0,
    },
    scannedAt: "2026-11-03T00:00:00Z",
  },
};

vi.mock("../../hooks/useLibrary", () => ({
  useLibraryManifest: () => ({ data: manifest }),
  libraryQueryKeys: { root: ["library"] },
}));

vi.mock("../../hooks/useScanSSE", () => ({
  useScanSSE: () => ({
    isRunning: false,
    isComplete: false,
    scanId: null,
    progress: null,
    connectionState: "open",
    startWith: vi.fn(),
    reset: vi.fn(),
  }),
}));

vi.mock("../../api/library", () => ({
  libraryApi: { manifest: vi.fn(), dashboard: vi.fn() },
}));

vi.mock("../../api/scan", () => ({
  scanApi: { start: vi.fn(), cancel: vi.fn() },
}));

vi.mock("../common/GlobalSearch", () => ({
  default: () => <input aria-label="搜索文件夹或标签" placeholder="搜索" />,
}));

vi.mock("../common/ThemeSwitcher", () => ({
  default: () => <button aria-label="主题" />,
}));

// 宽屏：模式切换在顶栏左槽（窄屏时它在侧栏抽屉里）。
vi.mock("../../hooks/useMediaQuery", () => ({
  WIDE_LAYOUT_QUERY: "(min-width: 1024px)",
  useMediaQuery: () => true,
}));

function renderToolbar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Toolbar />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Toolbar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 库规模原来常驻顶栏，与页头的「上次更新」、状态栏的「上次扫描」是
  // 同一组上下文散在三处。它归到页头，顶栏不再重复。
  it("不再常驻媒体库规模", () => {
    renderToolbar();
    expect(screen.queryByText("60 本相册 · 20 个集合")).not.toBeInTheDocument();
  });

  it("宽屏时左槽是工作台模式切换", () => {
    renderToolbar();
    expect(screen.getByRole("group", { name: "工作台模式" })).toBeInTheDocument();
  });

  it("中槽是搜索，右槽是全局动作", () => {
    renderToolbar();
    expect(screen.getByLabelText("搜索文件夹或标签")).toBeInTheDocument();
    expect(screen.getByLabelText("快捷键帮助")).toBeInTheDocument();
    expect(screen.getByLabelText("更多")).toBeInTheDocument();
  });

  // 「重新扫描」已经有一个可见入口（页头）+ Ctrl+S，kebab 菜单里
  // 只留刷新缓存。
  it("更多菜单里不再重复「重新扫描」", () => {
    renderToolbar();
    fireEvent.click(screen.getByLabelText("更多"));
    expect(screen.getByRole("menuitem", { name: "刷新缓存" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /重新扫描/ })).not.toBeInTheDocument();
  });
});
