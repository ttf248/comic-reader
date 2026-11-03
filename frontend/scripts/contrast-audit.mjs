// 对比度审计：抓取运行中的界面，按 WCAG 2.1 AA 检查文字对比度。
//
// 用法：
//   npm run audit:contrast                                  # 需要先起 dev server（默认 5173）
//   LG_BASE=http://127.0.0.1:8080 npm run audit:contrast
//   LG_PAGES=/,/unread npm run audit:contrast              # 自定义页面
//   LG_PAGES=reader npm run audit:contrast                # 只审计阅读器
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
// 页面清单里可以写伪路由：
//   album  —— 相册详情页（id 每次运行不同，从仪表盘现取一本图多的相册）
//   reader —— 阅读器（见下方 openReader）
const PAGES = (process.env.LG_PAGES ?? "/,/unread,/recents,/favorites,/settings,album,reader")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
// 视图模式：grid（默认）/ list。列表视图用另一套字号与配色。
const VIEWMODE = process.env.LG_VIEWMODE ?? "grid";

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

// 图标（非文本内容）对比度通道。
//
// 为什么单独一条通道：图标是 SVG，**没有文字节点** —— 上面的文本通道
// 完全看不到它们。上一轮就漏掉了"白色箭头压在明亮照片上几乎看不见"
// 这种问题（实测 1.4:1，而 WCAG 1.4.11 对非文本控件要求 ≥ 3:1）。
//
// 判定模型与文字一致：取图标包围盒外一圈像素当底色，按"最不利的一侧"
// 算对比度（浅色图标取最亮的一边，深色图标取最暗的一边）。
const ICONS = () => {
  const parseColor = (value) => {
    const s = String(value).trim();
    let m = s.match(
      /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.%]+))?\s*\)/,
    );
    if (m) {
      const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return { r: +m[1], g: +m[2], b: +m[3], a: Number.isFinite(alpha) ? alpha : 1 };
    }
    m = s.match(
      /color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.%]+))?\s*\)/,
    );
    if (m) {
      const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return {
        r: Math.round(+m[1] * 255),
        g: Math.round(+m[2] * 255),
        b: Math.round(+m[3] * 255),
        a: Number.isFinite(alpha) ? alpha : 1,
      };
    }
    return null;
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
  for (const svg of document.querySelectorAll("svg")) {
    const rect = svg.getBoundingClientRect();
    if (rect.width < 6 || rect.height < 6) continue;
    const cs = getComputedStyle(svg);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    // 祖先的 opacity 会一起作用（整组淡出的控件不该按"看得见"判）
    let opacity = 1;
    for (let n = svg; n && n.nodeType === 1; n = n.parentElement) {
      opacity *= parseFloat(getComputedStyle(n).opacity);
      if (opacity < 0.15) break;
    }
    if (opacity < 0.15) continue;
    // 纯装饰图标（aria-hidden）不做要求
    if (svg.closest('[aria-hidden="true"]')) continue;
    const fg = parseColor(cs.color);
    if (!fg || fg.a < 0.15) continue;
    const host = svg.closest("button, a, [role='menuitem'], [role='tab']");
    const labelHost = svg.closest("[aria-label], [title]") ?? host;
    const label = (
      svg.getAttribute("aria-label") ||
      labelHost?.getAttribute("aria-label") ||
      labelHost?.getAttribute("title") ||
      host?.textContent ||
      ""
    )
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 40);
    items.push({
      text: label || "(无标签图标)",
      path: describe(svg),
      fg: cs.color,
      fgRgb: fg,
      need: 3,
      size: rect.width,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
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

  // 图标自检：SVG 没有文字节点，必须单独证明这条通道也分得清好坏。
  // 图标要在底色块里居中：取样环是包围盒外 3px 的一圈，
  // 图标贴着底色块边缘时，环会采到块外的页面底色。
  const mkIcon = (bg, color, label) => {
    const d = document.createElement("div");
    d.title = label;
    d.style.cssText =
      `position:fixed;left:600px;top:${top}px;width:48px;height:48px;` +
      `display:flex;align-items:center;justify-content:center;` +
      `background-image:linear-gradient(${bg});color:${color};z-index:99999`;
    d.innerHTML =
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2"><path d="M3 12h18"/></svg>';
    document.body.appendChild(d);
    top += 60;
  };
  mkIcon("rgb(255,255,255)", "rgb(255,255,255)", "自检-坏图标-白图标压白底");
  mkIcon("rgb(0,0,0)", "rgb(255,255,255)", "自检-好图标-白图标压黑底");
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

// 相册详情页的 id 每次运行都不同：现从仪表盘取一本图多的相册。
async function resolveAlbumRoute(page) {
  const id = await page.evaluate(async () => {
    const r = await fetch("/api/library/dashboard");
    if (!r.ok) return null;
    const j = await r.json();
    const all = [
      ...(j.dashboard?.unread ?? []),
      ...(j.dashboard?.inProgress ?? []).map((p) => p.album),
    ];
    const hit =
      all.find((a) => (a.imageCount ?? 0) > 3 && !(a.videoCount > 0)) ??
      all[0];
    return hit?.id ?? null;
  });
  return id ? `/albums/${encodeURIComponent(id)}` : null;
}

// 进入阅读器：阅读器的浮层（顶栏、底栏、药丸工具条）全部是"压在图片上的
// 白字"，静态算不出背景，只能靠像素判定那一遍。
//
// 直接构造 /gallery?path=<相册 id> 进阅读器：走"相册页 → 点开始浏览"
// 会带上一条「开始浏览」的 toast，它会盖住阅读器底部的浮动工具条，
// 拍出来的 / 采样到的不是真实版式。
async function openReader(page) {
  const albumId = await page.evaluate(async () => {
    const r = await fetch("/api/library/dashboard");
    if (!r.ok) return null;
    const j = await r.json();
    const all = [
      ...(j.dashboard?.unread ?? []),
      ...(j.dashboard?.inProgress ?? []).map((p) => p.album),
    ];
    const hit =
      all.find((a) => (a.imageCount ?? 0) > 3 && !(a.videoCount > 0)) ??
      all.find((a) => !(a.videoCount > 0));
    return hit?.id ?? null;
  });
  if (!albumId) return false;
  const qs = new URLSearchParams({ path: albumId, index: "0" });
  await page.goto(`${BASE}/gallery?${qs.toString()}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(2200);
  await waitForStable(page);
  return page.url().includes("/gallery");
}

const SELF_TEST_ONLY = process.argv.includes("--self-test");
const browser = await chromium.launch();
const violations = [];
const pixelViolations = [];
const pixelResults = [];
const iconViolations = [];
const iconResults = [];
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
  await page.evaluate(({ t, vm }) => {
    const raw = localStorage.getItem("local-gallery-ui");
    const parsed = raw ? JSON.parse(raw) : { state: {} };
    parsed.state = { ...(parsed.state ?? {}), theme: t, viewMode: vm };
    localStorage.setItem("local-gallery-ui", JSON.stringify(parsed));
  }, { t: theme, vm: VIEWMODE });

  for (const route of PAGES) {
    if (route === "reader") {
      if (!(await openReader(page))) {
        console.log(`  · 跳过 ${theme} reader：仪表盘里没有可打开的相册`);
        continue;
      }
    } else {
      // 伪路由 album：相册详情页的 id 运行时现取。
      const target =
        route === "album" ? await resolveAlbumRoute(page) : route;
      if (!target) {
        console.log(`  · 跳过 ${theme} ${route}：库里没有可打开的相册`);
        continue;
      }
      await page.goto(BASE + target, { waitUntil: "networkidle" });
      await waitForStable(page);
    }
    if (SELF_TEST_ONLY) await page.evaluate(SELF_TEST);
    const items = await page.evaluate(AUDIT);
    const overImage = items.filter((i) => i.onImage);
    const icons = await page.evaluate(ICONS);

    // 图片 / 渐变上的文字 + 全部图标：截屏后按包围盒采样真实像素。
    if (overImage.length || icons.length) {
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
      // 图标通道：阈值 3:1（WCAG 1.4.11 非文本对比度）
      const checkedIcons = await page.evaluate(PIXELS, {
        dataUrl,
        targets: icons,
        dpr: 1,
      });
      for (const c of checkedIcons) {
        if (c.pixelRatio === null) continue;
        iconResults.push({ theme, route, ...c });
        if (c.pixelRatio < c.need) {
          iconViolations.push({ theme, route, ...c });
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
  // 文字通道用 ratio，像素 / 图标通道用 pixelRatio —— 排序按实际生效的那个。
  return [...map.values()].sort(
    (a, b) => (a.pixelRatio ?? a.ratio) - (b.pixelRatio ?? b.ratio),
  );
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

// 图标通道：WCAG 1.4.11（非文本内容）阈值 3:1。
const badIcons = uniq(iconViolations);
if (badIcons.length === 0)
  console.log("✓ 图标判定：所有图标与周边底色的对比度都 ≥ 3:1。");
else {
  console.log(`\n✗ 图标判定：${badIcons.length} 处图标低于 3:1（非文本内容阈值）：\n`);
  for (const v of badIcons) {
    console.log(
      `  [${v.theme}] ${v.route}  ${v.pixelRatio}:1 (需 ${v.need})  ${v.size}px  「${v.text}」`,
    );
    console.log(`      ${v.path}`);
    console.log(`      前景 ${v.fg}  采样背景 ${v.pixelBg}`);
  }
}
const worstIcons = uniq(iconResults.filter((r) => r.pixelRatio !== null))
  .slice(0, 10);
if (worstIcons.length) {
  console.log("\n· 图标里最吃紧的几处（用于人工复核）：");
  for (const v of worstIcons) {
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
  const badIcon = iconResults.find((r) => r.text?.includes("自检-坏图标"));
  const goodIcon = iconResults.find((r) => r.text?.includes("自检-好图标"));
  const ok =
    !!bad1 && bad1.pixelRatio < bad1.need &&
    !!bad2 && bad2.pixelRatio < bad2.need &&
    !!good && good.pixelRatio >= good.need &&
    !!badIcon && badIcon.pixelRatio < badIcon.need &&
    !!goodIcon && goodIcon.pixelRatio >= goodIcon.need;
  console.log(
    ok
      ? "✓ 自检通过：文字与图标的坏样本都被判不合格，好样本都被判合格。"
      : `✗ 自检失败：白字压白底 ${bad1?.pixelRatio}:1、白字压中灰底 ${bad2?.pixelRatio}:1（都应低于 ${bad1?.need}），白字压黑底 ${good?.pixelRatio}:1（应不低于 ${good?.need}）；白图标压白底 ${badIcon?.pixelRatio}:1（应低于 3），白图标压黑底 ${goodIcon?.pixelRatio}:1（应不低于 3）`,
  );
  console.log();
  process.exit(ok ? 0 : 1);
}

process.exit(bad.length || badPixels.length || badIcons.length ? 1 : 0);
