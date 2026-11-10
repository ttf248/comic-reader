import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PhotoCompare from "./PhotoCompare";

vi.mock("../../api/images", () => ({
  previewUrl: (id: string, width: number) => `/api/previews/${id}?w=${width}`,
}));

const left = {
  id: "f_left",
  name: "left.jpg",
  width: 4000,
  height: 3000,
  albumName: "旅行",
};
const right = {
  id: "f_right",
  name: "right.jpg",
  width: 3000,
  height: 4000,
  albumName: "旅行",
};

describe("并排对比", () => {
  it("两侧同时摆出来，各自带文件名与尺寸", () => {
    render(
      <PhotoCompare left={left} right={right} onClose={() => {}} onSwap={() => {}} />,
    );

    expect(screen.getByTestId("photo-compare")).toBeInTheDocument();
    expect(screen.getByText("left.jpg")).toBeInTheDocument();
    expect(screen.getByText("right.jpg")).toBeInTheDocument();
    expect(screen.getByText("4000×3000")).toBeInTheDocument();
    expect(screen.getByText("3000×4000")).toBeInTheDocument();
  });

  it("两侧共用一个缩放倍数：要比的是同一档放大下的细节", () => {
    render(
      <PhotoCompare left={left} right={right} onClose={() => {}} onSwap={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    // 只有一处读数：两侧共用一个缩放倍数，不会各缩各的。
    expect(screen.getAllByText("150%")).toHaveLength(1);
  });

  it("交换左右", () => {
    const onSwap = vi.fn();
    render(
      <PhotoCompare left={left} right={right} onClose={() => {}} onSwap={onSwap} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /交换/ }));
    expect(onSwap).toHaveBeenCalled();
  });

  it("Esc 关闭", () => {
    const onClose = vi.fn();
    render(
      <PhotoCompare left={left} right={right} onClose={onClose} onSwap={() => {}} />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("在精选里的那张标出「精选」", () => {
    render(
      <PhotoCompare
        left={left}
        right={right}
        leftPicked
        onClose={() => {}}
        onSwap={() => {}}
      />,
    );

    expect(screen.getByText("精选")).toBeInTheDocument();
  });
});
