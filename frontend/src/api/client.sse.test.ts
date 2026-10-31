import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sse } from "./client";

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];
  readyState = MockEventSource.OPEN;
  onerror: ((event: Event) => void) | null = null;
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  close = vi.fn(() => {
    this.readyState = MockEventSource.CLOSED;
  });
  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(event: Event) {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
    if (event.type === "error") this.onerror?.(event);
  }
}

describe("SSE 事件与连接生命周期", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("原生连接错误只进入连接回调，不作为业务进度分发", () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    const close = sse("/api/scans/one/events", onEvent, {
      events: ["error"],
      onError,
    });
    const source = MockEventSource.instances[0];
    source.readyState = MockEventSource.CLOSED;
    source.emit(new Event("error"));
    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Event), "closed");
    close();
  });

  it("名为 error 的业务消息不触发连接错误回调", () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    const close = sse("/api/scans/one/events", onEvent, {
      events: ["error"],
      onError,
    });
    MockEventSource.instances[0].emit(
      new MessageEvent("error", { data: '{"status":"error"}' }),
    );
    expect(onEvent).toHaveBeenCalledWith("error", { status: "error" });
    expect(onError).not.toHaveBeenCalled();
    close();
  });

  it("消费回调抛错不会再次把原始文本交给同一回调", () => {
    const onEvent = vi.fn(() => {
      throw new Error("consumer failed");
    });
    const close = sse("/events", onEvent);
    expect(() =>
      MockEventSource.instances[0].emit(
        new MessageEvent("message", { data: '{"ok":true}' }),
      ),
    ).toThrow("consumer failed");
    expect(onEvent).toHaveBeenCalledOnce();
    close();
  });

  it("已取消的订阅不会创建网络连接", () => {
    const controller = new AbortController();
    controller.abort();
    sse("/events", vi.fn(), { signal: controller.signal })();
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("取消后移除监听并忽略排队消息，重复清理只关闭一次", () => {
    const controller = new AbortController();
    const onEvent = vi.fn();
    const onError = vi.fn();
    const close = sse("/events", onEvent, {
      events: ["running", "error"],
      signal: controller.signal,
      onError,
    });
    const source = MockEventSource.instances[0];
    const queued = [...(source.listeners.get("running") ?? [])];
    controller.abort();
    close();
    source.emit(new Event("error"));
    queued.forEach((listener) => {
      const event = new MessageEvent("running", { data: "{}" });
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    });
    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledOnce();
    expect(
      [...source.listeners.values()].every((listeners) => listeners.size === 0),
    ).toBe(true);
  });

  it("重复事件名只分发一次，非 JSON 消息仍保留文本", () => {
    const onEvent = vi.fn();
    const close = sse("/events", onEvent, { events: ["message", "message"] });
    MockEventSource.instances[0].emit(
      new MessageEvent("message", { data: "plain text" }),
    );
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith("message", "plain text");
    close();
  });
});
