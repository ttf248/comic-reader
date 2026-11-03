// 相册页爆栈探针：量化「相册详情页掉进错误边界」的次数。
//
// 背景：相册页偶发整页崩掉（`Maximum call stack size exceeded`，
// react-virtuoso 的网格状态机递归过深）。这个 bug 靠"看一次页面"发现不了 ——
// 它是概率性的，而且跟虚拟窗口的数字强相关：把
// `increaseViewportBy.bottom` 从 720 调到 480，同一份代码的崩溃率会从
// 0/20 变成 13/20。因此它需要一个能给出**数字**的探针，而不是靠人肉盯。
//
// 用法：
//   node scripts/album-crash-probe.mjs
//   LG_BASE=http://127.0.0.1:5179 npm run audit:crash
//   LG_CRASH_VISITS=20 npm run audit:crash               # 访问次数
//   LG_CRASH_ALBUM=sample-paged-videos npm run audit:crash  # 指定相册
//   LG_CRASH_VIEWPORT=1440x900 npm run audit:crash        # 视口
//   LG_CRASH_MOCK_THUMBS=1 npm run audit:crash            # 用假缩略图（默认用真实缩略图）
//
// 退出码：只要有一次崩掉就是 1，方便提交前自查。
//
// 注意：这个探针量的是**当前代码**的崩溃率，不是"有没有 bug"。同一个数字在
// 不同机器负载下会浮动，所以比较两个版本时要用同样的访问次数、同样的视口、
// 同样的缩略图来源，各跑几轮取趋势。
import { chromium } from "@playwright/test";

const BASE = process.env.LG_BASE ?? "http://127.0.0.1:5173";
const VISITS = Math.max(1, Number(process.env.LG_CRASH_VISITS ?? 10));
const ALBUM_NAME = process.env.LG_CRASH_ALBUM ?? "";
const [vw, vh] = (process.env.LG_CRASH_VIEWPORT ?? "1280x720")
  .split("x")
  .map(Number);
const MOCK_THUMBS = process.env.LG_CRASH_MOCK_THUMBS === "1";

/** 取一本媒体最多的相册：条目越多，虚拟网格的测量压力越大。 */
async function pickAlbum() {
  const manifest = await (
    await fetch(`${BASE}/api/library/manifest`, { cache: "no-store" })
  ).json();
  const root = manifest?.manifest?.roots?.[0];
  if (!root) throw new Error("媒体库还没扫描，先跑一次扫描");
  const children = await (
    await fetch(`${BASE}/api/library/${root.id}/children?limit=200`, {
      cache: "no-store",
    })
  ).json();
  const items = children?.page?.items ?? [];
  if (items.length === 0) throw new Error("媒体库里没有相册");
  if (ALBUM_NAME) {
    const hit = items.find((item) => item.name === ALBUM_NAME);
    if (!hit) {
      throw new Error(
        `找不到相册 ${ALBUM_NAME}（可选：${items
          .slice(0, 8)
          .map((i) => i.name)
          .join(" / ")}）`,
      );
    }
    return hit;
  }
  return items.reduce((best, item) =>
    (item.imageCount ?? 0) > (best.imageCount ?? 0) ? item : best,
  );
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const album = await pickAlbum();
console.log(
  `相册：${album.name}（媒体 ${album.imageCount ?? "?"}） · 视口 ${vw}x${vh} · 访问 ${VISITS} 次`,
);

const browser = await chromium.launch();
let crashes = 0;
const stacks = new Set();
for (let i = 0; i < VISITS; i++) {
  const context = await browser.newContext({
    viewport: { width: vw, height: vh },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    const first = String(error.stack ?? error.message).split("\n")[0];
    stacks.add(first);
  });
  if (MOCK_THUMBS) {
    await page.route("**/api/thumbs/**", (route) =>
      route.fulfill({ contentType: "image/png", body: PNG }),
    );
  }
  await page.goto(`${BASE}/albums/${album.id}`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .waitForSelector("[data-virtuoso-scroller]", { timeout: 15000 })
    .catch(() => {});
  await page.waitForTimeout(1200);
  const alert = page.locator('[role="alert"]').first();
  const broken = (await alert.count()) > 0;
  const text = broken
    ? (await alert.innerText()).replace(/\s+/g, " ").trim()
    : "";
  const crashed = broken && /call stack|加载异常/i.test(text);
  if (crashed) {
    crashes++;
    console.log(`  #${i} 崩了：${text.slice(0, 80)}`);
  } else {
    console.log(`  #${i} 正常`);
  }
  await context.close();
}
await browser.close();

console.log(`\n崩溃率：${crashes}/${VISITS}`);
if (stacks.size > 0) {
  console.log("首个错误：");
  for (const line of stacks) console.log(`  ${line}`);
}
process.exit(crashes > 0 ? 1 : 0);
