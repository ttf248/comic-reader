import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
  photo?: LibraryOnThisDayItem["photo"],
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
    photo,
  };
}

function makePhoto(id: string, name: string, date: string) {
  return {
    id,
    kind: "image" as const,
    name,
    index: 0,
    kindIndex: 0,
    date,
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

  it("摆的是那一天的那张照片，不是相册的通用封面", () => {
    renderSection([
      makeItem("a_1", "2024年", "2024-11-07", makePhoto("f_1", "IMG_1.jpg", "2024-11-07")),
      makeItem("a_2", "2021年", "2021-11-07", makePhoto("f_2", "IMG_2.jpg", "2021-11-07")),
    ]);
    const section = screen.getByTestId("on-this-day-section");
    expect(section.textContent).toContain("那年今日");
    expect(section.textContent).toContain("11 月 7 日");
    // 命中的那一天写在卡片上：相册的代表日期未必是今天这个月日。
    expect(section.textContent).toContain("2024 年 11 月 7 日");
    expect(section.textContent).toContain("2021 年 11 月 7 日");
    // 有照片证据时数照片。
    expect(section.textContent).toContain("往年这天拍过 2 张");
    // 摆的是照片卡，不是相册卡。
    expect(screen.getAllByTestId("on-this-day-photo")).toHaveLength(2);
    expect(screen.queryByTestId("album-card")).toBeNull();
  });

  it("点照片直接看那一张，标题能回到原相册", () => {
    renderSection([
      makeItem("a_1", "2024年", "2024-11-07", makePhoto("f_1", "IMG_1.jpg", "2024-11-07")),
    ]);
    fireEvent.click(
      screen.getByRole("button", { name: /查看 2024 年 11 月 7 日/ }),
    );
    const viewer = screen.getByTestId("photo-viewer");
    expect(viewer.textContent).toContain("2024年");
    const link = within(viewer).getByRole("link", { name: "2024年" });
    expect(link.getAttribute("href")).toBe("/photo/albums/a_1");
  });

  it("没有日期证据时不摆照片，也不假装封面就是那天拍的", () => {
    renderSection([makeItem("a_1", "2024年", "2024-11-07")]);
    expect(screen.queryByTestId("on-this-day-photo")).toBeNull();
    // 退回相册卡，并说明是这本相册在那天拍过照。
    expect(screen.getByTestId("album-card")).toBeTruthy();
    expect(screen.getByTestId("on-this-day-section").textContent).toContain(
      "2024 年 11 月 7 日 拍过",
    );
  });

  it("没有命中时不占地方", () => {
    renderSection([]);
    expect(screen.queryByTestId("on-this-day-section")).toBeNull();
  });
});
