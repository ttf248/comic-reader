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
//   tag    —— 标签页（真实库里可能一个标签都没有，用仪表盘里的真实相册
//             伪造标签页数据，封面仍是真实缩略图）
const PAGES = (process.env.LG_PAGES ?? "/,/unread,/recents,/favorites,/settings,album,reader,tag")
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

  // 背板（backdrop）判定：这行字实际压着什么底色？
  //
  // 只看祖先链是不够的 —— 标签页 / 相册页的 hero 标题是用负边距压在
  // 封面照片上的**兄弟层**，它不在照片的 DOM 子树里，祖先链查不到，
  // 静态算出来的"纯色底"可能完全相反（白字压浅色照片：DOM 说 20:1，
  // 实际 1.4:1）。
  //
  // 但也不能靠 elementsFromPoint 找"谁画在下面"：带 pointer-events-none
  // 的渐变蒙版（首页年份卡、封面蒙版都是）根本不在那个列表里 ——
  // 实测年份大字因此被判成"白字压白底"。所以改成几何判定：
  //
  //   1. 列出所有"图层"：<img> 与带 background-image 的元素；
  //   2. 找出与文字包围盒相交、且**画在文字下面**的图层；
  //   3. 文字自己带底色时，底色以它自己为准（半透明的要看底下那张图）。
  //
  // 画在下面怎么定：图层是文字的祖先 → 在下面；否则比较层叠层级
  // （向上第一个定位祖先的 z-index），相同则按 DOM 顺序（后出现的在上）。
  const allEls = document.querySelectorAll("*");
  const domIndex = new Map();
  {
    let i = 0;
    for (const n of allEls) domIndex.set(n, i++);
  }
  const levelCache = new Map();
  const stackLevel = (el) => {
    if (levelCache.has(el)) return levelCache.get(el);
    let cur = el;
    let z = 0;
    while (cur && cur !== document.documentElement) {
      const cs = getComputedStyle(cur);
      if (cs.position !== "static") {
        const zi = cs.zIndex;
        z = zi && zi !== "auto" ? parseInt(zi, 10) : 0;
        break;
      }
      cur = cur.parentElement;
    }
    levelCache.set(el, z);
    return z;
  };
  // 图层：<img> 与带 background-image（渐变也算）的元素
  const layers = [];
  for (const n of allEls) {
    const cs = getComputedStyle(n);
    const bi = cs.backgroundImage;
    const isImg = n.tagName === "IMG";
    if (!isImg && (!bi || bi === "none")) continue;
    const r = n.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    layers.push({
      el: n,
      kind: "image",
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      z: stackLevel(n),
      dom: domIndex.get(n) ?? 0,
    });
  }
  // 图层是否画在文字下面
  const layerBelow = (textEl, layer) => {
    const le = layer.el;
    if (le.contains(textEl)) return true; // 祖先 → 在下面
    if (textEl.contains(le)) return false; // 后代 → 在上面
    const zt = stackLevel(textEl);
    if (zt !== layer.z) return zt > layer.z;
    return (domIndex.get(textEl) ?? 0) > layer.dom;
  };
  const findBackdrop = (el, rect) => {
    // 文字这一侧最上层的"底"：自己，或者最近的带背景的祖先。
    const scrim = (() => {
      let cur = el;
      while (cur && cur.nodeType === 1) {
        const cs = getComputedStyle(cur);
        const bi = cs.backgroundImage;
        if (bi && bi !== "none")
          return {
            kind: "image",
            el: cur,
            color: null,
            z: stackLevel(cur),
            dom: domIndex.get(cur) ?? 0,
          };
        const c = parseColor(cs.backgroundColor);
        if (c && c.a > 0.02)
          return {
            kind: c.a >= 0.99 ? "opaque" : "translucent",
            el: cur,
            color: c,
            z: stackLevel(cur),
            dom: domIndex.get(cur) ?? 0,
          };
        cur = cur.parentElement;
      }
      return null;
    })();
    // 与文字相交、且画在文字下面的图层
    let hit = null;
    for (const layer of layers) {
      const r = layer.rect;
      if (
        r.x >= rect.right ||
        r.x + r.w <= rect.left ||
        r.y >= rect.bottom ||
        r.y + r.h <= rect.top
      )
        continue;
      if (!layerBelow(el, layer)) continue;
      if (
        !hit ||
        layer.z > hit.z ||
        (layer.z === hit.z && layer.dom > hit.dom)
      )
        hit = layer;
    }
    // 两者里画得更上面的那个才是真正的背板
    const topmost = (a, b) => {
      if (!a) return b;
      if (!b) return a;
      if (a.z !== b.z) return a.z > b.z ? a : b;
      return a.dom > b.dom ? a : b;
    };
    const best = topmost(scrim, hit);
    if (!best) return { kind: "none", color: null, region: null, radius: 0 };
    const r = best.el.getBoundingClientRect();
    const region = { x: r.x, y: r.y, w: r.width, h: r.height };
    // 背板的圆角：圆角切掉的那几块**没有底色**，露出来的是后面那层。
    // 取样时必须把四角排除，否则会采到照片的亮部。
    const radius = (() => {
      const raw = getComputedStyle(best.el).borderTopLeftRadius;
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : 0;
    })();
    if (best.kind === "image")
      return {
        kind: "image",
        color: null,
        region,
        radius,
        self: best.el === el,
      };
    if (best.kind === "translucent") {
      // 半透明的底：底下没有图的时候静态算得出，有图就得看像素。
      if (!hit)
        return {
          kind: "translucent-static",
          color: best.color,
          region: null,
          radius,
        };
      return {
        kind: "translucent",
        color: best.color,
        region,
        radius,
        self: best.el === el,
      };
    }
    return { kind: "opaque", color: best.color, region: null, radius };
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

    // 背景：先问"背板是谁"（绘制顺序 + 几何），再决定这条文字能不能静态判。
    const backdrop = findBackdrop(el, rect);
    const onImage = backdrop.kind === "image" || backdrop.kind === "translucent";

    let bg;
    if (backdrop.kind === "opaque" && backdrop.color) {
      // 背板是不透明底色：直接用它，精确。
      bg = backdrop.color;
    } else if (backdrop.kind === "translucent-static" && backdrop.color) {
      // 半透明底、底下没有图：沿祖先链合成也是精确的。
      const chain = [];
      let cur = el;
      while (cur && cur.nodeType === 1) {
        const curCs = getComputedStyle(cur);
        if (curCs.backgroundImage && curCs.backgroundImage !== "none") break;
        const c = parseColor(curCs.backgroundColor);
        if (c) chain.push(c);
        cur = cur.parentElement;
      }
      bg = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = chain.length - 1; i >= 0; i--) bg = over(chain[i], bg);
    } else {
      // 沿祖先链合成（背板是图 / 半透明 / 找不到时的兜底）。
      const chain = [];
      let cur = el;
      while (cur && cur.nodeType === 1) {
        const curCs = getComputedStyle(cur);
        if (curCs.backgroundImage && curCs.backgroundImage !== "none") break;
        const c = parseColor(curCs.backgroundColor);
        if (c) chain.push(c);
        cur = cur.parentElement;
      }
      bg = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = chain.length - 1; i >= 0; i--) bg = over(chain[i], bg);
    }
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
      /* 像素通道的取样方式：
         self —— 文字自己的盒子就是背板（半透明的角标 / 药丸），
                 盒子里的像素是"底色 + 字形"，取中位数当底色；
         ring —— 文字压在别的一层上，取包围盒外一圈像素，
                 并裁剪到那一层的矩形内（不能采到那一层之外的像素，
                 否则会把照片上更亮 / 更暗的地方当成背板）。 */
      sampleMode: backdrop.kind === "translucent" && backdrop.self ? "self" : "ring",
      region: backdrop.region,
      radius: backdrop.radius ?? 0,
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

