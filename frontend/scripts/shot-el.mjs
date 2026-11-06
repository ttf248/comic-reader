// 元素级截图：对某个路由的某个选择器区域放大截图，用于设计迭代的前后对照。
//
// 用法：
//   node scripts/shot-el.mjs --route /comic/albums/xxx --sel ".detail-head" --out ../.smoke/x.png
//   node scripts/shot-el.mjs --route /comic --sel ".library-grid" --out ../.smoke/y.png
//
// 环境变量：
//   LG_BASE   默认 http://127.0.0.1:8080
//   LG_THEME  light | dark，默认 light
//   LG_W / LG_H 视口，默认 1440x900
//   LG_SCALE  设备像素比，默认 2
import { chromium } from "@playwright/test";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};

const BASE = process.env.LG_BASE ?? "http://127.0.0.1:8080";
const THEME = process.env.LG_THEME ?? "light";
const W = Number(process.env.LG_W ?? 1440);
const H = Number(process.env.LG_H ?? 900);
const SCALE = Number(process.env.LG_SCALE ?? 2);
const ROUTE = arg("route", "/comic");
const SEL = arg("sel", "body");
const OUT = path.resolve(arg("out", "../.smoke/el.png"));

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: SCALE,
  locale: "zh-CN",
  colorScheme: THEME,
});
const page = await ctx.newPage();
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.evaluate((t) => {
  const raw = localStorage.getItem("local-gallery-ui");
  const parsed = raw ? JSON.parse(raw) : { state: {} };
  parsed.state = { ...(parsed.state ?? {}), theme: t };
  localStorage.setItem("local-gallery-ui", JSON.stringify(parsed));
}, THEME);
await page.goto(BASE + ROUTE, { waitUntil: "domcontentloaded", timeout: 60000 });
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
const el = page.locator(SEL).first();
await el.scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await el.screenshot({ path: OUT });
console.log(`-> ${OUT}`);
await browser.close();
