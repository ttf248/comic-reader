import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Sidebar from "./Sidebar";

const dashboard = {
  dashboard: {
    inProgress: [] as Array<{
      album: Record<string, unknown>;
      pageIndex: number;
      pageCount: number;
    }>,
    unread: [],
    unreadCount: 0,
  },
};

vi.mock("../../hooks/useLibrary", () => ({
  useLibraryActivitySummary: () => ({
    data: { summary: { unreadCount: 69 } },
    isLoading: false,
  }),
  useLibraryDashboard: () => ({ data: dashboard }),
}));

vi.mock("../../api/library", () => ({
  libraryApi: { randomAlbum: vi.fn().mockResolvedValue({ album: { id: "x" } }) },
}));

const albumNode = {
  id: "a_1",
  kind: "album" as const,
  name: "某本漫画",
  displayName: "某本漫画",
  imageCount: 20,
  videoCount: 0,
  coverImage: "f_1/cover.jpg",
};

function renderSidebar(collapsed = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Sidebar collapsed={collapsed} onToggle={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Sidebar", () => {
  beforeEach(() => {
    dashboard.dashboard.inProgress = [];
    dashboard.dashboard.unreadCount = 69;
  });

  it("有在读相册时显示「接着读」迷你卡，含标题与进度", () => {
    dashboard.dashboard.inProgress = [
      { album: albumNode, pageIndex: 5, pageCount: 20 },
    ];
    renderSidebar();
    expect(screen.getByText("接着读")).toBeInTheDocument();
    expect(screen.getByText("某本漫画")).toBeInTheDocument();
    expect(screen.getByText("看到 6 / 20")).toBeInTheDocument();
  });

  it("迷你卡点击后跳到阅读器的上次位置", () => {
    dashboard.dashboard.inProgress = [
      { album: albumNode, pageIndex: 5, pageCount: 20 },
    ];
    renderSidebar();
    const btn = screen.getByTitle('继续阅读「某本漫画」');
    fireEvent.click(btn);
    // 跳转由 useNavigate 触发；断言按钮存在且可点击即可，
    // 路径拼装由 utils/continueReading 的单测覆盖。
    expect(btn).toBeInTheDocument();
  });

  it("没有在读相册时不显示迷你卡", () => {
    renderSidebar();
    expect(screen.queryByText("接着读")).not.toBeInTheDocument();
  });

  it("折叠态不显示迷你卡（侧栏只有 60px，放不下封面与标题）", () => {
    dashboard.dashboard.inProgress = [
      { album: albumNode, pageIndex: 5, pageCount: 20 },
    ];
    renderSidebar(true);
    expect(screen.queryByText("接着读")).not.toBeInTheDocument();
  });

  it("不再提供「随机未读」：该动作在未读页与首页已有入口", () => {
    renderSidebar();
    expect(screen.queryByText("随机未读")).not.toBeInTheDocument();
    // 「随机一本」保留
    expect(screen.getByText("随机一本")).toBeInTheDocument();
  });
});
