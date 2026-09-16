import { afterEach, describe, expect, it, vi } from "vitest";
import { getVideoInfoBatch, VIDEO_INFO_BATCH_LIMIT } from "./videos";

describe("getVideoInfoBatch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("去重并按服务端上限拆分请求", async () => {
    const ids = Array.from(
      { length: VIDEO_INFO_BATCH_LIMIT + 1 },
      (_, i) => `f_${i}`,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          ok: true,
          items: [{ id: "f_0", info: { name: "first" } }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          ok: true,
          items: [
            { id: `f_${VIDEO_INFO_BATCH_LIMIT}`, info: { name: "last" } },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getVideoInfoBatch([...ids, "f_0"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      f_0: { name: "first" },
      [`f_${VIDEO_INFO_BATCH_LIMIT}`]: { name: "last" },
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ ids: ids.slice(0, VIDEO_INFO_BATCH_LIMIT) }),
    });
  });

  it("空列表不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getVideoInfoBatch([])).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