// 页面是否掉进了错误边界（React 渲染期异常）。
// 崩掉的页面几乎没有文字可比，报告"全部通过"是假象 —— 必须单独报出来。
const ROUTE_ERROR = () => !!document.querySelector('[role="alert"]');

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
// 判定模型：文字的可读性取决于"文字颜色"与"它背后那块底"的对比。
// 两种取样方式（由 AUDIT 按背板类型决定）：
//   ring —— 文字压在别的一层（图 / 渐变 / 半透明蒙版）上。取包围盒外
//           3px 的一圈像素，并且**裁剪到那一层的矩形内**：圈里没有
//           字形，也没有抗锯齿的中间色。再按"最不利的一侧"算：
//           浅色文字取最亮的像素（白字压到白墙上），深色文字取最暗的。
//   self —— 文字自己的盒子就是背板（半透明角标、药丸）。盒子里是
//           "底色 + 字形"混在一起的，取**中位数**当底色：字形只占
//           盒子的一小块，中位数落在底色上。
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
    const fg = t.fgRgb;
    const fgLum = luminance(fg.r, fg.g, fg.b);
    const lums = [];

    if (t.sampleMode === "self") {
      // 整盒取样：盒子里是"底色 + 字形"混在一起的。
      // 先把与文字颜色接近的像素（字形与它的抗锯齿边缘）剔掉，
      // 剩下的就是这块底色本身；再按"最不利的一侧"算 ——
      // 浅色文字取最亮的底色，深色文字取最暗的。
      //
      // 盒子必须整个落在截图里：视口外的元素取到的是"透明"像素
      // （getImageData 越界返回全 0），会被当成纯黑底色，
      // 把虚拟滚动列表里还没滚到的条目误判成不合格。
      if (w < 1 || h < 1) return { ...t, pixelRatio: null };
      if (x < 0 || y < 0 || x + w > canvas.width || y + h > canvas.height)
        return { ...t, pixelRatio: null };
      const data = ctx.getImageData(x, y, w, h).data;
      const all = [];
      const bg = [];
      for (let i = 0; i < w * h; i++) {
        const r = data[i * 4];
        const g = data[i * 4 + 1];
        const b = data[i * 4 + 2];
        const l = luminance(r, g, b);
        all.push(l);
        // 与文字颜色的距离：字形本身，以及紧贴字形的抗锯齿边缘
        const dr = r - fg.r;
        const dg = g - fg.g;
        const db = b - fg.b;
        if (Math.sqrt(dr * dr + dg * dg + db * db) > 70) bg.push(l);
      }
      if (bg.length) lums.push(...bg);
      else lums.push(...all);
      if (!lums.length) return { ...t, pixelRatio: null };
      lums.sort((a, b) => a - b);
      const median = lums[Math.floor(lums.length / 2)];
      // 只在"底色本身"的那一簇像素里找最不利的一侧。
      //
      // 为什么不直接用分位数：字形的抗锯齿边缘（字色与底色之间的中间色）
      // 数量不多但亮度分散，会被"深色文字取最暗一侧"这条规则挑中 ——
      // 一块白底深字的药丸（实测 17:1）会被算成"深底浅字"报 2.86:1。
      // 底色的中位数是稳的，围绕它取 ±0.15 的簇，既保留底色自身的
      // 明暗起伏，又把边缘像素排除在外。
      const band = lums.filter((l) => Math.abs(l - median) <= 0.15);
      const pool = band.length >= 8 ? band : lums;
      // 文字亮 → 最亮的一侧底色最糟；文字暗 → 最暗的一侧最糟。
      const lightText = fgLum >= median;
      const worstBg = lightText
        ? pool[Math.floor(pool.length * 0.9)]
        : pool[Math.floor(pool.length * 0.1)];
      const worst = ratio(fgLum, worstBg);
      return {
        ...t,
        pixelRatio: Math.round(worst * 100) / 100,
        pixelBg: `自身底色 ${worstBg.toFixed(3)}（范围 ${lums[0].toFixed(3)}–${lums[lums.length - 1].toFixed(3)}）`,
      };
    }

    const band = 3;
    const rx = Math.max(0, x - band);
    const ry = Math.max(0, y - band);
    const rw = Math.min(canvas.width - rx, w + band * 2);
    const rh = Math.min(canvas.height - ry, h + band * 2);
    if (rw < 1 || rh < 1) return { ...t, pixelRatio: null };
    const data = ctx.getImageData(rx, ry, rw, rh).data;
    // 背板层的矩形（CSS 像素）：圈到这一层之外就不算背板了。
    const region = t.region;
    for (let i = 0; i < rw * rh; i++) {
      // 只取包围盒外面那一圈
      const px = i % rw;
      const py = (i / rw) | 0;
      const inside =
        px >= x - rx && px < x - rx + w && py >= y - ry && py < y - ry + h;
      if (inside) continue;
      // 只取四条"贴着字"的直边，不取四个角上的方块。
      //
      // 角上的方块离字形最远，却常常根本没有背板：药丸 / 角标是圆角的，
      // 圆角切掉的那几块露出的是后面的照片（亮），采到它就得到"白字压在
      // 亮照片上"的假象 —— 实测一枚 bg-black/65 的深色 chip（真实对比
      // 约 9:1）被报成 1.75:1。
      const left = px < x - rx;
      const right = px >= x - rx + w;
      const top = py < y - ry;
      const bottom = py >= y - ry + h;
      const withinY = py >= y - ry && py < y - ry + h;
      const withinX = px >= x - rx && px < x - rx + w;
      const straight =
        (left && withinY) ||
        (right && withinY) ||
        (top && withinX) ||
        (bottom && withinX);
      if (!straight) continue;
      if (region) {
        const gx = (rx + px) / dpr;
        const gy = (ry + py) / dpr;
        // 背板边缘 1px 是抗锯齿的过渡带：那里的像素是"背板 + 后面那层"
        // 的混合色，不代表字背后的底色。药丸这种小背板尤其明显 ——
        // 右边缘那一列像素直接采到照片的亮部（实测 0.61），把一枚
        // 深色药丸上的白字报成 1.73:1。
        if (
          gx < region.x + 1 ||
          gx >= region.x + region.w - 1 ||
          gy < region.y + 1 ||
          gy >= region.y + region.h - 1
        )
          continue;
        // 圆角切掉的四角没有底色，露出来的是后面那层（照片）——
        // 采到它就把"深色药丸上的白字"误判成"白字压亮照片"。
        const r = t.radius ?? 0;
        if (r > 0) {
          const inCorner =
            (gx < region.x + r && gy < region.y + r) ||
            (gx > region.x + region.w - r && gy < region.y + r) ||
            (gx < region.x + r && gy > region.y + region.h - r) ||
            (gx > region.x + region.w - r && gy > region.y + region.h - r);
          if (inCorner) continue;
        }
      }
      lums.push(luminance(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]));
    }
    if (!lums.length) return { ...t, pixelRatio: null };
    lums.sort((a, b) => a - b);
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

  // 兄弟层自检：文字**不在**图的 DOM 子树里，而是靠 z-index 压在图上
  // —— 标签页 / 相册页的 hero 标题就是这个结构。祖先链查不到它，
  // 必须能证明新判据分得清好坏。
  // 图层要比文字大一圈：取样环落在文字包围盒外 3px，
  // 全落在图层里才采得到底色。
  const mkSibling = (bg, color, label, id) => {
    const layer = document.createElement("div");
    layer.style.cssText =
      `position:fixed;left:600px;top:${top}px;width:280px;height:60px;` +
      `background-image:linear-gradient(${bg});z-index:99998`;
    document.body.appendChild(layer);
    const t = document.createElement("div");
    t.id = id;
    t.style.cssText =
      `position:fixed;left:610px;top:${top + 10}px;width:240px;height:40px;` +
      `color:${color};font-size:13px;line-height:40px;z-index:99999`;
    t.textContent = label;
    document.body.appendChild(t);
    top += 70;
  };
  mkSibling(
    "rgb(255,255,255)",
    "rgb(255,255,255)",
    "自检-坏-兄弟层白字压白图",
    "self-test-sib-bad",
  );
  mkSibling(
    "rgb(0,0,0)",
    "rgb(255,255,255)",
    "自检-好-兄弟层白字压黑图",
    "self-test-sib-good",
  );

  // 半透明角标自检：角标自己有 85% 不透明的底，压在照片上。
  // 这种"自己的盒子就是背板"的情况，取样必须落在盒子内部
  // （取整盒中位数），否则会拿角标外的照片像素当底色 ——
  // 报出假的不合格（好样本变坏），或者漏掉真问题（坏样本变好）。
  const mkChip = (photo, chip, color, id) => {
    const layer = document.createElement("div");
    layer.style.cssText =
      `position:fixed;left:600px;top:${top}px;width:240px;height:40px;` +
      `background-image:linear-gradient(${photo});z-index:99998`;
    document.body.appendChild(layer);
    const chipEl = document.createElement("div");
    chipEl.id = id;
    chipEl.style.cssText =
      `position:absolute;left:8px;top:8px;width:40px;height:24px;` +
      `background:${chip};color:${color};font-size:13px;line-height:24px;` +
      `text-align:center;z-index:99999`;
    chipEl.textContent = "9";
    layer.appendChild(chipEl);
    top += 60;
  };
  mkChip(
    "rgb(0,0,0)",
    "rgba(255,255,255,0.85)",
    "rgb(20,20,20)",
    "self-test-chip-good",
  );
  mkChip(
    "rgb(0,0,0)",
    "rgba(255,255,255,0.85)",
    "rgb(255,255,255)",
    "self-test-chip-bad",
  );

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

