// 页面体积审计：量化首屏实际传输了多少字节、发了多少请求、多久能出画面。
//
// 用法：
//   npm run audit:size                                   # 默认首页 / 1440x900
//   LG_BASE=http://127.0.0.1:5173 npm run audit:size
//   LG_PAGES=/,/settings npm run audit:size
//   LG_VIEWPORTS=390x844,1440x900 npm run audit:size
//   npm run audit:size -- --json                          # 输出机器可读 JSON
//
// 输出：
//   - staticBytes : 首屏的静态载荷（HTML + JS + CSS）实际传输字节。
//                    与媒体库大小无关，可以作为稳定的体积预算。
//   - mediaBytes  : 首屏图片的实际传输字节。随库大小与档位变化，只作参考。
//   - requests    : 首屏发出的请求数。
//   - lcpMs       : 最大内容绘制时间。
//
// 退出码：静态载荷超过预算时为 1。
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.LG_BASE ?? "http://127.0.0.1:5173";
const PAGES = (process.env.LG_PAGES ?? "/")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const VIEWPORTS = (process.env.LG_VIEWPORTS ?? "1440x900")
  .split(",")
  .map((v) => {
    const [w, h] = v.split("x").map(Number);
    return { width: w, height: h };
  })
  .filter((v) => Number.isFinite(v.width));

// 静态载荷预算（字节）。
//
// 首屏 HTML + JS + CSS 的传输量。它与媒体库大小无关，是能长期守住的那条线：
// 路由级懒加载与 manualChunks 已经把首屏压到这个量级，加新依赖或新 chunk
// 时这条线会先响。
const STATIC_BUDGET_BYTES = 120 * 1024;

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");
// --dist：只读构建产物，不开浏览器。
//
// 首屏实际传输量依赖运行中的服务与媒体库，CI 里两者都不稳；构建产物
// 是确定的：入口 chunk + modulepreload + 样式表就是首屏要下的全部静态
// 资源。拿它当预算，守的是「别把新依赖塞进首屏」这条线。
const DIST_ONLY = argv.includes("--dist");

// 构建产物的首屏预算（字节，未压缩）。
const DIST_BUDGET_BYTES = 420 * 1024;

if (DIST_ONLY) {
  const distDir = path.resolve(process.env.LG_DIST ?? "dist");
  const html = await fs.readFile(path.join(distDir, "index.html"), "utf8");
  const referenced = new Set();
  for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
    referenced.add(match[1]);
  }
  let bytes = 0;
  const files = [];
  for (const rel of referenced) {
    const file = path.join(distDir, rel.replace(/^\//, ""));
    const stat = await fs.stat(file);
    bytes += stat.size;
    files.push({ file: rel, bytes: stat.size });
  }
  const htmlBytes = Buffer.byteLength(html);
  bytes += htmlBytes;
  const payload = { staticBytes: bytes, htmlBytes, files };
  if (JSON_OUT) {
    console.log(JSON.stringify({ budget: DIST_BUDGET_BYTES, ...payload }, null, 2));
  } else {
    console.log(`首屏构建产物预算：${(DIST_BUDGET_BYTES / 1024).toFixed(0)} KB
`);
    for (const f of files) {
      console.log(`  ${(f.bytes / 1024).toFixed(1).padStart(8)} KB  ${f.file}`);
    }
    console.log(`  ${(htmlBytes / 1024).toFixed(1).padStart(8)} KB  /index.html`);
    console.log(
      `合计 ${(bytes / 1024).toFixed(1)} KB` +
        (bytes > DIST_BUDGET_BYTES ? "  ← 超出预算" : ""),
    );
  }
  process.exit(bytes > DIST_BUDGET_BYTES ? 1 : 0);
}

/** 一次导航的资源统计。 */
async function measure(page, url) {
  const entries = [];
  const handler = (response) => {
    const request = response.request();
    entries.push({
      type: request.resourceType(),
      url: response.url(),
      bytes: Number(response.headers()["content-length"] || 0),
      status: response.status(),
    });
  };
  page.on("response", handler);
  await page.goto(url, { waitUntil: "load" });
  // 图片是懒加载的，等一小会儿让首屏该出的图都出来。
  await page.waitForTimeout(2500);
  page.off("response", handler);

  // 开发服务器送的是未打包的模块，静态载荷没有可比性。
  const isDevServer = await page.evaluate(() =>
    Boolean(document.querySelector('script[src*="/@vite/"], script[src*="/@react-refresh"]')),
  );

  const timing = await page.evaluate(() => {
    const resources = performance.getEntriesByType("resource");
    const nav = performance.getEntriesByType("navigation")[0];
    const sum = (predicate) =>
      resources
        .filter((r) => predicate(r.initiatorType))
        .reduce((a, r) => a + r.transferSize, 0);
    const largest = performance.getEntriesByName("first-contentful-paint")[0];
    return {
      // transferSize 是实际过网的字节：命中浏览器缓存时为 0。
      staticBytes:
        (nav?.transferSize ?? 0) +
        sum((t) => t === "script" || t === "link" || t === "css"),
      mediaBytes: sum((t) => t === "img" || t === "video"),
      requests: resources.length + 1,
      fcpMs: largest ? Math.round(largest.startTime) : null,
      lcpMs: null,
    };
  });

  const lcp = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let value = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) value = entry.startTime;
        }).observe({ type: "largest-contentful-paint", buffered: true });
        setTimeout(() => resolve(value ? Math.round(value) : null), 300);
      }),
  );
  timing.lcpMs = lcp;
  timing.isDevServer = isDevServer;
  return timing;
}

const results = [];
const browser = await chromium.launch();
for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    locale: "zh-CN",
  });
  const page = await context.newPage();
  for (const route of PAGES) {
    const url = `${BASE}${route.startsWith("/") ? route : `/${route}`}`;
    let timing;
    try {
      timing = await measure(page, url);
    } catch (error) {
      console.error(`✗ ${route} 加载失败: ${error.message}`);
      results.push({ route, viewport: `${viewport.width}x${viewport.height}`, error: String(error) });
      continue;
    }
    results.push({ route, viewport: `${viewport.width}x${viewport.height}`, ...timing });
  }
  await context.close();
}
await browser.close();

if (JSON_OUT) {
  console.log(JSON.stringify({ budget: STATIC_BUDGET_BYTES, results }, null, 2));
} else {
  console.log(`静态载荷预算：${(STATIC_BUDGET_BYTES / 1024).toFixed(0)} KB\n`);
  for (const r of results) {
    if (r.error) {
      console.log(`✗ ${r.route} @${r.viewport}：${r.error}`);
      continue;
    }
    const staticKB = (r.staticBytes / 1024).toFixed(1);
    const mediaKB = (r.mediaBytes / 1024).toFixed(1);
    const over = r.isDevServer
      ? "  ← 开发服务器，预算不适用"
      : r.staticBytes > STATIC_BUDGET_BYTES
        ? "  ← 超出预算"
        : "";
    console.log(
      `${r.route} @${r.viewport}：静态 ${staticKB} KB · 媒体 ${mediaKB} KB · ` +
        `${r.requests} 请求 · FCP ${r.fcpMs}ms · LCP ${r.lcpMs}ms${over}`,
    );
  }
}

const failed = results.some(
  (r) => r.error || (!r.isDevServer && r.staticBytes > STATIC_BUDGET_BYTES),
);
process.exit(failed ? 1 : 0);
