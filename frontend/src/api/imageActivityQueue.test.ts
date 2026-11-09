import { expect, it, vi } from "vitest";
import { ImageActivityQueue } from "./imageActivityQueue";
import type { ActivityInput, ImageActivity } from "./activity";

const input = (pageIndex: number, albumId = "a_1") => ({
  albumId,
  mediaKind: "image" as const,
  pageIndex,
  pageCount: 10,
});
const result = (
  value: Extract<ActivityInput, { mediaKind: "image" }>,
): ImageActivity => ({
  ...value,
  status: "in_progress",
  updated: "2026-01-01T00:00:00Z",
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("只发送正在进行和最后待发送的进度，合并调用者等待同一确认", async () => {
  const first = deferred<ImageActivity>();
  const send = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementation(async (value) => result(value));
  const queue = new ImageActivityQueue(send);
  const a = queue.progress(input(0));
  const b = queue.progress(input(1));
  const c = queue.progress(input(2));
  expect(send).toHaveBeenCalledTimes(1);
  first.resolve(result(input(0)));
  await expect(a).resolves.toMatchObject({ pageIndex: 0 });
  await expect(b).resolves.toMatchObject({ pageIndex: 2 });
  await expect(c).resolves.toMatchObject({ pageIndex: 2 });
  expect(send.mock.calls.map(([value]) => value.pageIndex)).toEqual([0, 2]);
});

it("相同在途进度共享请求；其他相册互不合并", async () => {
  const first = deferred<ImageActivity>();
  const send = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementation(async (value) => result(value));
  const queue = new ImageActivityQueue(send);
  const a = queue.progress(input(0));
  const same = queue.progress(input(0));
  const other = queue.progress(input(3, "a_2"));
  first.resolve(result(input(0)));
  await Promise.all([a, same, other]);
  expect(send).toHaveBeenCalledTimes(2);
});

it("旧进度、显式已读、重置、新进度保持调用顺序，无法跨边界合并", async () => {
  const first = deferred<ImageActivity>();
  const order: string[] = [];
  const queue = new ImageActivityQueue(async (value) => {
    order.push(`page:${value.pageIndex}`);
    return value.pageIndex === 0 ? first.promise : result(value);
  });
  const a = queue.progress(input(0));
  const b = queue.progress(input(1));
  const read = queue.barrier(async () => {
    order.push("read");
    return 9;
  });
  const reset = queue.barrier(async () => {
    order.push("reset");
    return true;
  });
  const c = queue.progress(input(2));
  expect(order).toEqual(["page:0"]);
  first.resolve(result(input(0)));
  await Promise.all([a, b, read, reset, c]);
  expect(order).toEqual(["page:0", "page:1", "read", "reset", "page:2"]);
  await expect(read).resolves.toBe(9);
});

it("失败拒绝所有合并调用者，并继续执行后续显式操作", async () => {
  const first = deferred<ImageActivity>();
  const queue = new ImageActivityQueue(() => first.promise);
  const a = queue.progress(input(0));
  const b = queue.progress(input(0));
  const aFailed = expect(a).rejects.toThrow("offline");
  const bFailed = expect(b).rejects.toThrow("offline");
  const reset = queue.barrier(async () => "reset");
  first.reject(new Error("offline"));
  await Promise.all([aFailed, bFailed]);
  await expect(reset).resolves.toBe("reset");
  await expect(
    queue.barrier(async () => {
      throw new Error("disk");
    }),
  ).rejects.toThrow("disk");
  await expect(queue.barrier(async () => "retry")).resolves.toBe("retry");
});
