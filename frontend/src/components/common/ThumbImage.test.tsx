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

  it("服务端判定无法解码时不发请求，直接写明原因", () => {
    render(
      <ThumbImage
        fileId="f_broken"
        alt="照片0067.jpg"
        undecodable
        displayWidth={320}
      />,
    );
    // 不渲染 img：请求渲染图必然失败，没必要再打一次。
    expect(screen.queryByAltText("照片0067.jpg")).toBeNull();
    const placeholder = screen.getByRole("img", {
      name: "照片0067.jpg（无法解码）",
    });
    expect(placeholder.tagName).not.toBe("IMG");
    expect(screen.getByText("无法解码")).toBeInTheDocument();
  });

  it("小槽位不写文字，只留图标与无障碍说明", () => {
    render(
      <ThumbImage
        fileId="f_broken"
        alt="缩略图"
        undecodable
        displayWidth={48}
      />,
    );
    expect(screen.queryByText("无法解码")).toBeNull();
    expect(
      screen.getByRole("img", { name: "缩略图（无法解码）" }),
    ).toBeInTheDocument();
  });
});
