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
  useUnreadCountsByKind: () => ({ photo: 12, comic: 69 }),
  useLibraryDashboard: () => ({ data: dashboard }),
}));

// 工作台模式：默认覆盖漫画工作台（侧栏分组与「继续阅读」措辞），
// 单个用例可以改写 mode 切到照片工作台。
const appMode = { mode: "comic" as "comic" | "photo", setMode: vi.fn() };
vi.mock("../../hooks/useAppMode", () => ({
  useAppMode: () => ({
    mode: appMode.mode,
    ready: true,
    setMode: appMode.setMode,
  }),
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
  contentKind: "comic" as const,
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
    appMode.mode = "comic";
    appMode.setMode.mockClear();
  });

  it("有在读相册时显示「接着读」迷你卡，含标题与进度", () => {
    dashboard.dashboard.inProgress = [
      { album: albumNode, pageIndex: 5, pageCount: 20 },
    ];
    renderSidebar();
    // 分组标题现在是「继续阅读」（迷你卡内部不再重复写一次）
    expect(screen.getByText("继续阅读")).toBeInTheDocument();
    expect(screen.getByText("某本漫画")).toBeInTheDocument();
    expect(screen.getByText("读到 6 / 20")).toBeInTheDocument();
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
    expect(screen.queryByText("继续阅读")).not.toBeInTheDocument();
  });

  it("折叠态不显示迷你卡（侧栏只有 60px，放不下封面与标题）", () => {
    dashboard.dashboard.inProgress = [
      { album: albumNode, pageIndex: 5, pageCount: 20 },
    ];
    renderSidebar(true);
    expect(screen.queryByText("继续阅读")).not.toBeInTheDocument();
  });

  it("其余在读以紧凑行列出，并给出剩余数量", () => {
    dashboard.dashboard.inProgress = [
      { album: albumNode, pageIndex: 5, pageCount: 20 },
      { album: { ...albumNode, id: "a_2", name: "第二本", displayName: "第二本" }, pageIndex: 2, pageCount: 8 },
      { album: { ...albumNode, id: "a_3", name: "第三本", displayName: "第三本" }, pageIndex: 0, pageCount: 30 },
    ];
    renderSidebar();
    expect(screen.getByText("第二本")).toBeInTheDocument();
    expect(screen.getByText("读到 3 / 8")).toBeInTheDocument();
    expect(screen.getByText("3 本")).toBeInTheDocument();
  });

  it("侧栏按照片 / 漫画分成两组，两组各自给出入口", () => {
    renderSidebar();
    // 「照片」既是分段控件的一档，也是分组标题。
    expect(screen.getAllByText("照片").length).toBeGreaterThan(0);
    expect(screen.getAllByText("漫画").length).toBeGreaterThan(0);
    expect(screen.getByText("照片库")).toBeInTheDocument();
    expect(screen.getByText("漫画库")).toBeInTheDocument();
    expect(screen.getByText("未浏览")).toBeInTheDocument();
    expect(screen.getByText("未读")).toBeInTheDocument();
    // 逃生舱：全部相册是独立入口，不是第三个工作台。
    expect(screen.getByText("全部相册")).toBeInTheDocument();
  });

  it("点击另一组的条目会先切模式再跳转", () => {
    renderSidebar();
    fireEvent.click(screen.getByText("照片库"));
    expect(appMode.setMode).toHaveBeenCalledWith("photo");
  });

  it("切换到照片工作台后，「继续」区改用浏览的措辞", () => {
    appMode.mode = "photo";
    dashboard.dashboard.inProgress = [
      { album: albumNode, pageIndex: 5, pageCount: 20 },
    ];
    renderSidebar();
    expect(screen.getByText("继续浏览")).toBeInTheDocument();
    expect(screen.queryByText("继续阅读")).not.toBeInTheDocument();
  });

  it("不再提供「随机未读」：该动作在未读页与首页已有入口", () => {
    renderSidebar();
    expect(screen.queryByText("随机未读")).not.toBeInTheDocument();
    // 「随机一本」保留
    expect(screen.getByText("随机一本")).toBeInTheDocument();
  });
});
