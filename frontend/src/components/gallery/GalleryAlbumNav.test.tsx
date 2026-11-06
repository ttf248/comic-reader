import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import GalleryAlbumNav from "./GalleryAlbumNav";

it("跨卷导航用「卷」的说法，并给出目标卷名", () => {
  render(
    <GalleryAlbumNav
      visible
      onPrevAlbum={() => {}}
      onNextAlbum={() => {}}
      prevLabel="2015年09月"
      nextLabel="2015年10月"
    />,
  );

  const prev = screen.getByRole("button", { name: /上一卷/ });
  const next = screen.getByRole("button", { name: /下一卷/ });
  expect(prev).toHaveAttribute("aria-label", "上一卷 (P)：2015年09月");
  expect(next).toHaveAttribute("aria-label", "下一卷 (N)：2015年10月");
  // 目标卷名浮在箭头旁边，平时不占画面。
  expect(screen.getByText("2015年09月")).toBeInTheDocument();
  expect(screen.getByText("2015年10月")).toBeInTheDocument();
});

it("没有上下文时不渲染任何按钮", () => {
  render(<GalleryAlbumNav visible />);
  expect(screen.queryByRole("button")).toBeNull();
});
