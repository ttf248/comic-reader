import { api, AUTH_ESTABLISHED_EVENT } from "./client";

export interface SessionStatus {
  authenticated: boolean;
  mode: "local" | "lan";
  expiresAt?: string;
}

// 会话检查的超时时间：后端无响应（进程卡死、连接半开）时，
// 入口不该一直停在「正在确认访问权限…」，而应给出可重试的提示。
export const SESSION_CHECK_TIMEOUT_MS = 15000;

export const authApi = {
  status: (signal?: AbortSignal) =>
    api<SessionStatus>("/api/auth/session", { signal }),
  login: async (token: string) => {
    const session = await api<SessionStatus>("/api/auth/session", {
      method: "POST",
      nonIdempotent: true,
      body: { token },
    });
    if (session.authenticated && typeof window !== "undefined") {
      window.dispatchEvent(new Event(AUTH_ESTABLISHED_EVENT));
    }
    return session;
  },
  logout: () =>
    api<void>("/api/auth/session", {
      method: "DELETE",
      nonIdempotent: true,
    }),
};
