// 对比度审计：抓取运行中的界面，按 WCAG 2.1 AA 检查文字对比度。
//
// 用法：
//   npm run audit:contrast                                  # 需要先起 dev server（默认 5173）
//   LG_BASE=http://127.0.0.1:8080 npm run audit:contrast
//   LG_PAGES=/,/unread npm run audit:contrast              # 自定义页面
//   LG_THEMES=dark npm run audit:contrast                  # 自定义主题
//
// 两遍检查：
//   1. DOM 判定 —— 前景色取 computed color（带透明度时先与背景合成），
//      背景色沿祖先链向上合成。阈值：普通文字 4.5:1；大号文字（>=24px，
//      或 >=18.66px 且加粗）3:1。
//   2. 像素判定 —— 压在图片 / 渐变上的文字（封面、阅读器、时间线卡片）
//      静态算不出背景，改为截屏后按文字包围盒采样真实像素，用亮度的
//      10% / 90% 分位当作背景上下界，取最差的一边算对比度。
//
// 退出码：有 violation 时为 1，方便提交前自查。
import { chromium } from "@playwright/test";

const BASE = process.env.LG_BASE ?? "http://127.0.0.1:5173";
const THEMES = (process.env.LG_THEMES ?? "light,dark").split(",");
const PAGES = (process.env.LG_PAGES ?? "/,/unread,/recents,/favorites,/settings")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

