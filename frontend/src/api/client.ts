// API 客户端基础封装。
//
// 基础地址解析顺序：
//   1. window.__COMIC_API_BASE__（后端在 index.html 注入）
//   2. import.meta.env.VITE_API_BASE（编译时）
//   3. 空字符串（同源，由 Vite proxy 或后端静态服务接管）

const RUNTIME_BASE =
  (typeof window !== "undefined"
    ? (window as unknown as { __COMIC_API_BASE__?: string }).__COMIC_API_BASE__
    : "") ?? "";

const ENV_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export const API_BASE = RUNTIME_BASE || ENV_BASE || "";
export const AUTH_REQUIRED_EVENT = "local-gallery:auth-required";
export const AUTH_ESTABLISHED_EVENT = "local-gallery:auth-established";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
    /** 后端标准错误 code (snake_case);空表示非业务错误(网络层/未知)。 */
    public code?: string,
  ) {
    super(message);
  }
}

interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
  /** 5xx + 网络错误重试次数,默认 0;GET 默认 1。 */
  retries?: number;
  /** 明确标记非幂等(如 POST),强制 retries=0 防止重复提交。 */
  nonIdempotent?: boolean;
}

function buildUrl(path: string, params?: RequestOptions["params"]): string {
  const base = API_BASE ? `${API_BASE}${path}` : path;
  if (!params) return base;
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(
      ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
    )
    .join("&");
  return qs ? `${base}?${qs}` : base;
}

// 决定实际重试次数的 helper:
//   - nonIdempotent POST/DELETE/PATCH → 0(避免重复提交)
//   - GET → 默认 1
//   - 显式 retries 优先
function resolveRetries(
  method: string | undefined,
  retries: number | undefined,
  nonIdempotent: boolean | undefined,
): number {
  if (nonIdempotent) return 0;
  if (retries !== undefined) return retries;
  const m = (method ?? "GET").toUpperCase();
  return m === "GET" || m === "HEAD" ? 1 : 0;
}

function isRetryableStatus(status: number): boolean {
  // 5xx 服务器错误 + 408 Request Timeout + 429 Too Many Requests
  return (status >= 500 && status < 600) || status === 408 || status === 429;
}

function isRetryableNetworkError(err: unknown): boolean {
  // fetch 抛 TypeError (network failure);AbortError 视为调用方取消,不重试
  if (err instanceof DOMException && err.name === "AbortError") return false;
  if (err instanceof TypeError) return true;
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function api<T>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const { body, params, headers, retries, nonIdempotent, ...rest } = opts;
  const formDataBody =
    typeof FormData !== "undefined" && body instanceof FormData
      ? body
      : undefined;
  const init: RequestInit = {
    ...rest,
    credentials: rest.credentials ?? "include",
    headers: {
      ...(formDataBody === undefined
        ? { "Content-Type": "application/json" }
        : {}),
      Accept: "application/json",
      ...(headers as Record<string, string> | undefined),
    },
  };
  if (body !== undefined) {
    init.body =
      typeof body === "string" ? body : (formDataBody ?? JSON.stringify(body));
  }

  const maxAttempts = resolveRetries(opts.method, retries, nonIdempotent) + 1;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(buildUrl(path, params), init);
      if (!res.ok) {
        // Response body 是一次性流：先读取一次文本，再尝试解析 JSON，避免
        // res.json() 失败后 res.text() 只能拿到 "body already used"。
        const rawBody = await res.text().catch(() => "");
        let parsed: unknown = rawBody || null;
        try {
          parsed = JSON.parse(rawBody) as unknown;
        } catch {
          // 非 JSON 响应保留原始文本，便于调用方诊断代理或网关错误。
        }

        // 当前 API 统一使用扁平错误结构：
        // {"code":"...","message":"...","details":{...}}
        let code: string | undefined;
        let message = `HTTP ${res.status}`;
        if (parsed && typeof parsed === "object") {
          const obj = parsed as Record<string, unknown>;
          if (typeof obj.code === "string") code = obj.code;
          if (typeof obj.message === "string") message = obj.message;
        }
        const err = new ApiError(res.status, message, parsed, code);
        if (res.status === 401 && typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent(AUTH_REQUIRED_EVENT, { detail: { code } }),
          );
        }
        // 4xx 业务错误不重试;5xx/408/429 在剩余次数内重试
        if (attempt < maxAttempts && isRetryableStatus(res.status)) {
          await sleep(100 * attempt); // 简单线性 backoff
          continue;
        }
        throw err;
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    } catch (err) {
      // 已是 ApiError,直接抛出(不会再被网络层 retry catch)
      if (err instanceof ApiError) throw err;
      lastErr = err;
      if (attempt < maxAttempts && isRetryableNetworkError(err)) {
        await sleep(100 * attempt);
        continue;
      }
      throw err;
    }
  }
  // 不会到这里(maxAttempts >= 1);保留类型完整性
  throw lastErr instanceof Error ? lastErr : new Error("api request failed");
}

// 简单的 SSE 订阅：返回取消函数。
//
// options.events：要监听的事件名列表（后端用 `event: <name>` 推送时必须显式列出）；
//   不传则只监听默认的 'message' 事件（无 `event:` 前缀）。
// options.onError：原生连接错误及其重连状态，不包含名为 error 的业务消息。
// options.signal：外部 AbortSignal，触发时自动关闭 EventSource。
export function sse(
  path: string,
  onEvent: (eventName: string, data: unknown) => void,
  options: {
    events?: string[];
    onError?: (err: Event, state: "reconnecting" | "closed") => void;
    signal?: AbortSignal;
  } = {},
): () => void {
  if (options.signal?.aborted) return () => {};
  const url = API_BASE ? `${API_BASE}${path}` : path;
  const es = new EventSource(url);
  let active = true;
  const handler = (event: Event) => {
    if (!active || !(event instanceof MessageEvent)) return;
    let data: unknown = event.data;
    try {
      data = JSON.parse(event.data);
    } catch {
      /* 非 JSON 消息保留原始文本。 */
    }
    onEvent(event.type, data);
  };
  const onConnectionError = (event: Event) => {
    if (!active || event instanceof MessageEvent) return;
    options.onError?.(
      event,
      es.readyState === EventSource.CONNECTING ? "reconnecting" : "closed",
    );
  };
  const events = new Set(["message", ...(options.events ?? [])]);
  for (const name of events) es.addEventListener(name, handler);
  es.addEventListener("error", onConnectionError);
  function close() {
    if (!active) return;
    active = false;
    es.close();
    for (const name of events) es.removeEventListener(name, handler);
    es.removeEventListener("error", onConnectionError);
    options.signal?.removeEventListener("abort", close);
  }
  options.signal?.addEventListener("abort", close, { once: true });
  return close;
}
