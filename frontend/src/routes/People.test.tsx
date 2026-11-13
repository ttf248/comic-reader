import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import People from "./People";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  people: vi.fn(),
  clearPeople: vi.fn(),
  personMedia: vi.fn(),
}));

vi.mock("../api/aiJobs", () => ({
  aiJobsApi: {
    list: mocks.list,
    people: mocks.people,
    clearPeople: mocks.clearPeople,
    personMedia: mocks.personMedia,
    updatePerson: vi.fn(),
    mergePeople: vi.fn(),
    splitPerson: vi.fn(),
  },
}));

function renderPeople() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/photo/people"]}>
        <Routes>
          <Route path="/photo/people/:personId?" element={<People />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("人物相册", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({
      ok: true,
      snapshot: { settings: { peopleEnabled: false } },
    });
    mocks.people.mockResolvedValue({
      ok: true,
      people: [],
      groupingLimited: false,
      threshold: 0.363,
      revision: 1,
    });
    mocks.clearPeople.mockResolvedValue({ ok: true, cleared: true });
  });

  it("未启用时说明人物分析默认关闭并引导到任务中心", async () => {
    renderPeople();
    expect(await screen.findByText("人物分析默认关闭")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开任务中心" })).toHaveAttribute(
      "href",
      "/tasks",
    );
  });

  it("展示候选组照片数与脸部数", async () => {
    mocks.people.mockResolvedValue({
      ok: true,
      people: [
        {
          id: "p_123456",
          name: "旅行同伴",
          faceCount: 3,
          photoCount: 2,
          hidden: false,
        },
      ],
      groupingLimited: false,
      threshold: 0.363,
      revision: 2,
    });
    renderPeople();

    expect(await screen.findByText("旅行同伴")).toBeInTheDocument();
    expect(screen.getByText(/3\s*张脸/)).toBeInTheDocument();
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === "SPAN" &&
          element.textContent?.replace(/\s+/g, "") === "2张",
      ),
    ).toBeInTheDocument();
  });

  it("说明列表仅展示照片数最多的前50组", async () => {
    mocks.people.mockResolvedValue({
      ok: true,
      people: Array.from({ length: 50 }, (_, index) => ({
        id: `p_${String(index).padStart(6, "0")}`,
        name: `人物 ${index}`,
        faceCount: index + 1,
        photoCount: 100 - index,
        hidden: false,
      })),
      totalGroups: 83,
      limit: 50,
      groupingLimited: false,
      threshold: 0.363,
      revision: 3,
    });
    renderPeople();

    expect(
      await screen.findByText(/照片数最多的 50 \/ 共 83 组 · 按照片数排序/),
    ).toBeInTheDocument();
    expect(screen.getByText("人物 0")).toBeInTheDocument();
    expect(screen.getByText("人物 49")).toBeInTheDocument();
  });

  it("人物相册的拆分列表分批显示已加载人脸", async () => {
    mocks.personMedia.mockResolvedValue({
      ok: true,
      page: {
        revision: 3,
        person: {
          id: "p_123456",
          name: "大组",
          faceCount: 205,
          photoCount: 0,
          hidden: false,
        },
        items: [],
        faces: Array.from({ length: 205 }, (_, index) => ({
          key: `r${index}#0`,
          resourceId: `r${index}`,
          faceIndex: 0,
          personId: "p_123456",
          box: [0, 0, 1, 1],
          score: 0.9,
        })),
        total: 0,
      },
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/photo/people/p_123456"]}>
          <Routes>
            <Route path="/photo/people/:personId?" element={<People />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(
      await screen.findByText("拆分选中的人脸（当前已加载照片）"),
    );
    expect(screen.getAllByRole("checkbox")).toHaveLength(200);
    fireEvent.click(screen.getByRole("button", { name: /继续显示 5 张脸/ }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(205);
  });
});