// 在页面里跑的取色 / 判定逻辑。
const AUDIT = () => {
  const parseColor = (value) => {
    const s = String(value).trim();
    const alphaOf = (raw) =>
      raw === undefined
        ? 1
        : raw.endsWith("%")
          ? parseFloat(raw) / 100
          : parseFloat(raw);
    let m = s.match(
      /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.%]+))?\s*\)/,
    );
    if (m) {
      const alpha = alphaOf(m[4]);
      return { r: +m[1], g: +m[2], b: +m[3], a: Number.isFinite(alpha) ? alpha : 1 };
    }
    m = s.match(
      /color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.%]+))?\s*\)/,
    );
    if (m) {
      const alpha = alphaOf(m[4]);
      return {
        r: Math.round(+m[1] * 255),
        g: Math.round(+m[2] * 255),
        b: Math.round(+m[3] * 255),
        a: Number.isFinite(alpha) ? alpha : 1,
      };
    }
    return null;
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const luminance = ({ r, g, b }) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const l1 = luminance(a);
    const l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const describe = (el) => {
    const parts = [];
    let node = el;
    for (let i = 0; node && node.nodeType === 1 && i < 4; i++) {
      let part = node.tagName.toLowerCase();
      if (node.id) part += `#${node.id}`;
      const cls = (node.getAttribute("class") || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2);
      if (cls.length) part += `.${cls.join(".")}`;
      parts.push(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };

  const items = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let node;
  while ((node = walk.nextNode())) {
    const text = node.textContent.trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    if (parseFloat(cs.opacity) < 0.15) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (el.closest(".sr-only")) continue;

    let fg = parseColor(cs.color);
    if (!fg) continue;

    // 背景：沿祖先链合成；遇到 background-image 停下（图片覆盖，静态不可判）
    const chain = [];
    let cur = el;
    let onImage = false;
    while (cur && cur.nodeType === 1) {
      const curCs = getComputedStyle(cur);
      if (curCs.backgroundImage && curCs.backgroundImage !== "none") {
        onImage = true;
        break;
      }
      const c = parseColor(curCs.backgroundColor);
      if (c) chain.push(c);
      cur = cur.parentElement;
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = chain.length - 1; i >= 0; i--) bg = over(chain[i], bg);
    if (fg.a < 1) fg = over(fg, bg);

    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;

    items.push({
      text: text.slice(0, 40),
      path: describe(el),
      size,
      weight,
      need,
      ratio: Math.round(ratio(fg, bg) * 100) / 100,
      fg: cs.color,
      bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
      onImage,
      fgRgb: fg,
      rect: {
        x: rect.x,
        y: rect.y,
        w: rect.width,
        h: rect.height,
      },
    });
  }
  return items;
};

// 像素判定：在页面里把截图画到 canvas 上，按文字包围盒采样。
//
// 判定模型：文字的可读性取决于"文字颜色"与"它周围那一圈底色"的对比。
// 取文字包围盒外 3px 的一圈像素当作底色（这一圈里没有字形，也没有
// 抗锯齿的中间色），再按"最不利的一侧"算对比度：
//   浅色文字取这一圈里最亮的像素（白字压到白墙上就是这种情况），
//   深色文字取最暗的像素。
const PIXELS = async ({ dataUrl, targets, dpr }) => {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  const luminance = (r, g, b) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (l1, l2) =>
    (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

  return targets.map((t) => {
    const x = Math.round(t.rect.x * dpr);
    const y = Math.round(t.rect.y * dpr);
    const w = Math.round(t.rect.w * dpr);
    const h = Math.round(t.rect.h * dpr);
    const band = 3;
    const rx = Math.max(0, x - band);
    const ry = Math.max(0, y - band);
    const rw = Math.min(canvas.width - rx, w + band * 2);
    const rh = Math.min(canvas.height - ry, h + band * 2);
    if (rw < 1 || rh < 1) return { ...t, pixelRatio: null };
    const data = ctx.getImageData(rx, ry, rw, rh).data;
    const lums = [];
    for (let i = 0; i < rw * rh; i++) {
      // 只取包围盒外面那一圈
      const px = i % rw;
      const py = (i / rw) | 0;
      const inside =
        px >= x - rx && px < x - rx + w && py >= y - ry && py < y - ry + h;
      if (inside) continue;
      lums.push(luminance(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]));
    }
    if (!lums.length) return { ...t, pixelRatio: null };
    lums.sort((a, b) => a - b);
    const fg = t.fgRgb;
    const fgLum = luminance(fg.r, fg.g, fg.b);
    const median = lums[Math.floor(lums.length / 2)];
    // 文字亮 → 最亮的一侧底色最糟；文字暗 → 最暗的一侧最糟。
    const lightText = fgLum >= median;
    const worstBg = lightText
      ? lums[Math.floor(lums.length * 0.9)]
      : lums[Math.floor(lums.length * 0.1)];
    const worst = ratio(fgLum, worstBg);
    return {
      ...t,
      pixelRatio: Math.round(worst * 100) / 100,
      pixelBg: `周边底色 ${worstBg.toFixed(3)}（范围 ${lums[0].toFixed(3)}–${lums[lums.length - 1].toFixed(3)}）`,
    };
  });
};

// 自检：注入两段已知好坏的文字，确认检查器能分辨。
// 工具本身如果分不出好坏，那它报"全部通过"就没有意义。
const SELF_TEST = () => {
  let top = 300;
  const mk = (bg, color, label, id) => {
    const d = document.createElement("div");
    d.id = id;
    d.style.cssText =
      `position:fixed;left:600px;top:${top}px;width:240px;height:40px;` +
      `background-image:linear-gradient(${bg});color:${color};font-size:13px;` +
      `line-height:40px;z-index:99999`;
    // 文字放在内层 span 里：检查器取的是文字包围盒外一圈像素，
    // 直接放在 div 里会取到 div 外面的页面底色。
    const span = document.createElement("span");
    span.textContent = label;
    d.appendChild(span);
    document.body.appendChild(d);
    top += 60;
  };
  mk("rgb(255,255,255)", "rgb(255,255,255)", "自检-坏-白字压白底", "self-test-bad");
  mk("rgb(0,0,0)", "rgb(255,255,255)", "自检-好-白字压黑底", "self-test-good");
  mk("rgb(120,120,120)", "rgb(255,255,255)", "自检-坏-白字压中灰底", "self-test-bad2");
};

// 等页面内容稳定：连续两次采样 innerText 长度相同才算渲染完。
// 只等固定时间会在数据慢的时候采到骨架屏，漏掉真正的文字。
async function waitForStable(page, timeout = 15000) {
  const start = Date.now();
  let last = -1;
  let stable = 0;
  while (Date.now() - start < timeout) {
    const len = await page.evaluate(() => document.body.innerText.length);
    if (len === last && len > 0) {
      stable += 1;
      if (stable >= 2) return;
    } else {
      stable = 0;
    }
    last = len;
    await page.waitForTimeout(400);
  }
}

const SELF_TEST_ONLY = process.argv.includes("--self-test");
const browser = await chromium.launch();
const violations = [];
const pixelViolations = [];
const pixelResults = [];
const coverage = [];

for (const theme of THEMES) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    colorScheme: theme,
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => {
    const raw = localStorage.getItem("local-gallery-ui");
    const parsed = raw ? JSON.parse(raw) : { state: {} };
    parsed.state = { ...(parsed.state ?? {}), theme: t };
    localStorage.setItem("local-gallery-ui", JSON.stringify(parsed));
  }, theme);

  for (const route of PAGES) {
    await page.goto(BASE + route, { waitUntil: "networkidle" });
    await waitForStable(page);
    if (SELF_TEST_ONLY) await page.evaluate(SELF_TEST);
    const items = await page.evaluate(AUDIT);
    const overImage = items.filter((i) => i.onImage);

    // 图片 / 渐变上的文字：截屏后按包围盒采样真实像素。
    if (overImage.length) {
      const shot = await page.screenshot({ type: "png" });
      const dataUrl = `data:image/png;base64,${shot.toString("base64")}`;
      const checked = await page.evaluate(PIXELS, {
        dataUrl,
        targets: overImage,
        dpr: 1,
      });
      for (const c of checked) {
        if (c.pixelRatio === null) continue;
        pixelResults.push({ theme, route, ...c });
        if (c.pixelRatio < c.need) {
          pixelViolations.push({ theme, route, ...c });
        }
      }
    }

    coverage.push({
      theme,
      route,
      count: items.length,
      overImage: overImage.length,
    });
    for (const item of items) {
      if (item.onImage) continue;
      if (item.ratio < item.need) violations.push({ theme, route, ...item });
    }
  }
  await ctx.close();
}
await browser.close();

