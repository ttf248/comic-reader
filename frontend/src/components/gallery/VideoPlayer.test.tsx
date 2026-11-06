import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import VideoPlayer from "./VideoPlayer";
import { getTranscodeStatus } from "../../api/videos";

const { playbackId } = vi.hoisted(() => ({ playbackId: vi.fn() }));

vi.mock("../../api/videos", () => ({
  videoUrl: (fileId: string, token: string) =>
    `/api/media/${fileId}?playback=${token}`,
  createVideoPlaybackId: playbackId,
  getTranscodeStatus: vi.fn(() => new Promise(() => {})),
}));

vi.mock("./TranscodeProgress", () => ({
  default: ({ onReady }: { onReady?: () => void }) => (
    <button onClick={onReady}>模拟转码完成</button>
  ),
}));

describe("VideoPlayer 活动恢复", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let sequence = 0;
    playbackId.mockImplementation(() => `attempt-${++sequence}`);
    vi.mocked(getTranscodeStatus).mockImplementation(
      () => new Promise(() => {}),
    );
  });

  it("元数据就绪后恢复毫秒活动换算的秒位置", async () => {
    const onMetaLoaded = vi.fn();
    const onProgress = vi.fn();
    render(
      <VideoPlayer
        src="f_video"
        initialPositionSec={42.5}
        onMetaLoaded={onMetaLoaded}
        onProgress={onProgress}
      />,
    );

    const video = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: 100,
    });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(42.5);
    expect(onMetaLoaded).toHaveBeenCalledWith(100);

    video.currentTime = 43;
    fireEvent.timeUpdate(video);
    expect(onProgress).toHaveBeenCalledWith(43);
    await waitFor(() =>
      expect(video.getAttribute("src")).toBe(
        "/api/media/f_video?playback=attempt-1-0",
      ),
    );
  });

  it("已完成记录恢复时不精确定位到片尾", () => {
    render(<VideoPlayer src="f_video" initialPositionSec={100} />);
    const video = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: 100,
    });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(99.9);
  });

  it("普通重绘沿用播放 URL，重试和切回同视频使用新 URL", () => {
    const view = render(<VideoPlayer src="f_first" />);
    const first = document.querySelector("video") as HTMLVideoElement;
    const firstURL = first.getAttribute("src");
    view.rerender(<VideoPlayer src="f_first" onProgress={vi.fn()} />);
    expect(first.getAttribute("src")).toBe(firstURL);
    fireEvent.error(first);
    fireEvent.click(view.getByRole("button", { name: /^重试$/ }));
    const retried = document.querySelector("video") as HTMLVideoElement;
    expect(retried).not.toBe(first);
    expect(retried.getAttribute("src")).not.toBe(firstURL);
    const retryURL = retried.getAttribute("src");
    view.rerender(<VideoPlayer src="f_other" />);
    view.rerender(<VideoPlayer src="f_first" />);
    const returnedURL = document.querySelector("video")?.getAttribute("src");
    expect(returnedURL).not.toBe(firstURL);
    expect(returnedURL).not.toBe(retryURL);
  });

  it("转码完成后使用新播放 URL，避免复用原编码缓冲", async () => {
    vi.mocked(getTranscodeStatus)
      .mockResolvedValueOnce({ status: "running", progress: 0.2, etaSec: 0 })
      .mockResolvedValue({ status: "cached", progress: 1, etaSec: 0 });
    const view = render(<VideoPlayer src="f_transcoding" />);
    const originalURL = document.querySelector("video")?.getAttribute("src");
    fireEvent.click(await view.findByRole("button", { name: "模拟转码完成" }));
    await waitFor(() =>
      expect(document.querySelector("video")?.getAttribute("src")).not.toBe(
        originalURL,
      ),
    );
  });

  it("按钮的空格保留给原生激活，不同时控制视频播放", () => {
    const view = render(
      <>
        <button>控件</button>
        <VideoPlayer src="f_video" />
      </>,
    );
    const video = document.querySelector("video") as HTMLVideoElement;
    const play = vi.spyOn(video, "play").mockResolvedValue();
    expect(
      fireEvent.keyDown(view.getByRole("button", { name: "控件" }), {
        key: " ",
      }),
    ).toBe(true);
    expect(play).not.toHaveBeenCalled();
  });

  it("视频获得焦点后按空格只切换一次，不被浏览器的原生切换抵消", () => {
    render(<VideoPlayer src="f_video" />);
    const video = document.querySelector("video") as HTMLVideoElement;
    let paused = true;
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => paused,
    });
    vi.spyOn(video, "play").mockImplementation(() => {
      paused = false;
      return Promise.resolve();
    });
    vi.spyOn(video, "pause").mockImplementation(() => {
      paused = true;
    });

    // keydown：应用切换一次 → 播放
    fireEvent.keyDown(video, { key: " " });
    expect(paused).toBe(false);

    // 浏览器原生激活：焦点在 <video> 上时，空格在 keyup 阶段会再切换一次。
    // jsdom 不实现，这里手动模拟（监听器挂在 video 上，先于 window 冒泡执行）。
    video.addEventListener("keyup", () => {
      paused = !paused;
    });
    fireEvent.keyUp(video, { key: " " });

    // 应用把原生那次切换抵消掉，最终状态仍由应用决定
    expect(paused).toBe(false);
  });

  it("浏览器没有原生切换时空格键的校正不产生额外动作", () => {
    render(<VideoPlayer src="f_video" />);
    const video = document.querySelector("video") as HTMLVideoElement;
    let paused = true;
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => paused,
    });
    const play = vi.spyOn(video, "play").mockImplementation(() => {
      paused = false;
      return Promise.resolve();
    });

    fireEvent.keyDown(video, { key: " " });
    expect(play).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(video, { key: " " });
    expect(paused).toBe(false);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it.each([
    { key: "ArrowRight", ctrlKey: true },
    { key: "ArrowRight", altKey: true },
    { key: "ArrowRight", metaKey: true },
    { key: "ArrowRight", isComposing: true },
  ])("不处理系统组合或输入法事件 %j", (init) => {
    render(<VideoPlayer src="f_video" />);
    const video = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: 100,
    });
    video.currentTime = 20;
    fireEvent.keyDown(window, init);
    expect(video.currentTime).toBe(20);
  });

  it("不处理已经由控件取消的事件，下拉框按键也保持原生行为", () => {
    const view = render(
      <>
        <select aria-label="选项">
          <option>A</option>
        </select>
        <VideoPlayer src="f_video" />
      </>,
    );
    const video = document.querySelector("video") as HTMLVideoElement;
    const play = vi.spyOn(video, "play").mockResolvedValue();
    const handled = new KeyboardEvent("keydown", {
      key: " ",
      cancelable: true,
    });
    handled.preventDefault();
    fireEvent(window, handled);
    fireEvent.keyDown(view.getByRole("combobox"), { key: " " });
    expect(play).not.toHaveBeenCalled();
  });
});

// 调用方传的 className 只补充尺寸，不能把定位与居中顶掉：
// 照片侧大图预览传 "h-full w-full" 时，视频曾贴在画布左上角，
// 转码遮罩则跑到整块画布正中，两者对不上。
describe("VideoPlayer 容器样式", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    playbackId.mockImplementation(() => "attempt-1");
    vi.mocked(getTranscodeStatus).mockImplementation(
      () => new Promise(() => {}),
    );
  });

  it("传了 className 仍保留相对定位与居中", () => {
    const view = render(
      <VideoPlayer src="f_video" className="h-full w-full" />,
    );
    const root = view.container.firstElementChild as HTMLElement;
    expect(root.className).toContain("relative");
    expect(root.className).toContain("items-center");
    expect(root.className).toContain("justify-center");
    expect(root.className).toContain("h-full");
    expect(root.className).toContain("w-full");
  });

  it("不传 className 时用默认的满高容器", () => {
    const view = render(<VideoPlayer src="f_video" />);
    const root = view.container.firstElementChild as HTMLElement;
    expect(root.className).toContain("flex-1");
    expect(root.className).toContain("bg-black");
  });
});
