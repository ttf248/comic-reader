import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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

  it("左槽显示媒体库规模，作为全局上下文", () => {
    renderToolbar();
    expect(screen.getByText("60 本相册 · 20 个集合")).toBeInTheDocument();
  });

  it("中槽是搜索，右槽是全局动作", () => {
    renderToolbar();
    expect(screen.getByLabelText("搜索文件夹或标签")).toBeInTheDocument();
    expect(screen.getByLabelText("快捷键帮助")).toBeInTheDocument();
    expect(screen.getByLabelText("更多")).toBeInTheDocument();
  });
});
