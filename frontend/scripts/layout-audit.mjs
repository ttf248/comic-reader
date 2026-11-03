// 布局与排版审计：量化「内容有效宽度」「控件字号」「溢出」等设计指标。
//
// 用法：
//   npm run audit:layout                                   # 默认页面 / 断点 / 明暗
//   LG_BASE=http://127.0.0.1:5173 npm run audit:layout
//   LG_PAGES=/,/unread npm run audit:layout
//   LG_VIEWPORTS=390x844,1440x900 npm run audit:layout
//   LG_THEMES=dark npm run audit:layout
//   LG_VIEWMODE=list npm run audit:layout                  # 审计列表视图
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
// 页面清单里可以写伪路由：
//   album  —— 相册详情页（id 每次运行不同，从仪表盘现取一本图多的相册）
//   reader —— 阅读器（沉浸场景：顶栏 + 画面 + 浮动工具条 + 底部翻页条）
//   tag    —— 标签页（真实库里可能一个标签都没有，用仪表盘里的真实相册
//             伪造标签页数据，封面仍是真实缩略图）
const PAGES = (process.env.LG_PAGES ?? "/,/recents,/favorites,/unread,/settings,album,reader,tag")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
// 视图模式：grid（默认）/ list。列表视图是另一套排版（行式），
// 字号与控件尺寸都要单独量一遍，不能拿网格视图的数据代替。
const VIEWMODE = process.env.LG_VIEWMODE ?? "grid";
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

  // 页面是否掉进了错误边界（React 渲染期异常）。
  // 掉进去的页面没有内容可量：把它当成"内容左缘不对齐"是误导，
  // 必须单独报出来（相册详情页偶发爆栈就是这一类）。
  const routeError = !!document.querySelector('[role="alert"]');

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

  // 有效内容范围：main 里可见的"叶子内容"（文字 / 图片 / 控件）的并集。
  //
  // 容器宽度 ≠ 内容宽度。设置页的容器铺满整个主区，实际内容却只有
  // 768px 一列 —— 只看容器宽度，这一页会被记成"和其他页一样宽"，
  // 它的居中窄列（1440 下比其它页右移 237px）就永远不会被发现。
  //
  // 左缘尤其重要：所有页面的内容左缘应当落在同一条网格线上，
  // 否则从列表页切到设置页，整页内容会横向跳一下。
  const inkLeft = { v: Infinity };
  const inkRight = { v: -Infinity };
  const inkWidth = { v: 0 };
  const inkLeaves = [];
  // 横向滚动容器里的内容（首页的横向货架）会被容器裁掉，
  // 不能按它的原始位置算内容范围 —— 否则首页在 390px 下会被算成
  // "内容宽 958px"。
  const clippedRect = (el) => {
    const rect = el.getBoundingClientRect();
    let out = rect;
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      const cs = getComputedStyle(cur);
      if (/(auto|scroll|hidden)/.test(cs.overflowX)) {
        const cr = cur.getBoundingClientRect();
        const left = Math.max(out.left, cr.left);
        const right = Math.min(out.right, cr.right);
        if (right - left < 1) return null;
        out = new DOMRect(left, out.top, right - left, out.height);
      }
      cur = cur.parentElement;
    }
    return out;
  };
  const consider = (el) => {
    if (!visible(el)) return;
    const rect = clippedRect(el);
    if (!rect || rect.width < 1 || rect.height < 1) return;
    inkLeft.v = Math.min(inkLeft.v, rect.left);
    inkRight.v = Math.max(inkRight.v, rect.right);
    inkLeaves.push(rect);
  };
  if (main) {
    const walk = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walk.nextNode())) {
      if (!node.textContent.trim()) continue;
      if (node.parentElement) consider(node.parentElement);
    }
    // 图片里 alt 为空的是装饰图（相册页的模糊底图、标签页的头图底衬），
    // 它们本来就故意铺满并溢出容器，不能算进"内容范围"。
    for (const el of main.querySelectorAll("img")) {
      if (el.getAttribute("alt") === "") continue;
      consider(el);
    }
  }
  const effectiveLeft = Number.isFinite(inkLeft.v) ? Math.round(inkLeft.v) : null;
  const effectiveRight = Number.isFinite(inkRight.v) ? Math.round(inkRight.v) : null;
  const effectiveWidth =
    effectiveLeft !== null && effectiveRight !== null
      ? effectiveRight - effectiveLeft
      : null;

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
    routeError,
    effectiveWidth,
    effectiveLeft,
    effectiveRatio:
      effectiveWidth === null
        ? null
        : Math.round((effectiveWidth / viewportWidth) * 1000) / 1000,
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
  await page.evaluate(({ t, vm }) => {
    const raw = localStorage.getItem("local-gallery-ui");
    const parsed = raw ? JSON.parse(raw) : { state: {} };
    parsed.state = { ...(parsed.state ?? {}), theme: t, viewMode: vm };
    localStorage.setItem("local-gallery-ui", JSON.stringify(parsed));
  }, { t: theme, vm: VIEWMODE });
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

