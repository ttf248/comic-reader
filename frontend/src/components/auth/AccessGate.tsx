import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  ApiError,
  AUTH_ESTABLISHED_EVENT,
  AUTH_REQUIRED_EVENT,
} from "../../api/client";
import { authApi, SESSION_CHECK_TIMEOUT_MS } from "../../api/auth";

type GateState = "checking" | "unlocked" | "locked" | "local-only" | "offline";

export default function AccessGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>("checking");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const checkSession = useCallback(() => {
    setState("checking");
    setError("");
    // 超时保护：请求卡住时按时进入「离线」态，让用户可以重试，
    // 而不是一直看着「正在确认访问权限…」。
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => controller.abort(),
      SESSION_CHECK_TIMEOUT_MS,
    );
    authApi
      .status(controller.signal)
      .then((session) =>
        setState(session.authenticated ? "unlocked" : "locked"),
      )
      .catch((caught: unknown) => {
        if (
          caught instanceof ApiError &&
          caught.code === "local_access_required"
        ) {
          setState("local-only");
          return;
        }
        setState("offline");
      })
      .finally(() => window.clearTimeout(timer));
  }, []);

  useEffect(() => {
    checkSession();
    const requireAuth = () => {
      setError("会话已过期，请重新输入访问令牌");
      setState("locked");
    };
    const establishAuth = () => {
      setToken("");
      setError("");
      setState("unlocked");
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, requireAuth);
    window.addEventListener(AUTH_ESTABLISHED_EVENT, establishAuth);
    return () => {
      window.removeEventListener(AUTH_REQUIRED_EVENT, requireAuth);
      window.removeEventListener(AUTH_ESTABLISHED_EVENT, establishAuth);
    };
  }, [checkSession]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const credential = token.trim();
    if (!credential) return;
    setSubmitting(true);
    setError("");
    try {
      const session = await authApi.login(credential);
      if (!session.authenticated) throw new Error("session was not created");
      setToken("");
      setState("unlocked");
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === "invalid_access_token"
          ? "访问令牌不正确"
          : "无法建立会话，请稍后重试",
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (state === "unlocked") return <>{children}</>;

  return (
    <main className="min-h-screen bg-bg text-fg flex items-center justify-center px-5">
      <section className="w-full max-w-sm rounded-2xl border border-border bg-bg-elevated shadow-lg p-7">
        <div className="w-11 h-11 rounded-xl bg-accent/10 text-accent flex items-center justify-center text-xl mb-5">
          ◈
        </div>
        <h1 className="text-xl font-semibold tracking-tight">本地媒体库</h1>

        {state === "checking" && (
          <p className="mt-3 text-sm text-fg-muted">正在确认访问权限…</p>
        )}

        {state === "locked" && (
          <form className="mt-5" onSubmit={submit}>
            <p className="text-sm text-fg-muted leading-6">
              这个媒体库已开启局域网访问保护。令牌只用于换取本浏览器的短期会话，不会保存在本地存储或
              URL 中。
            </p>
            <p className="mt-2 text-xs text-fg-subtle leading-5">
              请仅在可信家庭网络中使用；内置服务不提供 TLS，不适合互联网或不可信
              Wi-Fi。
            </p>
            <label
              className="block mt-5 text-xs font-medium text-fg-muted"
              htmlFor="access-token"
            >
              访问令牌
            </label>
            <input
              id="access-token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="current-password"
              spellCheck={false}
              maxLength={256}
              autoFocus
              className="mt-2 w-full h-10 rounded-lg border border-border bg-bg px-3 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            {error && (
              <p role="alert" className="mt-2 text-xs text-danger">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={submitting || token.trim().length === 0}
              className="mt-5 w-full h-10 rounded-lg bg-accent text-accent-contrast text-sm font-medium disabled:opacity-50"
            >
              {submitting ? "正在验证…" : "进入媒体库"}
            </button>
          </form>
        )}

        {state === "local-only" && (
          <div className="mt-4">
            <p className="text-sm text-fg-muted leading-6">
              服务当前仅允许运行它的计算机访问。若需在局域网中使用，请先在服务端配置
              `accessMode: lan` 和强访问令牌。
            </p>
          </div>
        )}

        {state === "offline" && (
          <div className="mt-4">
            <p className="text-sm text-fg-muted">无法连接媒体库服务。</p>
            <button
              type="button"
              onClick={checkSession}
              className="mt-4 h-9 px-4 rounded-lg border border-border text-sm hover:bg-bg-hover"
            >
              重试
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
