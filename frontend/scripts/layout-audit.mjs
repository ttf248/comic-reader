// 布局与排版审计：量化「内容有效宽度」「控件字号」「溢出」等设计指标。
//
// 用法：
//   npm run audit:layout                                   # 默认页面 / 断点 / 明暗
//   LG_BASE=http://127.0.0.1:5173 npm run audit:layout
//   LG_PAGES=/,/unread npm run audit:layout
//   LG_VIEWPORTS=390x844,1440x900 npm run audit:layout
//   LG_THEMES=dark npm run audit:layout
//   npm run audit:layout -- --json                          # 输出机器可读 JSON
//
// 输出的核心指标：
//   - contentWidthRatio : 主内容实际占视口宽度的比例（越低说明左右留白浪费越多）
//   - gutterRatio       : 左右空白各占视口宽度的比例
//   - tinyText[]        : 实际渲染字号 < 12.5px 的可见文本（中文可读性下限）
//   - controlHeights    : 可交互控件的实际高度分布（触控目标是否达标）
//   - overflowPx        : 横向溢出像素
//
// 退出码：任一断点出现横向溢出时为 1，方便提交前自查。
import { chromium } from "@playwright/test";

const BASE = process.env.LG_BASE ?? "http://127.0.0.1:5173";
const THEMES = (process.env.LG_THEMES ?? "light,dark").split(",").filter(Boolean);
const PAGES = (process.env.LG_PAGES ?? "/,/recents,/favorites,/unread")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const VIEWPORTS = (process.env.LG_VIEWPORTS ?? "390x844,768x1024,1024x768,1440x900,1920x1080")
  .split(",")
  .map((v) => {
    const [w, h] = v.split("x").map(Number);
    return { width: w, height: h };
  })
  .filter((v) => Number.isFinite(v.width));

const MIN_FONT_PX = 12.5;
const MIN_CONTROL_PX = 28;

const MEASURE = ({ minFontPx, minControlPx }) => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (Number(style.opacity) < 0.05) return false;
    return true;
  };

  const main = document.querySelector("main");
  const mainRect = main?.getBoundingClientRect() ?? null;

  // 主内容容器：优先 .page-shell（带 max-width 的那层），
  // 否则退回 <main>，再退回 body。
  const shell =
    document.querySelector(".page-shell") ??
    main ??
    document.body;
  const shellRect = shell.getBoundingClientRect();

  // 文本节点字体统计：只看直接包含文字的元素，避免把父容器算进去。
  const fontSizeCounts = new Map();
  const tinyText = [];
  const textElements = document.querySelectorAll(
    "body *",
  );
  for (const el of textElements) {
    if (!visible(el)) continue;
    const hasOwnText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && n.textContent.trim().length > 0,
    );
    if (!hasOwnText) continue;
    const style = getComputedStyle(el);
    const size = Math.round(parseFloat(style.fontSize) * 100) / 100;
    fontSizeCounts.set(size, (fontSizeCounts.get(size) ?? 0) + 1);
    if (size < minFontPx) {
      tinyText.push({
        size,
        text: (el.textContent ?? "").trim().slice(0, 40),
        cls: (el.getAttribute("class") || "").slice(0, 80),
      });
    }
  }

  // 交互控件实际高度
  const controlHeights = [];
  const controls = document.querySelectorAll(
    "button, a[href], input, select, textarea, [role='button'], [role='tab']",
  );
  for (const el of controls) {
    if (!visible(el)) continue;
    const rect = el.getBoundingClientRect();
    const text = (el.getAttribute("aria-label") || el.textContent || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 30);
    controlHeights.push({ h: Math.round(rect.height * 10) / 10, text });
  }

  const doc = document.documentElement;
  const overflowPx = Math.max(
    0,
    doc.scrollWidth - doc.clientWidth,
    document.body.scrollWidth - doc.clientWidth,
  );

  const viewportWidth = window.innerWidth;
  const contentWidth = Math.round(shellRect.width);
  const gutter = Math.max(0, Math.round((viewportWidth - contentWidth) / 2));

  return {
    viewport: { width: viewportWidth, height: window.innerHeight },
    dpr: window.devicePixelRatio,
    zoom: Math.round(
      (window.outerWidth / window.innerWidth || 1) * 100,
    ),
    contentWidth,
    contentWidthRatio: Math.round((contentWidth / viewportWidth) * 1000) / 1000,
    gutter,
    gutterRatio: Math.round((gutter / viewportWidth) * 1000) / 1000,
    mainWidth: mainRect ? Math.round(mainRect.width) : null,
    overflowPx,
    fontSizeCounts: [...fontSizeCounts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([size, count]) => ({ size, count })),
    tinyText: tinyText.slice(0, 20),
    tinyTextTotal: tinyText.length,
    controlHeightCounts: Object.entries(
      controlHeights.reduce((acc, c) => {
        const key = String(c.h);
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    )
      .map(([h, count]) => ({ h: Number(h), count }))
      .sort((a, b) => a.h - b.h),
    smallControls: controlHeights
      .filter((c) => c.h < minControlPx)
      .slice(0, 10),
    smallControlsTotal: controlHeights.filter((c) => c.h < minControlPx).length,
  };
};

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    const raw = localStorage.getItem("local-gallery-ui");
    const parsed = raw ? JSON.parse(raw) : { state: {} };
    parsed.state = { ...(parsed.state ?? {}), theme: t };
    localStorage.setItem("local-gallery-ui", JSON.stringify(parsed));
  }, theme);
}

async function main() {
  const browser = await chromium.launch();
  const report = [];
  let failed = false;

  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        locale: "zh-CN",
        colorScheme: theme,
      });
      const page = await ctx.newPage();
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await setTheme(page, theme);

      for (const route of PAGES) {
        // 不用 networkidle：页面含 SSE 长连接，且 /api/previews 首次生成
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
        await page.waitForTimeout(900);
        const m = await page.evaluate(MEASURE, { minFontPx: MIN_FONT_PX, minControlPx: MIN_CONTROL_PX });
        report.push({ theme, route, vp: `${viewport.width}x${viewport.height}`, ...m });
        if (m.overflowPx > 0) failed = true;
      }
      await ctx.close();
    }
  }
  await browser.close();

  const asJson = process.argv.includes("--json");
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      [
        "断点          主题   路由        内容宽  占比   左右留白  溢出  <12.5px文本  小控件",
        ...report.map((r) =>
          [
            r.vp.padEnd(14),
            r.theme.padEnd(6),
            r.route.padEnd(11),
            String(r.contentWidth).padEnd(7),
            `${(r.contentWidthRatio * 100).toFixed(1)}%`.padEnd(6),
            String(r.gutter).padEnd(9),
            String(r.overflowPx).padEnd(5),
            String(r.tinyTextTotal).padEnd(11),
            String(r.smallControlsTotal),
          ].join(" "),
        ),
      ].join("\n"),
    );
    console.log("");
    for (const r of report) {
      const sizes = r.fontSizeCounts.map((f) => `${f.size}px×${f.count}`).join(" ");
      console.log(`${r.vp} ${r.theme} ${r.route} 字号分布: ${sizes}`);
    }
  }
  if (failed) {
    console.error("\n存在横向溢出。");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
