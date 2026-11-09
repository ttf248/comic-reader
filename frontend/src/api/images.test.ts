import { describe, expect, it } from "vitest";
import { previewUrl } from "./images";
import { thumbUrl } from "./thumbs";

// 渲染图 URL 的查询串拼接。
//
// 这里的坑：预览图与缩略图都带 ?w= 与 ?v=，两个参数之间只能用 "&"。
// 手写 "?w=…" 再拼 "?v=…" 会得到两个问号，服务端把 "?v=…" 整个当成 w
// 的值，整张图 400 —— 大图预览会直接显示「这张图片无法显示」。
describe("渲染图 URL", () => {
  it("预览图带版本号时只有一个问号", () => {
    const url = previewUrl("f_abc", 1920, "123-456-r3");
    expect(url).toBe("/api/previews/f_abc?w=1920&v=123-456-r3");
    expect(url.match(/\?/g)).toHaveLength(1);
  });

  it("预览图不带版本号时只带宽度", () => {
    expect(previewUrl("f_abc", 640)).toBe("/api/previews/f_abc?w=640");
  });

  it("预览图宽度夹在档位区间内", () => {
    expect(previewUrl("f_abc", 10)).toBe("/api/previews/f_abc?w=320");
    expect(previewUrl("f_abc", 99999)).toBe("/api/previews/f_abc?w=4096");
  });

  it("缩略图与预览图的查询串结构一致", () => {
    const version = "1692888580000000000-1053199-r3";
    expect(thumbUrl("f_abc", version, 640)).toBe(
      "/api/thumbs/f_abc?w=640&v=1692888580000000000-1053199-r3",
    );
    expect(previewUrl("f_abc", 640, version)).toBe(
      "/api/previews/f_abc?w=640&v=1692888580000000000-1053199-r3",
    );
  });
});
