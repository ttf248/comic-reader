import { afterEach, expect, it, vi } from "vitest";
import { fsApi } from "./fs";
import { ApiError } from "./client";

afterEach(() => vi.unstubAllGlobals());

it("配置目录使用白名单入口，失败不自动重试且不缓存打开操作", async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ code: "os_open_failed", message: "failed" }),
        { status: 500 },
      ),
    );
  vi.stubGlobal("fetch", fetchMock);
  const path = "./目录 [副本]/100%";
  await expect(fsApi.openConfiguredPath(path)).rejects.toBeInstanceOf(ApiError);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, options] = fetchMock.mock.calls[0];
  const parsed = new URL(String(url), "http://localhost");
  expect(parsed.pathname).toBe("/api/admin/fs/open");
  expect(parsed.searchParams.get("path")).toBe(path);
  expect(parsed.searchParams.get("allowConfig")).toBe("1");
  expect(options).toMatchObject({
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });
});

it("资源入口只提交不透明 ID", async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal("fetch", fetchMock);
  await fsApi.openInExplorer("a_sample");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/fs/open",
    expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ id: "a_sample" }),
    }),
  );
});

it.each([undefined, false, true])(
  "权限字段 %s 只在明确允许时启用",
  async (allowOsOpen) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ allowOsOpen }))),
    );
    await expect(fsApi.capabilities()).resolves.toEqual({
      allowOsOpen: allowOsOpen === true,
    });
  },
);
