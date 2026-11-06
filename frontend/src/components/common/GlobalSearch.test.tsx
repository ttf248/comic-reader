import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GlobalSearch from "./GlobalSearch";
import { albumsApi } from "../../api/albums";
import { useSearchStore } from "../../store/searchStore";

vi.mock("../../api/albums", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/albums")>();
  return {
    ...actual,
    albumsApi: { ...actual.albumsApi, search: vi.fn() },
  };
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderSearch() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <GlobalSearch />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("GlobalSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSearchStore.getState().reset();
  });

  it("搜索框有可访问名称", () => {
    renderSearch();
    expect(
      screen.getByRole("combobox", { name: "搜索相册或标签" }),
    ).toBeInTheDocument();
  });

  it("在请求完成后显示建议，并可用键盘选择标签页", async () => {
    vi.mocked(albumsApi.search).mockResolvedValue({
      ok: true,
      count: 2,
      results: [
        { kind: "album", path: "a_trip", name: "旅行册", count: 12 },
        {
          kind: "smartCollection",
          path: "smart:旅行",
          name: "旅行",
          count: 1,
        },
      ],
    });
    renderSearch();
    const input = screen.getByRole("combobox");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "旅行" } });

    await waitFor(() => expect(albumsApi.search).toHaveBeenCalledWith("旅行", "photo", 10));
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /旅行册/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByTestId("location")).toHaveTextContent("/tags/%E6%97%85%E8%A1%8C");
  });

  it("搜索结果的计数单位跟着当前工作台走", async () => {
    vi.mocked(albumsApi.search).mockResolvedValue({
      ok: true,
      count: 2,
      results: [
        { kind: "album", path: "a_trip", name: "旅行册", count: 12 },
        { kind: "collection", path: "c_trip", name: "旅行", count: 3 },
      ],
    });
    renderSearch();
    const input = screen.getByRole("combobox");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "旅行" } });

    // 照片工作台：相册按「张」，集合按「本」。
    expect(await screen.findByText("12 张")).toBeInTheDocument();
    expect(screen.getByText("3 本相册")).toBeInTheDocument();
    expect(screen.queryByText(/卷/)).not.toBeInTheDocument();
  });

  it("在建议请求尚未结束时不误报无结果", async () => {
    let resolveSearch: ((value: {
      ok: boolean;
      count: number;
      results: [];
    }) => void) | undefined;
    vi.mocked(albumsApi.search).mockReturnValue(
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
    );
    renderSearch();
    const input = screen.getByRole("combobox");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "春天" } });

    expect(await screen.findByText("搜索中…")).toBeInTheDocument();
    expect(screen.queryByText(/没有匹配/)).not.toBeInTheDocument();

    resolveSearch?.({ ok: true, count: 0, results: [] });
    expect(await screen.findByText(/没有匹配「春天」/)).toBeInTheDocument();
  });
});
