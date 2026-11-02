// 多断点 / 明暗主题截图工具：用于设计迭代的前后对照。
//
// 用法：
//   node scripts/screenshot.mjs --out .smoke/round1
//   LG_BASE=http://127.0.0.1:5173 node scripts/screenshot.mjs --out .smoke/x
//   LG_VIEWPORTS=1440x900,390x844 node scripts/screenshot.mjs --out ...
//   LG_THEMES=light node scripts/screenshot.mjs --out ...
//   LG_PAGES=/,/unread node scripts/screenshot.mjs --out ...
//   LG_FULL=1 node scripts/screenshot.mjs --out ...      # 整页截图
//
// 产物写入 .smoke/（已被根 .gitignore 忽略，不入库）。
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.LG_BASE ?? "http://127.0.0.1:5173";
const THEMES = (process.env.LG_THEMES ?? "light,dark").split(",").filter(Boolean);
const PAGES = (process.env.LG_PAGES ?? "/,/recents,/favorites,/unread")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const VIEWPORTS = (process.env.LG_VIEWPORTS ?? "390x844,768x1024,1440x900,1920x1080")
  .split(",")
  .map((v) => {
    const [w, h] = v.split("x").map(Number);
    return { width: w, height: h };
  })
  .filter((v) => Number.isFinite(v.width));

const argv = process.argv.slice(2);
const outArg = argv.indexOf("--out");
const OUT = path.resolve(
  outArg >= 0 ? argv[outArg + 1] : ".smoke/shots",
);
const FULL = process.env.LG_FULL === "1";

const slug = (route) =>
  route === "/" ? "home" : route.replace(/^\//, "").replace(/[/?=&]/g, "-");

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    const raw = localStorage.getItem("local-gallery-ui");
    const parsed = raw ? JSON.parse(raw) : { state: {} };
    parsed.state = { ...(parsed.state ?? {}), theme: t };
    localStorage.setItem("local-gallery-ui", JSON.stringify(parsed));
  }, theme);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const errors = [];
  let count = 0;

  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        locale: "zh-CN",
        colorScheme: theme,
      });
      const page = await ctx.newPage();
      page.on("pageerror", (e) =>
        errors.push(`[${theme}/${viewport.width}] ${e.message}`),
      );
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await setTheme(page, theme);

      for (const route of PAGES) {
        // 不用 networkidle：页面里有 SSE 长连接，且 /api/previews 首次生成
        // 预览图可能耗时数秒，networkidle 会一直等不到而超时。
        await page.goto(BASE + route, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await page
          .waitForFunction(
            () =>
              Array.from(document.images).every(
                (img) => !img.complete || img.naturalWidth > 0,
              ),
            undefined,
            { timeout: 20000 },
          )
          .catch(() => {});
        await page.waitForTimeout(1200);
        const name = `${theme}-${viewport.width}-${slug(route)}.png`;
        await page.screenshot({
          path: path.join(OUT, name),
          fullPage: FULL,
        });
        count++;
      }
      await ctx.close();
    }
  }
  await browser.close();
  console.log(`${count} shots -> ${OUT}`);
  if (errors.length) {
    console.log("=== page errors ===");
    console.log([...new Set(errors)].join("\n"));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
