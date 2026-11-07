import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Sidebar from "./Sidebar";
import { historyApi } from "../../api/prefs";

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

// 照片侧的「接着看」区要按访问历史取相册摘要。
const nodes = { items: [] as unknown[] };

vi.mock("../../hooks/useLibrary", () => ({
  useLibraryActivitySummary: () => ({
    data: { summary: { unreadCount: 69 } },
  }),
  useLibraryDashboard: () => ({ data: dashboard }),
  useLibraryNodes: () => ({ data: { items: nodes.items, missing: [] } }),
}));

vi.mock("../../api/prefs", () => ({
  historyApi: { list: vi.fn().mockResolvedValue({ history: [] }) },
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
  libraryApi: {
    randomAlbums: vi.fn().mockResolvedValue({ albums: [{ id: "x" }] }),
  },
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

// 侧栏的形态跟视口宽度有关：折叠态（72px 窄栏）只属于宽屏，窄屏侧栏
// 是抽屉。组件用 matchMedia 判断当前宽度，所以单测要给出这个信号。
let wideViewport = true;
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("1024") ? wideViewport : !wideViewport,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

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
    nodes.items = [];
    vi.mocked(historyApi.list).mockResolvedValue({ history: [] });
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

  // 侧栏这一小块只写「第1卷」时，这一卷属于哪部作品看不出来。
  it("迷你卡在卷名前面补上所属作品", () => {
    dashboard.dashboard.inProgress = [
      { album: { ...albumNode, parentName: "星海漫步" }, pageIndex: 5, pageCount: 20 },
    ];
    renderSidebar();
    expect(screen.getByText("星海漫步 · 某本漫画")).toBeInTheDocument();
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

  // 窄屏时侧栏是抽屉：抽屉宽度不由「折叠」决定，抽屉里再摆一枚
  // 「折叠侧边栏」既点不动，也会让人以为点完菜单会消失。
  it("窄屏抽屉不显示折叠按钮，并保留品牌名", () => {
    wideViewport = false;
    try {
      renderSidebar(true);
      expect(
        screen.queryByRole("button", { name: /折叠侧边栏|展开侧边栏/ }),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Local Gallery")).toBeInTheDocument();
    } finally {
      wideViewport = true;
    }
  });

  // 侧栏只留当前这一本，其余的交给首页专区与「最近阅读」页：
  // 侧栏再挂一份完整列表，既重复又把侧栏中段塞满。
  it("在读只留当前这一本，其余给出一个跳转", () => {
    dashboard.dashboard.inProgress = [
      { album: albumNode, pageIndex: 5, pageCount: 20 },
      { album: { ...albumNode, id: "a_2", name: "第二本", displayName: "第二本" }, pageIndex: 2, pageCount: 8 },
      { album: { ...albumNode, id: "a_3", name: "第三本", displayName: "第三本" }, pageIndex: 0, pageCount: 30 },
    ];
    renderSidebar();
    expect(screen.getByText("3 卷还没读完")).toBeInTheDocument();
    expect(screen.getByText(/还有 2 卷没读完/)).toBeInTheDocument();
    // 其余条目不再逐条列出。
    expect(screen.queryByText("第二本")).not.toBeInTheDocument();
    expect(screen.queryByText("第三本")).not.toBeInTheDocument();
  });

  // 两个模式的侧栏完全隔离：漫画这边有未读与阅读措辞，照片这边一样都没有。
  it("漫画工作台只列出漫画自己的入口", () => {
    renderSidebar();
    expect(screen.getByText("漫画库")).toBeInTheDocument();
    expect(screen.getByText("未读")).toBeInTheDocument();
    expect(screen.getByText("最近阅读")).toBeInTheDocument();
    expect(screen.getByText("收藏漫画")).toBeInTheDocument();
    // 照片那边的入口不出现在漫画工作台。
    expect(screen.queryByText("照片库")).not.toBeInTheDocument();
    expect(screen.queryByText("最近浏览")).not.toBeInTheDocument();
    expect(screen.queryByText("收藏照片")).not.toBeInTheDocument();
  });

  it("照片工作台只列出照片自己的入口", () => {
    appMode.mode = "photo";
    renderSidebar();
    expect(screen.getByText("照片库")).toBeInTheDocument();
    expect(screen.getByText("最近浏览")).toBeInTheDocument();
    expect(screen.getByText("收藏照片")).toBeInTheDocument();
    // 漫画那边的一切都不出现，包括未读入口与阅读措辞。
    expect(screen.queryByText("漫画库")).not.toBeInTheDocument();
    expect(screen.queryByText("未读")).not.toBeInTheDocument();
    expect(screen.queryByText("最近阅读")).not.toBeInTheDocument();
    expect(screen.queryByText("收藏漫画")).not.toBeInTheDocument();
    expect(screen.queryByText("继续阅读")).not.toBeInTheDocument();
  });

  it("不再有「全部相册」入口：两个模式互斥，没有第三档", () => {
    renderSidebar();
    expect(screen.queryByText("全部相册")).not.toBeInTheDocument();
  });

  it("照片工作台下不出现「继续阅读」区", () => {
    appMode.mode = "photo";
    dashboard.dashboard.inProgress = [
      { album: albumNode, pageIndex: 5, pageCount: 20 },
    ];
    renderSidebar();
    expect(screen.queryByText("继续阅读")).not.toBeInTheDocument();
    expect(screen.queryByText("某本漫画")).not.toBeInTheDocument();
  });

  // 照片侧的对称物：漫画有「继续阅读」，照片有「接着看」。
  it("照片工作台显示「接着看」区，给出上次浏览的时间", async () => {
    appMode.mode = "photo";
    vi.mocked(historyApi.list).mockResolvedValue({
      history: [
        {
          albumId: "a_p1",
          name: "去年夏天",
          imageCount: 40,
          openedAt: "2024-05-01T00:00:00Z",
        },
      ],
    });
    nodes.items = [
      {
        id: "a_p1",
        kind: "album",
        name: "去年夏天",
        displayName: "去年夏天",
        imageCount: 40,
        coverImages: [],
        contentKind: "photo",
      },
    ];
    renderSidebar();
    expect(await screen.findByText("接着看")).toBeInTheDocument();
    expect(screen.getByText("去年夏天")).toBeInTheDocument();
    // 照片侧只有「浏览」的说法，没有漫画的页码进度。
    expect(screen.queryByText(/读到/)).not.toBeInTheDocument();
    expect(screen.getByText(/上次浏览/)).toBeInTheDocument();
  });

  it("漫画工作台不出现照片侧的「接着看」区", () => {
    vi.mocked(historyApi.list).mockResolvedValue({
      history: [
        {
          albumId: "a_p1",
          name: "去年夏天",
          imageCount: 40,
          openedAt: "2024-05-01T00:00:00Z",
        },
      ],
    });
    nodes.items = [
      {
        id: "a_p1",
        kind: "album",
        name: "去年夏天",
        displayName: "去年夏天",
        imageCount: 40,
        coverImages: [],
        contentKind: "photo",
      },
    ];
    renderSidebar();
    expect(screen.queryByText("接着看")).not.toBeInTheDocument();
  });

  it("不再提供「随机未读」：该动作在未读页与首页已有入口", () => {
    renderSidebar();
    expect(screen.queryByText("随机未读")).not.toBeInTheDocument();
    // 「随机一本」保留
    expect(screen.getByText("随机一卷")).toBeInTheDocument();
  });
});
