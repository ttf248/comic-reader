import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, AUTH_REQUIRED_EVENT } from "./client";

function failedResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    text: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("api error response", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("只读取一次响应体并解析标准扁平错误", async () => {
    const response = failedResponse(
      400,
      JSON.stringify({ code: "invalid_request", message: "请求无效" }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const error = await api("/api/example").catch((caught: unknown) => caught);

    expect(response.text).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: "invalid_request",
      message: "请求无效",
    });
  });

  it("保留非 JSON 错误文本供诊断", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          failedResponse(
            422,
            JSON.stringify({ code: "bad_path", message: "路径无效" }),
          ),
        )
        .mockResolvedValueOnce(failedResponse(400, "Bad Request")),
    );

    await expect(api("/api/flat")).rejects.toMatchObject({
      status: 422,
      code: "bad_path",
      message: "路径无效",
    });
    await expect(api("/api/text")).rejects.toMatchObject({
      status: 400,
      message: "HTTP 400",
      body: "Bad Request",
    });
  });

  it("默认携带同源会话并在 401 时广播认证失效", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        failedResponse(
          401,
          JSON.stringify({ code: "authentication_required", message: "登录" }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const listener = vi.fn();
    window.addEventListener(AUTH_REQUIRED_EVENT, listener);

    await expect(api("/api/private", { retries: 0 })).rejects.toMatchObject({
      status: 401,
      code: "authentication_required",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/private",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
  });

  it("上传 FormData 时不覆盖浏览器生成的 multipart boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const body = new FormData();
    body.append("image", new File(["image"], "query.jpg"));

    await api("/api/ai/search", {
      method: "POST",
      body,
      nonIdempotent: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ai/search",
      expect.objectContaining({
        body,
        headers: { Accept: "application/json" },
      }),
    );
  });
});