// 进入阅读器：阅读器是沉浸场景（顶栏 + 画面 + 浮动工具条 + 底部翻页条），
// 它的控件尺寸与字号自成一套，从没被布局审计量过。
//
// 取仪表盘里一本图多的**图片**相册（视频相册进的是 /gallery 的视频模式，
// 版式不同）再点「开始浏览 / 继续上次」进阅读器；
// 用 domcontentloaded 而不是 networkidle —— 阅读器里有 SSE 与预览图请求，
// networkidle 会一直等不到。
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
  await page.goto(`${BASE}/albums/${encodeURIComponent(albumId)}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(1500);
  // 图片相册的主操作是「开始浏览」；读过一点的相册是「继续上次」。
  const start = page
    .getByRole("button", { name: /开始浏览|继续上次/ })
    .first();
  if ((await start.count()) > 0) await start.click();
  // 等路由真的切到阅读器，再等画面与工具条渲染完。
  const opened = await page
    .waitForURL(/\/gallery/, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) return false;
  await page.waitForTimeout(1500);
  return true;
}

// 标签页的数据来源。
//
// 真实库里**有**标签时就用真的（e2e 造的临时库就有：测试 / 空 格 / C++ …），
// 只有库里一个标签都没有时，才用仪表盘里的真实相册伪造一份 —— 伪造数据
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

async function main() {
  const browser = await chromium.launch();
  const report = [];
  const routeErrors = [];
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

      await prepareTagRoute(page);

      for (const route of PAGES) {
        if (route === "reader") {
          if (!(await openReader(page))) {
            console.log(`  · 跳过 ${theme} reader：库里没有可打开的相册`);
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
          // 不用 networkidle：页面含 SSE 长连接，且 /api/previews 首次生成
          // 预览图可能耗时数秒，networkidle 会一直等不到而超时。
          await page.goto(BASE + target, {
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
        }
        let m = await page.evaluate(MEASURE, { minFontPx: MIN_FONT_PX, minControlPx: MIN_CONTROL_PX });
        // 偶发的渲染异常（相册页的虚拟列表爆栈）重试一次再判：
        // 重试后仍然报错才算这一页真的坏了。
        if (m.routeError) {
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.waitForTimeout(900);
          m = await page.evaluate(MEASURE, { minFontPx: MIN_FONT_PX, minControlPx: MIN_CONTROL_PX });
        }
        report.push({ theme, route, vp: `${viewport.width}x${viewport.height}`, ...m });
        if (m.overflowPx > 0) failed = true;
        if (m.routeError) {
          routeErrors.push({ theme, route, vp: `${viewport.width}x${viewport.height}` });
        }
      }
      await ctx.close();
    }
  }
  await browser.close();

  // 内容左缘对齐检查：同一断点下，所有页面的内容都应落在同一条网格线上。
  //
  // 这条检查是给"页面被居中窄列"这类问题准备的：容器宽度看起来一样，
  // 但内容整体右移了几百像素，从列表页切过去整页会横向跳一下。
  // 阅读器是沉浸场景（画布铺满），不参与对齐检查。
  const misaligned = [];
  {
    const groups = new Map();
    for (const r of report) {
      if (r.route === "reader" || r.effectiveLeft === null) continue;
      const key = `${r.vp}|${r.theme}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    for (const [key, rows] of groups) {
      const counts = new Map();
      for (const r of rows) {
        counts.set(r.effectiveLeft, (counts.get(r.effectiveLeft) ?? 0) + 1);
      }
      // 多数派就是这一档的网格线
      let baseline = null;
      let best = -1;
      for (const [left, n] of counts) {
        if (n > best) {
          best = n;
          baseline = left;
        }
      }
      for (const r of rows) {
        if (r.routeError) continue; // 页面本身崩了，不参与对齐比较
        if (Math.abs(r.effectiveLeft - baseline) > 2) {
          misaligned.push({
            vp: r.vp,
            theme: r.theme,
            route: r.route,
            effectiveLeft: r.effectiveLeft,
            expected: baseline,
          });
        }
      }
    }
  }

  const asJson = process.argv.includes("--json");
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      [
        "断点          主题   路由        内容宽  占比   左右留白  有效宽 有效左  溢出  <12.5px文本  小控件",
        ...report.map((r) =>
          [
            r.vp.padEnd(14),
            r.theme.padEnd(6),
            r.route.padEnd(11),
            String(r.contentWidth).padEnd(7),
            `${(r.contentWidthRatio * 100).toFixed(1)}%`.padEnd(6),
            String(r.gutter).padEnd(9),
            String(r.effectiveWidth ?? "-").padEnd(7),
            String(r.effectiveLeft ?? "-").padEnd(7),
            String(r.overflowPx).padEnd(5),
            String(r.tinyTextTotal).padEnd(11),
            String(r.smallControlsTotal),
          ].join(" "),
        ),
      ].join("\n"),
    );
    console.log("");
    if (routeErrors.length === 0) {
      console.log("✓ 页面加载：所有路由都正常渲染。");
    } else {
      console.log(
        `✗ 页面加载失败：${routeErrors.length} 处（重试后仍掉进错误边界）`,
      );
      for (const e of routeErrors) {
        console.log(`  · ${e.vp} ${e.theme} ${e.route}`);
      }
    }
    if (misaligned.length === 0) {
      console.log("✓ 内容左缘对齐：同一断点下所有页面落在同一条网格线上。");
    } else {
      console.log(
        `✗ 内容左缘不对齐：${misaligned.length} 处（同一断点下不同页面的内容左缘相差超过 2px）`,
      );
      for (const m of misaligned) {
        console.log(
          `  · ${m.vp} ${m.theme} ${m.route}：内容左缘 ${m.effectiveLeft}，本档网格线 ${m.expected}`,
        );
      }
    }
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
  if (misaligned.length > 0) {
    console.error("\n存在内容左缘不对齐的页面。");
    process.exit(1);
  }
  if (routeErrors.length > 0) {
    console.error("\n存在加载失败的页面。");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
