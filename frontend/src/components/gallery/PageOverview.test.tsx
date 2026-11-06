import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import PageOverview from "./PageOverview";

// Virtuoso 在 jsdom 里量不出高度，网格不会渲染；这里把它摊平成普通列表。
interface VirtualizedProps {
  data: readonly unknown[];
  itemContent: (index: number, item: never) => ReactNode;
}

vi.mock("react-virtuoso", () => ({
  Virtuoso: ({ data, itemContent }: VirtualizedProps) => (
    <div data-testid="virtual-list">
      {data.map((row: unknown, index: number) => (
        <div key={index}>{itemContent(index, row as never)}</div>
      ))}
    </div>
  ),
}));

const thumbUrl = vi.hoisted(() => vi.fn((id: string) => `/thumb/${id}`));

vi.mock("../../api/thumbs", () => ({ thumbUrl }));

function renderOverview(props: Partial<React.ComponentProps<typeof PageOverview>> = {}) {
  const onJump = vi.fn();
  const onClose = vi.fn();
  render(
    <PageOverview
      images={["f1", "f2", "f3"]}
      index={1}
      onJump={onJump}
      onClose={onClose}
      {...props}
    />,
  );
  return { onJump, onClose };
}

describe("PageOverview", () => {
  it("标出当前页并能跳到别的页", () => {
    const { onJump } = renderOverview({ index: 1 });

    const current = screen.getByRole("button", { name: "跳到第 2 页" });
    expect(current).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByRole("button", { name: "跳到第 1 页" }),
    ).not.toHaveAttribute("aria-current");

    fireEvent.click(screen.getByRole("button", { name: "跳到第 3 页" }));
    expect(onJump).toHaveBeenCalledWith(2);
  });

  it("缩略图取不到时留一块页形记号，不留空格子", () => {
    renderOverview();

    const failed = screen
      .getByRole("button", { name: "跳到第 1 页" })
      .querySelector("img");
    expect(failed).not.toBeNull();
    fireEvent.error(failed!);

    // 失败的缩略图撤掉，底下的页形记号接管。
    expect(
      screen.getByRole("button", { name: "跳到第 1 页" }).querySelector("img"),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "跳到第 2 页" }).querySelector("img"))
      .not.toBeNull();
  });

  it("页头写明页数与关闭方式", () => {
    renderOverview();

    expect(screen.getByText("共 3 页")).toBeInTheDocument();
    expect(screen.getByText("T / Esc 关闭")).toBeInTheDocument();
  });
});
