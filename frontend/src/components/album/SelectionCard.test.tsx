import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import SelectionCard from "./SelectionCard";

vi.mock("./CardCover", () => ({ default: () => <span>封面</span> }));
it("选择卡片只切换选择，不包含相册导航或收藏动作", () => {
  const toggle = vi.fn();
  const { container, rerender } = render(
    <SelectionCard
      card={{
        id: "a_one",
        variant: "album",
        title: "第一卷",
        count: 3,
        contentKind: "comic",
        coverPath: "",
        to: "/comic/albums/a_one",
      }}
      checked={false}
      busy={false}
      ratio="4/5"
      variant="grid"
      onToggle={toggle}
    />,
  );
  const checkbox = screen.getByRole("checkbox", { name: "选择“第一卷”" });
  expect(checkbox).toHaveAttribute("aria-checked", "false");
  expect(container.querySelector("a")).toBeNull();
  fireEvent.click(checkbox);
  expect(toggle).toHaveBeenCalledOnce();
  rerender(
    <SelectionCard
      card={{
        id: "a_one",
        variant: "album",
        title: "第一卷",
        count: 3,
        coverPath: "",
        to: "/comic/albums/a_one",
      }}
      checked
      busy
      ratio="4/5"
      variant="list"
      onToggle={toggle}
    />,
  );
  expect(screen.getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("checkbox")).toBeDisabled();
});