const key = (v) => `${v.theme}|${v.route}|${v.path}|${v.text}`;
const uniq = (list) => {
  const map = new Map();
  for (const item of list) map.set(key(item), item);
  return [...map.values()].sort((a, b) => a.ratio - b.ratio);
};
const bad = uniq(violations);
const badPixels = uniq(pixelViolations);

console.log(`\n对比度审计 — ${BASE}`);
console.log(`主题：${THEMES.join(" / ")}　页面：${PAGES.join(" ")}\n`);
console.log("采样量：");
for (const c of coverage) {
  console.log(
    `  · ${c.theme} ${c.route}：${c.count} 处文字（其中 ${c.overImage} 处压在图片上，按像素判定）`,
  );
}
console.log();
if (bad.length === 0)
  console.log("✓ DOM 判定：没有低于 AA 阈值的文字。");
else {
  console.log(`✗ DOM 判定：${bad.length} 处文字低于 AA 阈值：\n`);
  for (const v of bad) {
    console.log(
      `  [${v.theme}] ${v.route}  ${v.ratio}:1 (需 ${v.need})  ${v.size}px/${v.weight}  「${v.text}」`,
    );
    console.log(`      ${v.path}`);
    console.log(`      前景 ${v.fg}  背景 ${v.bg}`);
  }
}
if (badPixels.length === 0)
  console.log("✓ 像素判定：图片 / 渐变上的文字也全部达标。");
else {
  console.log(`\n✗ 像素判定：${badPixels.length} 处图片上的文字低于 AA 阈值：\n`);
  for (const v of badPixels) {
    console.log(
      `  [${v.theme}] ${v.route}  ${v.pixelRatio}:1 (需 ${v.need})  ${v.size}px/${v.weight}  「${v.text}」`,
    );
    console.log(`      ${v.path}`);
    console.log(`      前景 ${v.fg}  采样背景 ${v.pixelBg}`);
  }
}
const worstPixels = uniq(
  pixelResults.filter((r) => r.pixelRatio !== null),
).slice(0, 8);
if (worstPixels.length) {
  console.log("· 图片上最吃紧的几处（用于人工复核）：");
  for (const v of worstPixels) {
    console.log(
      `  [${v.theme}] ${v.route}  ${v.pixelRatio}:1 (需 ${v.need})  「${v.text}」  ${v.pixelBg}`,
    );
  }
  console.log();
}
if (SELF_TEST_ONLY) {
  // 自检结论：坏样本必须被判不合格，好样本必须被判合格。
  // 工具自己分不清好坏时，它报"全部通过"就没有意义。
  const bad1 = pixelResults.find((r) => r.text?.includes("自检-坏-白字压白底"));
  const bad2 = pixelResults.find((r) => r.text?.includes("自检-坏-白字压中灰底"));
  const good = pixelResults.find((r) => r.text?.includes("自检-好"));
  const ok =
    !!bad1 && bad1.pixelRatio < bad1.need &&
    !!bad2 && bad2.pixelRatio < bad2.need &&
    !!good && good.pixelRatio >= good.need;
  console.log(
    ok
      ? "✓ 自检通过：坏样本被判不合格，好样本被判合格。"
      : `✗ 自检失败：白字压白底 ${bad1?.pixelRatio}:1、白字压中灰底 ${bad2?.pixelRatio}:1（都应低于 ${bad1?.need}），白字压黑底 ${good?.pixelRatio}:1（应不低于 ${good?.need}）`,
  );
  console.log();
  process.exit(ok ? 0 : 1);
}

process.exit(bad.length || badPixels.length ? 1 : 0);
