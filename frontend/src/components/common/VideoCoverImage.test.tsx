import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import VideoCoverImage from "./VideoCoverImage";

const useVideoCover = vi.fn();

vi.mock("../../hooks/useVideoCover", () => ({
  useVideoCover: (...args: unknown[]) => useVideoCover(...args),
}));

describe("VideoCoverImage", () => {
  beforeEach(() => {
    useVideoCover.mockReset();
  });

  it("封面就绪后按 contain 展示完整画面，不裁切视频帧", async () => {
    useVideoCover.mockReturnValue({
      status: "ready",
      url: "/api/thumbs/f_1",
      retry: vi.fn(),
      enabled: true,
    });

    render(<VideoCoverImage videoPath="f_1" alt="示例视频" />);

    const img = await screen.findByAltText("示例视频");
    // 视频抽帧保持原始宽高比（16:9 等），网格是 3:4 的竖框；
    // 用 cover 会把画面裁掉一大半，只能看到中间一条。
    expect(img).toHaveClass("object-contain");
    expect(img).not.toHaveClass("object-cover");
  });

  it("抽帧失败时给出可重试的提示", async () => {
    useVideoCover.mockReturnValue({
      status: "error",
      url: "",
      retry: vi.fn(),
      enabled: true,
    });

    render(<VideoCoverImage videoPath="f_1" alt="示例视频" />);

    expect(await screen.findByText("封面生成失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("未启用时不渲染图片", async () => {
    useVideoCover.mockReturnValue({
      status: "idle",
      url: "",
      retry: vi.fn(),
      enabled: false,
    });

    const { container } = render(
      <VideoCoverImage videoPath="" alt="示例视频" />,
    );

    await waitFor(() => {
      expect(container.querySelector("img")).toBeNull();
    });
  });
});
