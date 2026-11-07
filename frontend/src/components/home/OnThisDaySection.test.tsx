import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import OnThisDaySection from "./OnThisDaySection";
import { useFavorites } from "../../hooks/useFavorites";
import type { LibraryOnThisDayItem } from "../../api/library";

vi.mock("../../hooks/useFavorites", () => ({
  useFavorites: vi.fn(),
  useToggleFavorite: () => ({ mutate: vi.fn(), isPending: false }),
}));

function makeItem(
  id: string,
  name: string,
  matchedDate: string,
): LibraryOnThisDayItem {
  return {
    id,
    kind: "album",
    name,
    displayName: name,
    imageCount: 12,
    coverImages: [],
    contentKind: "photo",
    matchedDate,
  };
}

function renderSection(items: LibraryOnThisDayItem[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OnThisDaySection
          items={items}
          month={11}
          day={7}
          sectionIndex="01"
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("那年今日", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useFavorites).mockReturnValue({
      favorites: [],
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
      add: vi.fn(),
      remove: vi.fn(),
      toggle: vi.fn(),
    });
  });

  it("摆出命中的相册，并写清是哪一天", () => {
    renderSection([
      makeItem("a_1", "2024年", "2024-11-07"),
      makeItem("a_2", "2021年", "2021-11-07"),
    ]);
    const section = screen.getByTestId("on-this-day-section");
    expect(section.textContent).toContain("那年今日");
    expect(section.textContent).toContain("11 月 7 日");
    // 命中的那一天写在卡片上：相册的代表日期未必是今天这个月日。
    expect(section.textContent).toContain("2024 年 11 月 7 日");
    expect(section.textContent).toContain("2021 年 11 月 7 日");
    expect(section.textContent).toContain("2 本相册");
  });

  it("没有命中时不占地方", () => {
    renderSection([]);
    expect(screen.queryByTestId("on-this-day-section")).toBeNull();
  });
});
