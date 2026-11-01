import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureVideoFrame } from "./videoFrame";

let video: HTMLVideoElement;
let canvas: HTMLCanvasElement;
let load: ReturnType<typeof vi.fn>;
let draw: ReturnType<typeof vi.fn>;
let encode: (callback: BlobCallback) => void;
const jpeg = new Blob(["jpeg"], { type: "image/jpeg" });

beforeEach(() => {
  vi.useFakeTimers();
  video = document.createElement("video");
  canvas = document.createElement("canvas");
  load = vi.fn();
  draw = vi.fn();
  encode = (callback) => callback(jpeg);
  Object.defineProperties(video, {
    duration: { configurable: true, value: 2 },
    readyState: { configurable: true, value: 2 },
    videoWidth: { value: 3840 },
    videoHeight: { value: 2160 },
    load: { value: load },
  });
  Object.defineProperties(canvas, {
    getContext: { value: () => ({ drawImage: draw }) },
    toBlob: { value: (callback: BlobCallback) => encode(callback) },
  });
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
    if (tag === "video") return video;
    if (tag === "canvas") return canvas;
    return createElement(tag, options);
  });
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function seekFrame() {
  video.dispatchEvent(new Event("loadedmetadata"));
  video.dispatchEvent(new Event("seeked"));
}

it("直接使用媒体 URL，抽取限宽 JPEG 后释放解码器和 canvas", async () => {
  const result = captureVideoFrame("f_clip");
  const url = new URL(video.src);
  expect(url.pathname).toBe("/api/media/f_clip");
  expect(url.searchParams.get("playback")).toBeTruthy();
  expect(video.preload).toBe("metadata");
  seekFrame();
  await expect(result).resolves.toBe(jpeg);
  expect(fetch).not.toHaveBeenCalled();
  expect(draw).toHaveBeenCalledWith(video, 0, 0, 1920, 1080);
  expect(video.hasAttribute("src")).toBe(false);
  expect(load).toHaveBeenCalledTimes(1);
  expect(canvas.width).toBe(0);
  expect(canvas.height).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("短视频定位在片尾之前", async () => {
  Object.defineProperty(video, "duration", { value: 0.25 });
  const result = captureVideoFrame("f_short");
  video.dispatchEvent(new Event("loadedmetadata"));
  expect(video.currentTime).toBeCloseTo(0.15);
  video.dispatchEvent(new Event("seeked"));
  await expect(result).resolves.toBe(jpeg);
});

it("连续抽帧使用独立播放 URL", async () => {
  const controller = new AbortController();
  const first = captureVideoFrame("f_updated", controller.signal);
  const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
  const firstURL = video.getAttribute("src");
  controller.abort();
  await rejected;
  const second = captureVideoFrame("f_updated");
  expect(video.getAttribute("src")).not.toBe(firstURL);
  seekFrame();
  await expect(second).resolves.toBe(jpeg);
});

it("时长不可用时等待第 0 帧数据再绘制", async () => {
  Object.defineProperty(video, "duration", { value: NaN });
  Object.defineProperty(video, "readyState", { value: 1, configurable: true });
  const result = captureVideoFrame("f_unknown");
  video.dispatchEvent(new Event("loadedmetadata"));
  expect(draw).not.toHaveBeenCalled();
  Object.defineProperty(video, "readyState", { value: 2 });
  video.dispatchEvent(new Event("loadeddata"));
  await expect(result).resolves.toBe(jpeg);
});

it.each(["loading", "encoding"])(
  "%s 时取消会释放视频且忽略迟到结果",
  async (phase) => {
    const controller = new AbortController();
    let encoded: BlobCallback | undefined;
    encode = (callback) => {
      encoded = callback;
    };
    const result = captureVideoFrame("f_cancel", controller.signal);
    const assertion = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    if (phase === "encoding") seekFrame();
    controller.abort();
    await assertion;
    encoded?.(jpeg);
    expect(video.hasAttribute("src")).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("无媒体事件时在 30 秒后清理并报错", async () => {
  const result = captureVideoFrame("f_timeout");
  const assertion = expect(result).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(30_000);
  await assertion;
  expect(video.hasAttribute("src")).toBe(false);
  expect(load).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("解码失败后清理监听，迟到事件不再绘制", async () => {
  const result = captureVideoFrame("f_bad");
  const assertion = expect(result).rejects.toThrow("video load error");
  video.dispatchEvent(new Event("error"));
  await assertion;
  seekFrame();
  expect(draw).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("canvas 编码失败也会释放资源", async () => {
  encode = (callback) => callback(null);
  const result = captureVideoFrame("f_canvas_error");
  const assertion = expect(result).rejects.toThrow("canvas.toBlob");
  seekFrame();
  await assertion;
  expect(canvas.width).toBe(0);
  expect(load).toHaveBeenCalledTimes(1);
});
