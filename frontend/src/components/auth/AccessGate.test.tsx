import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authApi, SESSION_CHECK_TIMEOUT_MS } from "../../api/auth";
import { AUTH_ESTABLISHED_EVENT, AUTH_REQUIRED_EVENT } from "../../api/client";
import AccessGate from "./AccessGate";

vi.mock("../../api/auth", () => ({
  SESSION_CHECK_TIMEOUT_MS: 15000,
  authApi: {
    status: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
  },
}));

describe("AccessGate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("已有会话时才渲染业务页", async () => {
    vi.mocked(authApi.status).mockResolvedValue({
      authenticated: true,
      mode: "lan",
    });
    render(
      <AccessGate>
        <div>私有媒体库</div>
      </AccessGate>,
    );
    expect(screen.queryByText("私有媒体库")).not.toBeInTheDocument();
    expect(await screen.findByText("私有媒体库")).toBeInTheDocument();
  });

  it("令牌只发送给会话接口且不持久化", async () => {
    vi.mocked(authApi.status).mockResolvedValue({
      authenticated: false,
      mode: "lan",
    });
    vi.mocked(authApi.login).mockResolvedValue({
      authenticated: true,
      mode: "lan",
    });
    const persist = vi.spyOn(Storage.prototype, "setItem");
    render(
      <AccessGate>
        <div>已解锁</div>
      </AccessGate>,
    );
    const input = await screen.findByLabelText("访问令牌");
    fireEvent.change(input, { target: { value: "  secure-token  " } });
    fireEvent.click(screen.getByRole("button", { name: "进入媒体库" }));
    await waitFor(() =>
      expect(authApi.login).toHaveBeenCalledWith("secure-token"),
    );
    expect(await screen.findByText("已解锁")).toBeInTheDocument();
    expect(persist).not.toHaveBeenCalled();
    persist.mockRestore();
  });

  it("会话检查超时后给出可重试的离线提示", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(authApi.status).mockImplementation(
        (signal?: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );
      render(
        <AccessGate>
          <div>私有媒体库</div>
        </AccessGate>,
      );

      await act(async () => {
        vi.advanceTimersByTime(SESSION_CHECK_TIMEOUT_MS + 100);
      });

      expect(screen.getByText("无法连接媒体库服务。")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
      expect(screen.queryByText("私有媒体库")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("收到认证失效事件后立即卸载业务页", async () => {
    vi.mocked(authApi.status).mockResolvedValue({
      authenticated: true,
      mode: "lan",
    });
    render(
      <AccessGate>
        <div>已解锁</div>
      </AccessGate>,
    );
    expect(await screen.findByText("已解锁")).toBeInTheDocument();
    act(() => window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT)));
    expect(
      await screen.findByText("会话已过期，请重新输入访问令牌"),
    ).toBeInTheDocument();
    expect(screen.queryByText("已解锁")).not.toBeInTheDocument();

    act(() => window.dispatchEvent(new Event(AUTH_ESTABLISHED_EVENT)));
    expect(await screen.findByText("已解锁")).toBeInTheDocument();
  });
});
