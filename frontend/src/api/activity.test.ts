import { afterEach, expect, it, vi } from "vitest";
import { activityApi, ACTIVITY_CHANGED_EVENT } from "./activity";

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function listenActivityChanged() {
  const listener = vi.fn();
  window.addEventListener(ACTIVITY_CHANGED_EVENT, listener);
  return listener;
}

it("图片活动写入后通知常驻入口刷新", async () => {
  stubFetch();
  const listener = listenActivityChanged();
  await activityApi.setImage("a_1", 2, 10);
  expect(listener).toHaveBeenCalledTimes(1);
  listener.mockClear();
});

it("视频活动写入后同样通知：纯视频相册靠视频活动判定已翻开", async () => {
  stubFetch();
  const listener = listenActivityChanged();
  await activityApi.setVideo("a_1", "f_1", 1200, 60_000);
  expect(listener).toHaveBeenCalledTimes(1);
  listener.mockClear();
});

it("keepalive 补写成功后同样通知", async () => {
  stubFetch();
  const listener = listenActivityChanged();
  activityApi.keepalive({
    albumId: "a_1",
    mediaKind: "video",
    itemId: "f_1",
    positionMs: 10,
    durationMs: 60_000,
  });
  await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
  listener.mockClear();
});
