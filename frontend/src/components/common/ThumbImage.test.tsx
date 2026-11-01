import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ThumbImage from "./ThumbImage";

describe("ThumbImage", () => {
  it("加载失败时显示占位图而不是破图", () => {
    render(<ThumbImage fileId="f_1" alt="第 1 张" />);
    const img = screen.getByAltText("第 1 张");
    expect(img.tagName).toBe("IMG");

    fireEvent.error(img);

    // 破图图标被替换成占位图（role=img + 同样的 aria-label）。
    const placeholder = screen.getByRole("img", { name: "第 1 张" });
    expect(placeholder.tagName).not.toBe("IMG");
    expect(screen.queryByRole("img", { name: "第 1 张" })).toBeInTheDocument();
  });

  it("正常加载时渲染图片", () => {
    render(<ThumbImage fileId="f_1" alt="封面" />);
    expect(screen.getByAltText("封面").tagName).toBe("IMG");
  });
});
