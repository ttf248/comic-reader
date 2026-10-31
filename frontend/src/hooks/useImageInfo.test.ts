import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { imageInfoApi, type ImageInfo } from "../api/imageInfo";
import { useImageInfo } from "./useImageInfo";

vi.mock("../api/imageInfo", () => ({ imageInfoApi: { get: vi.fn() } }));
const first: ImageInfo = {
  path: "f_first",
  name: "首图.png",
  dir: "素材",
  size: 10,
  mtime: "",
  width: 1,
  height: 2,
  format: "png",
  checksum: "one",
};
const second: ImageInfo = { ...first, path: "f_second", name: "次图.png" };
beforeEach(() => vi.resetAllMocks());

it("切换文件时清除旧属性，直到新文件加载完成", async () => {
  let finish!: (info: ImageInfo) => void;
  vi.mocked(imageInfoApi.get)
    .mockResolvedValueOnce(first)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
  const { result, rerender } = renderHook(({ id }) => useImageInfo(id), {
    initialProps: { id: first.path },
  });
  await waitFor(() => expect(result.current.info).toEqual(first));
  rerender({ id: second.path });
  expect(result.current.info).toBeNull();
  expect(result.current.loading).toBe(true);
  await act(async () => finish(second));
  expect(result.current.info).toEqual(second);
});

it("失败后可以重新请求当前文件", async () => {
  vi.mocked(imageInfoApi.get)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(first);
  const { result } = renderHook(() => useImageInfo(first.path));
  await waitFor(() => expect(result.current.err).toBe("offline"));
  act(() => result.current.refetch());
  await waitFor(() => expect(result.current.info).toEqual(first));
  expect(result.current.err).toBeNull();
  expect(imageInfoApi.get).toHaveBeenCalledTimes(2);
});

it("延迟返回的旧文件不会覆盖新文件", async () => {
  let finish!: (info: ImageInfo) => void;
  vi.mocked(imageInfoApi.get)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValueOnce(second);
  const { result, rerender } = renderHook(({ id }) => useImageInfo(id), {
    initialProps: { id: first.path },
  });
  rerender({ id: second.path });
  await waitFor(() => expect(result.current.info).toEqual(second));
  await act(async () => finish(first));
  expect(result.current.info).toEqual(second);
});