// 标签页：真实库里可能一个标签都没有（/api/tags 返回空数组），
// 那这一页永远不会被量到。用仪表盘里的真实相册伪造一份标签页数据 ——
// 封面走的是真实缩略图，版式与配色是真的，只是"标签"是假的。
// 标签页的审计数据。
//
// 真实库里**有**标签时就用真的（e2e 造的临时库就有：测试 / 空 格 / C++ …），
// 只有库里一个标签都没有时才用仪表盘里的真实相册伪造一份 —— 伪造数据
// 只能验证版式，验证不了"标签名很长 / 带特殊字符"时的真实表现。
// 用了哪种数据会在输出里写明，免得把伪造结果当成真实结果。
let tagAuditState = { tag: null, faked: false };

async function resolveTagName(page) {
  const res = await page.request.get(`${BASE}/api/tags`);
  if (res.ok()) {
    const body = await res.json();
    const items = body?.page?.items ?? [];
    const hit = items.find((t) => t && t.tag && (t.count ?? 0) > 0) ?? items[0];
    if (hit?.tag) return { tag: hit.tag, faked: false };
  }
  return { tag: "审计用标签", faked: true };
}

async function prepareTagRoute(page) {
  const state = await resolveTagName(page);
  tagAuditState = state;
  if (!state.faked) return; // 真实数据：不用拦截
  await page.route(
    (url) => url.pathname.includes("/api/tags/") && url.pathname.endsWith("/albums"),
    async (route) => {
      const data = await page.evaluate(async () => {
        const r = await fetch("/api/library/dashboard");
        const j = await r.json();
        const items = j.dashboard?.unread ?? [];
        return {
          revision: j.dashboard?.revision ?? 0,
          items,
          total: items.length,
        };
      });
      await route.fulfill({ json: { ok: true, page: data } });
    },
  );
}

