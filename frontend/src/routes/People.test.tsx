import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import People from "./People";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  people: vi.fn(),
  clearPeople: vi.fn(),
}));

vi.mock("../api/aiJobs", () => ({
  aiJobsApi: {
    list: mocks.list,
    people: mocks.people,
    clearPeople: mocks.clearPeople,
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
});