const SELF_TEST_ONLY = process.argv.includes("--self-test");
const browser = await chromium.launch();
const violations = [];
const pixelViolations = [];
const pixelResults = [];
const iconViolations = [];
const iconResults = [];
const coverage = [];
const routeErrors = [];

for (const theme of THEMES) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    colorScheme: theme,
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await prepareTagRoute(page);
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
      // 伪路由 tag：标签页用固定的标签名，数据由 prepareTagRoute 伪造。
      const target =
        route === "album"
          ? await resolveAlbumRoute(page)
          : route === "tag"
            ? `/tags/${encodeURIComponent(tagAuditState.tag)}`
            : route;
      if (!target) {
        console.log(`  · 跳过 ${theme} ${route}：库里没有可打开的相册`);
        continue;
      }
      await page.goto(BASE + target, { waitUntil: "networkidle" });
      await waitForStable(page);
    }
    if (SELF_TEST_ONLY) await page.evaluate(SELF_TEST);
    let items = await page.evaluate(AUDIT);
    // 偶发的渲染异常（相册页的虚拟列表爆栈）重试一次再判。
    if (await page.evaluate(ROUTE_ERROR)) {
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForStable(page);
      items = await page.evaluate(AUDIT);
    }
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

    const routeError = await page.evaluate(ROUTE_ERROR);
    if (routeError) routeErrors.push({ theme, route });
    coverage.push({
      theme,
      route,
      count: items.length,
      overImage: overImage.length,
      routeError,
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

if (routeErrors.length === 0) {
  console.log("✓ 页面加载：所有路由都正常渲染。");
} else {
  console.log(
    `✗ 页面加载失败：${routeErrors.length} 处（重试后仍掉进错误边界）`,
  );
  for (const e of routeErrors) {
    console.log(`  · ${e.theme} ${e.route}`);
  }
}
console.log("");
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
  const byId = (list, id) =>
    list.find((r) => (r.path ?? "").includes(`#${id}`));
  const bad1 = byId(pixelResults, "self-test-bad");
  const bad2 = byId(pixelResults, "self-test-bad2");
  const good = byId(pixelResults, "self-test-good");
  const sibBad = byId(pixelResults, "self-test-sib-bad");
  const sibGood = byId(pixelResults, "self-test-sib-good");
  const chipBad = byId(pixelResults, "self-test-chip-bad");
  const chipGood = byId(pixelResults, "self-test-chip-good");
  const badIcon = iconResults.find((r) => r.text?.includes("自检-坏图标"));
  const goodIcon = iconResults.find((r) => r.text?.includes("自检-好图标"));
  const passes = (r) => !!r && r.pixelRatio !== null && r.pixelRatio < r.need;
  const okOf = (r) => !!r && r.pixelRatio !== null && r.pixelRatio >= r.need;
  const ok =
    passes(bad1) &&
    passes(bad2) &&
    okOf(good) &&
    passes(sibBad) &&
    okOf(sibGood) &&
    passes(chipBad) &&
    okOf(chipGood) &&
    !!badIcon &&
    badIcon.pixelRatio < badIcon.need &&
    !!goodIcon &&
    goodIcon.pixelRatio >= goodIcon.need;
  const fmt = (r) =>
    r ? `${r.pixelRatio}:1（需 ${r.need}）` : "未采到样本";
  console.log(
    ok
      ? "✓ 自检通过：文字与图标的坏样本都被判不合格，好样本都被判合格。"
      : `✗ 自检失败：
    白字压白底 ${fmt(bad1)}、白字压中灰底 ${fmt(bad2)}（都应低于阈值）；
    白字压黑底 ${fmt(good)}（应不低于阈值）；
    兄弟层白字压白图 ${fmt(sibBad)}、白字压黑图 ${fmt(sibGood)}；
    半透明角标白字 ${fmt(chipBad)}、深字 ${fmt(chipGood)}；
    白图标压白底 ${badIcon?.pixelRatio}:1（应低于 3），白图标压黑底 ${goodIcon?.pixelRatio}:1（应不低于 3）`,
  );
  console.log();
  process.exit(ok ? 0 : 1);
}
if (routeErrors.length > 0) {
  console.error("\n存在加载失败的页面。");
  process.exit(1);
}

process.exit(bad.length || badPixels.length || badIcons.length ? 1 : 0);
