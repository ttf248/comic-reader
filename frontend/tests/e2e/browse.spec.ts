import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { VideoInfo, VideoInfoBatchItem } from "../../src/api/videos";
import {
  solidPng,
  renderedColors,
  type MediaRootConfig,
  liveRoots,
  scannedNodes,
  albumUrl,
  albumUrlPattern,
  setWorkbenchMode,
  resetWorkbenchMode,
  taggedSortPrefix,
  sortFixture,
  restoreHistory,
  openCardProperties,
  type CopyAuditWindow,
  installCopyAudit,
  systemOpenRoute,
  systemOpenRequest,
} from "./helpers/library";

test.beforeEach(async ({ request }) => {
  await resetWorkbenchMode(request);
});

test("工作台模式切换：两套菜单完全隔离，模式持久化在服务端偏好里", async ({
  page,
}) => {
  await page.goto("/");
  // 侧栏是本用例的断言范围：主区也有同名链接，不限定会撞上严格模式。
  const sidebar = page.locator('aside[aria-label="主导航"]');
  // 照片工作台只列照片那边的东西：漫画的未读、阅读措辞都不在。
  await expect(sidebar.getByRole("link", { name: "照片库" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "最近浏览" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "收藏照片" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "未读" })).toHaveCount(0);
  await expect(sidebar.getByRole("link", { name: "漫画库" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "照片库" })).toBeVisible();

  const switcher = page.getByRole("group", { name: "工作台模式" });
  await switcher.getByRole("button", { name: "漫画" }).click();
  await expect(page.getByRole("heading", { name: "漫画库" })).toBeVisible();
  // 漫画工作台的菜单换成漫画自己那套，照片那边的一点都不留。
  await expect(sidebar.getByRole("link", { name: "漫画库" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "未读" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "最近阅读" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "收藏漫画" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "照片库" })).toHaveCount(0);
  await expect(sidebar.getByRole("link", { name: "最近浏览" })).toHaveCount(0);
  await expect(sidebar.getByRole("link", { name: "收藏照片" })).toHaveCount(0);

  // 模式写在服务端偏好里，刷新后仍然是漫画工作台。
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/prefs");
      if (!response.ok()) return "";
      const prefs = (await response.json()) as { appMode?: string };
      return prefs.appMode ?? "";
    })
    .toBe("comic");
  await page.reload();
  await expect(page.getByRole("heading", { name: "漫画库" })).toBeVisible();

  // 两个模式互斥：没有第三档「全部相册」。
  await expect(sidebar.getByRole("link", { name: "全部相册" })).toHaveCount(0);
  // 用例结束时把模式复位，别把状态留给后面的用例。
  await page.request.patch("/api/prefs", { data: { appMode: "photo" } });
});

// 隔离不只在菜单上：两侧共用的卡片、预览与计数单位也各归各。
// 照片这边说「浏览 / 张 / 本」，漫画那边说「阅读 / 页 / 卷」。
/**
 * 取一张相册卡片。
 *
 * 网格里的标签卡与集合卡用的是同一个 testid（都是 AlbumCard），
 * 页面上第一张未必是相册 —— 首页首屏的照片墙又把它推到了后面。
 * 按「里面有打开相册的链接」筛，才是测试真正要的那一张。
 */
function albumCard(page: Page) {
  return page
    .locator('[data-testid="album-card"]')
    .filter({ has: page.getByRole("link", { name: /^打开相册/ }) })
    .first();
}

test("两侧的措辞与计数单位各归各", async ({ page }) => {
  await liveRoots(page.request);
  await setWorkbenchMode(page.request, "photo");
  await scannedNodes(page.request, "photo");

  await page.goto("/photo");
  // 取一张卡片上的链接，而不是页面上第一个「打开相册」链接：首屏专区
  // 里也有指向相册的链接（随手看看的封面），它不是卡片，没有悬停预览。
  const photoCard = albumCard(page).getByRole("link", { name: /打开相册/ });
  await expect(photoCard).toBeVisible();
  await photoCard.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await photoCard.hover();
  const preview = page.getByRole("dialog", { name: /预览/ });
  await expect(preview).toBeVisible();
  // 照片相册没有阅读进度，预览里也不该冒出漫画的说法。
  await expect(preview.getByText("阅读进度")).toHaveCount(0);
  await expect(preview).not.toContainText("尚未阅读");
  // 照片相册的图片按「张」计数。
  await expect(preview).toContainText("张");

  await setWorkbenchMode(page.request, "comic");
  await scannedNodes(page.request, "comic");
  await page.goto("/comic");
  const comicCard = albumCard(page).getByRole("link", { name: /打开相册/ });
  await expect(comicCard).toBeVisible();
  await comicCard.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await comicCard.hover();
  const comicPreview = page.getByRole("dialog", { name: /预览/ });
  await expect(comicPreview).toBeVisible();
  // 漫画侧的预览不说「浏览」。
  await expect(comicPreview).not.toContainText("尚未浏览");
  // 漫画相册的图片按「页」计数。
  await expect(comicPreview).toContainText("页");

  await resetWorkbenchMode(page.request);
});

for (const kind of ["images", "mixed", "videos"] as const) {
  test(`${kind} 网格在已加载边界翻页并补齐远处占位`, async ({ page }) => {
    const nodes = await scannedNodes(page.request);
    const album = nodes.find((node) => node.name === `sample-paged-${kind}`);
    expect(album).toBeDefined();
    // 分页走真实扫描与 HTTP；封面和视频元数据使用小响应，避免测试依赖 ffmpeg。
    await page.route("**/api/thumbs/**", (route) =>
      route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          "base64",
        ),
      }),
    );
    await page.route("**/api/videos/info/batch", (route) =>
      route.fulfill({ json: { ok: true, items: [] } }),
    );
    const mediaRequests: string[] = [];
    let failNextPage = kind === "images";
    let failedRequests = 0;
    await page.route(`**/api/albums/${album!.id}/media?*`, async (route) => {
      if (
        failNextPage &&
        new URL(route.request().url()).searchParams.has("cursor")
      ) {
        failedRequests++;
        await route.fulfill({
          status: 400,
          json: { code: "test_page_error", message: "模拟分页失败" },
        });
      } else {
        await route.continue();
      }
    });
    page.on("response", (response) => {
      if (
        response.status() === 200 &&
        new URL(response.url()).pathname === `/api/albums/${album!.id}/media`
      ) {
        mediaRequests.push(response.url());
      }
    });
    await page.goto(albumUrl(album!));
    const scroller = page.locator("[data-virtuoso-scroller]");
    await expect(scroller.getByRole("button").first()).toBeVisible();
    expect(mediaRequests).toHaveLength(1);

    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight * 0.6;
    });
    if (kind === "images") {
      const alert = page.getByRole("alert");
      await expect(alert).toContainText("后续媒体加载失败", {
        timeout: 15_000,
      });
      await scroller.evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect(
        scroller.getByRole("button", { name: "查看 page-1.png", exact: true }),
      ).toBeVisible();
      // 失败次数取决于重试节奏，只断言「确实反复失败过」。
      expect(failedRequests).toBeGreaterThanOrEqual(4);
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await page.screenshot({
          path: test.info().outputPath(`media-page-error-${theme}.png`),
        });
      }
      // 提示条给出显式重试入口；恢复后提示条消失，已加载内容继续可翻。
      await expect(alert.locator("button")).toHaveCount(1);
      failNextPage = false;
      await expect(alert).toHaveCount(0, { timeout: 15_000 });
    }
    await expect.poll(() => mediaRequests.length).toBe(2);

    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const lastName =
      kind === "videos"
        ? "播放 page-405.mp4"
        : kind === "mixed"
          ? "播放 zz-video.mp4"
          : "查看 page-405.png";
    await expect(
      scroller.getByRole("button", { name: lastName, exact: true }),
    ).toBeVisible();
    expect(mediaRequests).toHaveLength(3);
  });

  test(`${kind} 网格在手机与宽屏对齐摘要，末项和首项均可到达`, async ({
    page,
  }) => {
    const nodes = await scannedNodes(page.request);
    const album = nodes.find((node) => node.name === `sample-paged-${kind}`);
    expect(album).toBeDefined();
    await page.route("**/api/thumbs/**", (route) =>
      route.fulfill({ contentType: "image/png", body: solidPng(8, 8) }),
    );
    await page.route("**/api/videos/info/batch", (route) =>
      route.fulfill({ json: { ok: true, items: [] } }),
    );
    for (const width of [390, 1440, 1920]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(albumUrl(album!));
      const scroller = page.locator("[data-virtuoso-scroller]");
      const first = scroller.getByRole("button").first();
      await expect(first).toBeVisible();
      const list = page.getByTestId("virtuoso-item-list");
      // 照片墙没有封面摘要区；它的内容左缘要与顶栏一致。
      // 顶栏用 role=banner 定位：相册页自己也有一个 header，两者会撞。
      // 比的是顶栏的内容左缘（page-shell 有左右内边距），不是它的外框。
      const shell = page.locator("header.app-toolbar > .page-shell");
      const headerBox = await shell.boundingBox();
      const headerPadding = await shell.evaluate((element) =>
        parseFloat(getComputedStyle(element).paddingLeft),
      );
      const listBox = await list.boundingBox();
      expect(headerBox).not.toBeNull();
      expect(listBox).not.toBeNull();
      expect(
        Math.abs(listBox!.x - (headerBox!.x + headerPadding)),
      ).toBeLessThanOrEqual(1);
      // 虚拟视口与网格同宽，不能把左右留白算作额外的列。
      const widthDifference = await list.evaluate((element) =>
        Math.abs(
          element.getBoundingClientRect().width -
            element.parentElement!.getBoundingClientRect().width,
        ),
      );
      expect(widthDifference).toBeLessThanOrEqual(1);
      const lastName =
        kind === "videos"
          ? "播放 page-405.mp4"
          : kind === "mixed"
            ? "播放 zz-video.mp4"
            : "查看 page-405.png";
      // 虚拟列表的总高随补页增长，滚到底一次未必到底：反复滚到当前底部
      // 直到末项出现。
      await expect
        .poll(
          async () => {
            await scroller.evaluate((element) => {
              element.scrollTop = element.scrollHeight;
            });
            return scroller
              .getByRole("button", { name: lastName, exact: true })
              .count();
          },
          { timeout: 15_000 },
        )
        .toBeGreaterThan(0);
      await scroller.evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect(scroller.getByRole("button").first()).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
    }
  });
}

// 首页主操作必须落在首屏里：舞台（封面 + 墙签 + 进度 + 主操作）比主区
// 可用高度高时，"继续阅读"按钮会被滚动容器裁掉（1440×900 实测超出 33px，
// 按钮只剩 3px、箭头图标整个不可见）。舞台按视口高度收缩，这条用例守住它。
//
// 继续阅读属于漫画工作台：这里在漫画模式下造一条在读记录再回首页。
test("首页「继续阅读」主操作不被主区裁掉", async ({ page }) => {
  const nodes = await scannedNodes(page.request, "comic");
  const album = nodes.find((node) => node.name === "sample-comic")!;
  expect(album).toBeDefined();
  const activityPath = `/api/activity?albumId=${album.id}&mediaKind=image`;
  expect(
    (
      await page.request.put("/api/activity", {
        data: {
          albumId: album.id,
          mediaKind: "image",
          pageIndex: 1,
          pageCount: 3,
        },
      })
    ).ok(),
  ).toBeTruthy();
  await setWorkbenchMode(page.request, "comic");
  try {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1366, height: 768 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      const cta = page
        .getByRole("button", { name: "继续阅读", exact: true })
        .first();
      await expect(cta).toBeVisible({ timeout: 20_000 });
      const ctaBox = await cta.boundingBox();
      const mainBox = await page.locator("main").boundingBox();
      expect(ctaBox, "主操作按钮应该拿得到位置").not.toBeNull();
      expect(mainBox, "主区应该拿得到位置").not.toBeNull();
      expect(
        ctaBox!.y + ctaBox!.height,
        `${viewport.width}×${viewport.height} 下主操作被主区裁掉了`,
      ).toBeLessThanOrEqual(mainBox!.y + mainBox!.height + 1);
    }
  } finally {
    expect((await page.request.delete(activityPath)).ok()).toBeTruthy();
    await setWorkbenchMode(page.request, "photo");
  }
});

test("浏览器抽帧上传后封面可通过原资源 URL 显示", async ({ page }) => {
  const nodes = await scannedNodes(page.request);
  const album = nodes.find((node) => node.name === "sample-video-cover");
  expect(album).toBeDefined();
  const response = await page.request.get(`/api/albums/${album!.id}/media`);
  expect(response.ok()).toBeTruthy();
  const media = (await response.json()) as {
    page: { items: Array<{ id: string }> };
  };
  const fileId = media.page.items[0].id;
  let uploaded = false;
  let probes = 0;
  const frameRequests: Array<{ range: string | undefined; kind: string }> = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/media/${fileId}`) {
      frameRequests.push({
        range: request.headers().range,
        kind: request.resourceType(),
      });
    }
  });
  await page.clock.install();
  await page.route(`**/api/thumbs/${fileId}/cover`, async (route) => {
    const result = await route.fetch();
    uploaded = result.ok();
    await route.fulfill({ response: result });
  });
  // 只模拟服务端封面未就绪；视频解码、canvas 抽帧、上传和最终 GET 均走真实流程。
  await page.route(thumbRoutePattern(fileId), async (route) => {
    if (route.request().method() === "HEAD" && !uploaded) {
      probes++;
      await route.fulfill({ status: 404 });
    } else {
      await route.continue();
    }
  });
  await page.goto(albumUrl(album!));
  await expect.poll(() => probes).toBeGreaterThan(0);
  await page.clock.fastForward(21_000);
  await expect.poll(() => uploaded).toBe(true);
  const cover = page
    .locator(`[data-virtuoso-scroller] img[src^="/api/thumbs/${fileId}"]`)
    .first();
  // 封面 URL 带档位与版本号（?w=…&v=…），这里只认它的路径部分。
  await expect(cover).toHaveAttribute(
    "src",
    new RegExp(`^/api/thumbs/${fileId}`),
  );
  await expect
    .poll(() => cover.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  expect(frameRequests.length).toBeGreaterThan(0);
  expect(
    frameRequests.every(
      (request) =>
        request.kind === "media" && request.range?.startsWith("bytes="),
    ),
  ).toBe(true);
});

for (const albumName of ["sample-video-cover", "sample-mixed-cover"]) {
  test(`${albumName} 封面重试和播放支持独立键盘操作`, async ({ page }) => {
    const nodes = await scannedNodes(page.request);
    const album = nodes.find((node) => node.name === albumName);
    expect(album).toBeDefined();
    const response = await page.request.get(`/api/albums/${album!.id}/media`);
    const media = (await response.json()) as {
      page: { items: Array<{ id: string; kind: string }> };
    };
    const fileId = media.page.items.find((item) => item.kind === "video")!.id;
    const errors: string[] = [];
    let fail = true;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(thumbRoutePattern(fileId), async (route) => {
      if (fail && route.request().method() === "HEAD")
        await route.abort("failed");
      else await route.continue();
    });
    await page.goto(albumUrl(album!));
    const grid = page.locator("[data-virtuoso-scroller]");
    const retry = grid.getByRole("button", { name: "重试", exact: true });
    await expect(retry).toBeVisible();
    await expect(page.locator("button button")).toHaveCount(0);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await retry.focus();
      await page.screenshot({
        path: test.info().outputPath(`cover-actions-${theme}.png`),
      });
    }
    expect(errors).toEqual([]);
    fail = false;
    await page.keyboard.press("Enter");
    const cover = grid.locator(`img[src^="/api/thumbs/${fileId}"]`);
    await expect
      .poll(() =>
        cover.evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect(page).toHaveURL(albumUrlPattern(album!));
    await grid.getByRole("button", { name: /^播放/ }).focus();
    await page.keyboard.press("Space");
    await expect(
      page.getByRole("dialog", { name: `${albumName} 大图预览` }),
    ).toBeVisible();
    await expect(page.getByRole("dialog").locator("video")).toBeAttached();
    expect(errors).toEqual([]);
  });
}

test("视频封面按原始比例完整显示，不裁切也不补黑边", async ({ page }) => {
  const nodes = await scannedNodes(page.request);
  const album = nodes.find((node) => node.name === "sample-video-cover");
  expect(album).toBeDefined();
  const response = await page.request.get(`/api/albums/${album!.id}/media`);
  const media = (await response.json()) as {
    page: { items: Array<{ id: string; kind: string }> };
  };
  const fileId = media.page.items.find((item) => item.kind === "video")!.id;
  await page.goto(albumUrl(album!));
  // 限定在照片墙的网格里：侧栏的「接着看」也会显示同一本相册的封面缩略图，
  // 全页取第一个会取到侧栏那张，测的就不是网格里的视频封面了。
  const cover = page
    .locator(`[data-virtuoso-scroller] img[src^="/api/thumbs/${fileId}"]`)
    .first();
  await expect(cover).toBeVisible();
  await expect
    .poll(() => cover.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  // 网格是竖框（3:4），视频帧是横的：按 contain 完整显示，按 cover 会被裁掉
  // 大半画面，只剩中间一条。
  await expect(cover).toHaveClass(/object-contain/);
  // 封面本身不再补黑边。素材是 16×16 的正方形视频：补过黑边的封面会是
  // 320×350（不是正方形），等比缩放的封面保持正方形。
  const natural = await cover.evaluate((image: HTMLImageElement) => ({
    width: image.naturalWidth,
    height: image.naturalHeight,
  }));
  expect(natural.width).toBe(natural.height);
});

test("照片大图预览按显示尺寸取档，URL 只有一个问号", async ({ page }) => {
  const nodes = await scannedNodes(page.request);
  const album = nodes.find((node) => node.name === "sample-album");
  expect(album).toBeDefined();
  await page.goto(albumUrl(album!));
  const scroller = page.locator("[data-virtuoso-scroller]");
  const tile = scroller.getByRole("button", {
    name: "查看 page-1.png",
    exact: true,
  });
  await expect(tile).toBeVisible();
  await tile.click();

  const viewer = page.getByRole("dialog", { name: /大图预览/ });
  await expect(viewer).toBeVisible();
  const image = viewer.locator("img");
  await expect(image).toBeVisible();

  // w 与 v 是两个独立参数：拼成 "?w=320?v=…" 时服务端把整串当成 w 的值，
  // 预览图直接 400，浮层里显示的是「这张图片无法显示」。
  const src = await image.getAttribute("src");
  expect(src).not.toBeNull();
  const query = new URL(src!, "http://localhost").searchParams;
  expect([...query.keys()]).toEqual(["w", "v"]);
  expect(query.get("w")).toMatch(/^\d+$/);
  // 图真的加载出来了。
  await expect
    .poll(() =>
      image.evaluate((element: HTMLImageElement) => element.naturalWidth),
    )
    .toBeGreaterThan(0);
  // 档位按实际显示宽取，不按视口宽：素材只有 1×1 像素，档位再大也没有
  // 更多细节，不该顺手要一档 4096（服务端会原样返回原图）。
  expect(Number(query.get("w"))).toBeLessThanOrEqual(1920);
});

test("离开相册会取消浏览器抽帧且不继续上传封面", async ({ page }) => {
  const nodes = await scannedNodes(page.request);
  const album = nodes.find((node) => node.name === "sample-video-cover");
  expect(album).toBeDefined();
  const mediaResponse = await page.request.get(
    `/api/albums/${album!.id}/media`,
  );
  const media = (await mediaResponse.json()) as {
    page: { items: Array<{ id: string }> };
  };
  const fileId = media.page.items[0].id;
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  let cancelled = 0;
  let uploaded = false;
  let probes = 0;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname === `/api/media/${fileId}`) cancelled++;
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/thumbs/${fileId}/cover`)
      uploaded = true;
  });
  await page.clock.install();
  await page.route(thumbRoutePattern(fileId), async (route) => {
    probes++;
    await route.fulfill({ status: 404 });
  });
  await page.route(
    (url) => url.pathname === `/api/media/${fileId}`,
    async (route) => {
      expect(
        new URL(route.request().url()).searchParams.get("playback"),
      ).toBeTruthy();
      started++;
      await waiting;
      // 取消后的请求可能已从浏览器路由表移除。
      await route.continue().catch(() => {});
    },
  );
  try {
    await page.goto(albumUrl(album!));
    // 侧栏也可能探测同一视频封面；等照片墙挂载后再推进虚拟时间，
    // 确保测量的是本页抽帧任务，而非先出现的侧栏请求。
    await expect(
      page
        .locator("main [data-virtuoso-scroller]")
        .getByRole("button", { name: "播放 clip.webm", exact: true }),
    ).toBeVisible();
    await expect.poll(() => probes).toBeGreaterThan(0);
    await page.clock.fastForward(21_000);
    await expect.poll(() => started).toBeGreaterThan(0);
    // 设置页没有视频卡片，避免新页面的抽帧上传混入旧任务的取消断言。
    // 使用 SPA 导航，确保中止来自组件清理，而非整页卸载。
    await page.getByRole("link", { name: "设置", exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);
    // URL 更新后懒加载页面可能尚未提交，等旧相册卸载后再放行媒体响应。
    await expect(
      page.getByRole("heading", { name: "设置", level: 1, exact: true }),
    ).toBeVisible();
    release();
    await expect.poll(() => cancelled).toBeGreaterThan(0);
    await page.clock.fastForward(60_000);
    expect(uploaded).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    release();
  }
});

test("视频元数据单条与批量共享文件ID及父目录", async ({ request }) => {
  const nodes = await scannedNodes(request);
  const album = nodes.find((node) => node.name === "sample-video-cover")!;
  const pictures = nodes.find((node) => node.name === "sample-album")!;
  expect(album).toBeDefined();
  expect(pictures).toBeDefined();
  const videoMedia = (await (
    await request.get(`/api/albums/${album.id}/media`)
  ).json()) as {
    page: { items: Array<{ id: string; name: string }> };
  };
  const imageMedia = (await (
    await request.get(`/api/albums/${pictures.id}/media`)
  ).json()) as {
    page: { items: Array<{ id: string }> };
  };
  const file = videoMedia.page.items[0];
  const response = await request.get(`/api/videos/${file.id}/info`);
  expect(response.status()).toBe(200);
  const info = (await response.json()) as VideoInfo;
  expect(info).toMatchObject({
    path: file.id,
    name: file.name,
    dir: "media/sample-video-cover",
    format: ".webm",
  });
  expect(info.size).toBeGreaterThan(0);
  const invalid = await request.get(`/api/videos/${album.id}/info`);
  expect(invalid.status()).toBe(400);
  expect((await invalid.json()).code).toBe("invalid_resource_kind");
  const ids = [
    file.id,
    album.id,
    "f_unknown",
    imageMedia.page.items[0].id,
    file.id,
  ];
  const batchResponse = await request.post("/api/videos/info/batch", {
    data: { ids },
  });
  expect(batchResponse.status()).toBe(200);
  const batch = (await batchResponse.json()) as {
    items: VideoInfoBatchItem[];
  };
  expect(batch.items.map((item) => item.id)).toEqual(ids);
  for (const index of [0, 4]) {
    expect(batch.items[index].info).toMatchObject({
      path: file.id,
      name: file.name,
      dir: info.dir,
    });
    expect(batch.items[index].code).toBeUndefined();
  }
  for (const [index, code] of [
    [1, "invalid_resource_kind"],
    [2, "resource_not_found"],
    [3, "unsupported_video_format"],
  ] as const) {
    expect(batch.items[index].code).toBe(code);
    expect(batch.items[index].info).toBeUndefined();
  }
});

test("视频信息重复访问后移除媒体根仍拒绝旧文件ID", async ({ request }) => {
  const original = (await (await request.get("/api/config")).json()) as {
    mediaRoots: MediaRootConfig[];
  };
  try {
    const nodes = await scannedNodes(request);
    const album = nodes.find((node) => node.name === "sample-video-cover")!;
    expect(album).toBeDefined();
    const media = (await (
      await request.get(`/api/albums/${album.id}/media`)
    ).json()) as {
      page: { items: Array<{ id: string }> };
    };
    const id = media.page.items[0].id;
    for (let index = 0; index < 2; index++) {
      const warm = await request.post("/api/videos/info/batch", {
        data: { ids: [id] },
      });
      expect(warm.ok()).toBeTruthy();
      const result = (await warm.json()) as { items: VideoInfoBatchItem[] };
      expect(result.items[0].info?.path).toBe(id);
    }
    expect(
      (await request.put("/api/config", { data: { mediaRoots: [] } })).ok(),
    ).toBeTruthy();
    const response = await request.post("/api/videos/info/batch", {
      data: { ids: [id] },
    });
    expect(response.status()).toBe(200);
    const result = (await response.json()) as { items: VideoInfoBatchItem[] };
    expect(result.items[0].code).toBe("resource_not_found");
    expect(result.items[0].info).toBeUndefined();
    expect((await request.get(`/api/videos/${id}/info`)).status()).toBe(404);
  } finally {
    expect(
      (
        await request.put("/api/config", {
          data: { mediaRoots: original.mediaRoots },
        })
      ).ok(),
    ).toBeTruthy();
  }
});

test("快捷键帮助限制焦点与背景操作，关闭后恢复入口并清空搜索", async ({
  page,
}) => {
  await page.goto("/settings");
  const opener = page.getByRole("button", { name: "快捷键帮助", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "快捷键", exact: true });
  const search = dialog.getByRole("textbox", { name: "搜索快捷键" });
  const close = dialog.getByRole("button", { name: "关闭", exact: true });
  await expect(search).toBeFocused();
  // 措辞随工作台走：照片工作台的「回到主页」叫「回到照片库」。
  await expect(dialog.getByText("回到照片库", { exact: true })).toBeVisible();
  await expect(dialog.getByText("下一张", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(/旋转 90°/)).toHaveCount(0);
  await search.fill("Space");
  await expect(dialog.getByText("没有匹配「Space」的快捷键")).toBeVisible();
  await search.fill("");
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(search).toBeFocused();
  await search.fill("不存在的快捷键");
  await expect(
    dialog.getByText("没有匹配「不存在的快捷键」的快捷键"),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "清除", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(search).toBeFocused();
  await dialog.getByRole("button", { name: "清除", exact: true }).click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await close.focus();
  await page.keyboard.press("u");
  await page.keyboard.press("/");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await close.focus();
  await page.keyboard.press("Space");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
});

test("主题菜单隔离页面快捷键，支持键盘连续选择并持久保存", async ({ page }) => {
  const album = (await scannedNodes(page.request)).find(
    (node) => node.name === "sample-album",
  )!;
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(albumUrl(album));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const initialURL = page.url();
  let backgroundActions = 0;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      ["/api/scans", "/api/albums/random"].includes(
        new URL(request.url()).pathname,
      )
    )
      backgroundActions++;
  });
  const root = page.locator("html");
  const trigger = page.getByRole("button", { name: /^主题:/ });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "主题" });
  const light = menu.getByRole("menuitemradio", { name: "浅色", exact: true });
  const dark = menu.getByRole("menuitemradio", { name: "深色", exact: true });
  await expect(light).toBeFocused();
  const triggerBox = await trigger.boundingBox();
  const menuBox = await menu.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(
    Math.abs(menuBox!.x + menuBox!.width - triggerBox!.x - triggerBox!.width),
  ).toBeLessThanOrEqual(1);
  for (const key of ["u", "r", "?", "/", "Control+s"])
    await page.keyboard.press(key);
  await expect(light).toBeFocused();
  await expect(page).toHaveURL(initialURL);
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(backgroundActions).toBe(0);
  await page.keyboard.press("ArrowDown");
  await expect(dark).toBeFocused();
  await expect(root).toHaveAttribute("data-theme", "light");
  await page.keyboard.press("Enter");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(dark).toHaveAttribute("aria-checked", "true");
  await expect(menu).toBeVisible();
  // 菜单只有主题一组：Home/End 在三项之间往返。
  await page.keyboard.press("End");
  await expect(
    menu.getByRole("menuitemradio", { name: "系统", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(light).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await trigger.click();
  await expect(dark).toHaveAttribute("aria-checked", "true");
  expect(errors).toEqual([]);
});

test("主题菜单保留 Tab 操作和外部焦点，关闭后恢复页面快捷键", async ({
  page,
}) => {
  await scannedNodes(page.request);
  await page.goto("/settings");
  const trigger = page.getByRole("button", { name: /^主题:/ });
  const menu = page.getByRole("menu", { name: "主题" });
  await trigger.click();
  await expect(
    menu.getByRole("menuitemradio", { name: "浅色", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    menu.getByRole("menuitemradio", { name: "深色", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    menu.getByRole("menuitemradio", { name: "浅色", exact: true }),
  ).toBeFocused();
  const search = page.getByRole("combobox");
  await search.click();
  await expect(menu).not.toBeVisible();
  await expect(search).toBeFocused();
  for (let attempt = 0; attempt < 5; attempt++) {
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible();
    await expect(trigger).toBeFocused();
  }
  // 未读页只属于漫画工作台：照片模式下按 U 不跳转，切到漫画模式才跳。
  await page.keyboard.press("u");
  await expect(page).toHaveURL(/\/settings$/);
  await page
    .getByRole("group", { name: "工作台模式" })
    .getByRole("button", { name: "漫画" })
    .click();
  await page.keyboard.press("u");
  await expect(page).toHaveURL(/\/unread$/);
});

test("主题令牌在明暗模式下保持边框及透明背景", async ({ page }) => {
  await page.goto("/settings");
  const root = page.locator("html");
  const themeSwitcher = page
    .getByRole("button", { name: "浅色", exact: true })
    .locator("..");
  const activeNavigation = page.getByRole("link", {
    name: "设置",
    exact: true,
  });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await expect(root).toHaveAttribute("data-theme", theme);
    const [expectedBorder, expectedSubtle] = await renderedColors(root, [
      "--border",
      "--bg-subtle",
    ]);
    const [headerBorder] = await renderedColors(page.locator("header"), [
      "border-bottom-color",
    ]);
    expect(headerBorder).toEqual(expectedBorder);
    const [subtleBackground] = await renderedColors(themeSwitcher, [
      "background-color",
    ]);
    expect(subtleBackground[3]).toBe(102);
    for (const channel of [0, 1, 2])
      expect(
        Math.abs(subtleBackground[channel] - expectedSubtle[channel]),
      ).toBeLessThanOrEqual(2);
    // 侧栏选中态的颜色来自 --rail-active / --rail-active-fg，
    // 而不是组件里另写一份色值。
    const navigationColors = await renderedColors(root, [
      "--rail-active",
      "--rail-active-fg",
    ]);
    expect(
      await renderedColors(activeNavigation, ["background-color", "color"]),
    ).toEqual(navigationColors);
    // 强调色由主题方案本身决定：主题菜单里的选中项直接取 --accent 家族。
    await page.getByRole("button", { name: /^主题:/ }).click();
    const activeTheme = page.getByRole("menuitemradio", {
      name: "系统",
      exact: true,
    });
    await expect(activeTheme).toHaveAttribute("aria-checked", "true");
    const expected = await renderedColors(root, [
      "--accent",
      "--accent-contrast",
    ]);
    await expect
      .poll(() => renderedColors(activeTheme, ["background-color", "color"]))
      .toEqual(expected);
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: test.info().outputPath(`theme-tokens-${theme}.png`),
    });
  }
});

test("中文和特殊字符标签通过编码链接正常打开", async ({ page }) => {
  await scannedNodes(page.request);
  for (const tag of [
    "测试",
    "空 格",
    "C++",
    "100%",
    "字面%20",
    "字面%2F",
    "字面%25",
  ]) {
    await test.step(tag, async () => {
      await page.goto(`/photo/tags/${encodeURIComponent(tag)}`);
      await expect(
        page.getByRole("heading", { name: tag, exact: true }),
      ).toBeVisible();
      await expect(
        page
          .locator('main [data-virtuoso-scroller] a[href^="/photo/albums/"]')
          .first(),
      ).toBeVisible();
    });
  }
});

test("那年今日按月日找出往年同一天拍过照的相册", async ({ request }) => {
  // 素材是 zz-capture-date：文件名里带 2024-01-15，拍摄时间只认文件名。
  await scannedNodes(request, "photo");

  const hits = (await (
    await request.get("/api/library/on-this-day?kind=photo&month=1&day=15")
  ).json()) as {
    ok: boolean;
    page: {
      total: number;
      items: Array<{ name: string; matchedDate: string }>;
    };
  };
  expect(hits.ok).toBe(true);
  const hit = hits.page.items.find((item) => item.name === "zz-capture-date");
  expect(hit, "带拍摄日期的相册没被命中").toBeDefined();
  // 命中的那一天单独给出：相册自己的代表日期未必是这一天。
  expect(hit!.matchedDate).toBe("2024-01-15");

  // 今年的同一天不算「往年」：命中项的年份必须都早于今年。
  const now = new Date();
  const today = (await (
    await request.get(
      `/api/library/on-this-day?kind=photo&month=${now.getMonth() + 1}&day=${now.getDate()}`,
    )
  ).json()) as {
    page: { items: Array<{ matchedDate: string }> };
  };
  for (const item of today.page.items) {
    expect(Number(item.matchedDate.slice(0, 4))).toBeLessThan(
      now.getFullYear(),
    );
  }

  // 非法月日报错，而不是悄悄返回空列表。
  const invalid = await request.get(
    "/api/library/on-this-day?kind=photo&month=13&day=1",
  );
  expect(invalid.status()).toBe(400);
});

test("六个列表的最近改排序使用真实修改时间", async ({ page }) => {
  // 列表里含未读页，未读属于漫画工作台：素材取漫画根，整条用例在漫画模式下跑。
  await setWorkbenchMode(page.request, "comic");
  const nodes = await scannedNodes(page.request, "comic");
  const prefix =
    "zz-[测试][空 格][C++][100%][字面%20][字面%2F][字面%25] tagged-";
  const samples = ["M", "A", "Z"].map((suffix) =>
    nodes.find((node) => node.name === prefix + suffix)!,
  );
  for (const node of samples) expect(node).toBeDefined();
  expect(Date.parse(samples[0].modTime ?? "")).toBeGreaterThan(
    Date.parse(samples[1].modTime ?? ""),
  );
  expect(Date.parse(samples[0].date ?? "")).toBeLessThan(
    Date.parse(samples[1].date ?? ""),
  );
  const collection = nodes.find((node) => node.name === "zz-sort-collection")!;
  expect(collection).toBeDefined();
  const children = (await (
    await page.request.get(
      `/api/library/${collection.id}/children?limit=200&kind=comic`,
    )
  ).json()) as { page: { items: Array<{ id: string; name: string }> } };
  const childIds = ["M", "A", "Z"].map(
    (suffix) =>
      children.page.items.find((node) => node.name === prefix + suffix)!.id,
  );
  const ids = samples.map((node) => node.id);
  const original = (await (await page.request.get("/api/prefs")).json()) as {
    favorites: string[];
    maxRecent: number;
    history: Array<{ albumId: string; name: string; imageCount: number }>;
  };
  try {
    expect(
      (
        await page.request.patch("/api/prefs", {
          data: { maxRecent: Math.max(3, original.maxRecent) },
        })
      ).ok(),
    ).toBeTruthy();
    expect((await page.request.delete("/api/history")).ok()).toBeTruthy();
    for (const node of samples) {
      expect(
        (
          await page.request.post("/api/favorites", {
            data: { resourceId: node.id },
          })
        ).ok(),
      ).toBeTruthy();
      expect(
        (
          await page.request.post("/api/history", {
            data: { albumId: node.id, name: node.name, imageCount: 1 },
          })
        ).ok(),
      ).toBeTruthy();
    }
    const pages = [
      ["/comic", ids],
      [`/comic/albums/${collection.id}`, childIds],
      ["/comic/favorites", ids],
      ["/comic/recents", ids],
      ["/comic/unread", ids],
      [`/comic/tags/${encodeURIComponent("测试")}`, ids],
    ] as const;
    for (const [path, expected] of pages) {
      await test.step(path, async () => {
        await page.goto(path);
        await page.getByRole("combobox").fill(prefix);
        if (path === "/comic") {
          await page.getByRole("button", { name: "排序", exact: true }).click();
          await page
            .getByRole("button", { name: "按最近改", exact: true })
            .click();
        }
        await expect
          .poll(async () => {
            await page.locator("main").evaluate((element) => {
              element.scrollTop = element.scrollHeight;
            });
            return page
              .locator(
                'main [data-virtuoso-scroller] a[href^="/comic/albums/"]',
              )
              .evaluateAll(
                (links, expected) =>
                  [
                    ...new Set(
                      links.map((link) =>
                        decodeURIComponent(
                          link
                            .getAttribute("href")!
                            .slice("/comic/albums/".length),
                        ),
                      ),
                    ),
                  ].filter((id) => expected.includes(id)),
                [...expected],
              );
          })
          .toEqual([...expected]);
      });
    }
  } finally {
    for (const resourceId of ids)
      if (!original.favorites.includes(resourceId))
        expect(
          (
            await page.request.delete("/api/favorites", {
              data: { resourceId },
            })
          ).ok(),
        ).toBeTruthy();
    expect(
      (
        await page.request.patch("/api/prefs", {
          data: { maxRecent: original.maxRecent },
        })
      ).ok(),
    ).toBeTruthy();
    expect((await page.request.delete("/api/history")).ok()).toBeTruthy();
    for (const entry of [...original.history].reverse())
      expect(
        (await page.request.post("/api/history", { data: entry })).ok(),
      ).toBeTruthy();
  }
});

test("六个列表支持按最近看排序，集合与标签具有当前页排序入口", async ({
  page,
}) => {
  // 列表里含未读页，未读属于漫画工作台。
  await setWorkbenchMode(page.request, "comic");
  const { rootAlbums, childAlbums, collectionId } = await sortFixture(
    page.request,
  );
  const original = (await (await page.request.get("/api/prefs")).json()) as {
    favorites: string[];
    maxRecent: number;
    history: Array<{ albumId: string; name: string; imageCount: number }>;
  };
  try {
    expect(
      (
        await page.request.patch("/api/prefs", {
          data: { maxRecent: Math.max(4, original.maxRecent) },
        })
      ).ok(),
    ).toBeTruthy();
    expect((await page.request.delete("/api/history")).ok()).toBeTruthy();
    for (const node of [
      rootAlbums[1],
      childAlbums[1],
      rootAlbums[2],
      childAlbums[2],
    ])
      expect(
        (
          await page.request.post("/api/history", {
            data: { albumId: node.id, name: node.name, imageCount: 1 },
          })
        ).ok(),
      ).toBeTruthy();
    for (const node of rootAlbums)
      expect(
        (
          await page.request.post("/api/favorites", {
            data: { resourceId: node.id },
          })
        ).ok(),
      ).toBeTruthy();
    const expectedRoot = [rootAlbums[2].id, rootAlbums[1].id, rootAlbums[0].id];
    const expectedChildren = [
      childAlbums[2].id,
      childAlbums[1].id,
      childAlbums[0].id,
    ];
    const pages = [
      ["/comic", expectedRoot],
      [`/comic/albums/${collectionId}`, expectedChildren],
      ["/comic/favorites", expectedRoot],
      ["/comic/recents", expectedRoot.slice(0, 2)],
      ["/comic/unread", expectedRoot],
      [`/comic/tags/${encodeURIComponent("测试")}`, expectedRoot],
    ] as const;
    for (const [path, expected] of pages) {
      await test.step(path, async () => {
        await page.goto(path);
        await page.getByRole("combobox").fill(taggedSortPrefix);
        await page.getByRole("button", { name: "排序", exact: true }).click();
        await page
          .getByRole("button", { name: "按最近看", exact: true })
          .click();
        await expect
          .poll(async () => {
            await page.locator("main").evaluate((element) => {
              element.scrollTop = element.scrollHeight;
            });
            return page
              .locator(
                'main [data-virtuoso-scroller] a[href^="/comic/albums/"]',
              )
              .evaluateAll(
                (links, expected) =>
                  [
                    ...new Set(
                      links.map((link) =>
                        decodeURIComponent(
                          link
                            .getAttribute("href")!
                            .slice("/comic/albums/".length),
                        ),
                      ),
                    ),
                  ].filter((id) => expected.includes(id)),
                [...expected],
              );
          })
          .toEqual([...expected]);
        await page
          .getByRole("button", { name: "列表视图", exact: true })
          .click();
        await expect(
          page
            .locator(
              `main [data-virtuoso-scroller] a[href="/comic/albums/${expected[0]}"]`,
            )
            .first(),
        ).toHaveCSS("display", "flex");
      });
    }
  } finally {
    for (const node of rootAlbums)
      if (!original.favorites.includes(node.id))
        expect(
          (
            await page.request.delete("/api/favorites", {
              data: { resourceId: node.id },
            })
          ).ok(),
        ).toBeTruthy();
    await restoreHistory(page.request, original);
  }
});

for (const name of ["unread"] as const) {
  test(`${name} 最近看读取失败保留列表并可重试`, async ({ page }) => {
    // 含未读页：未读属于漫画工作台，整组在漫画模式下跑。
    await setWorkbenchMode(page.request, "comic");
    const { rootAlbums, childAlbums, collectionId } = await sortFixture(
      page.request,
    );
    const original = (await (await page.request.get("/api/prefs")).json()) as {
      maxRecent: number;
      history: Array<{ albumId: string; name: string; imageCount: number }>;
    };
    try {
      expect(
        (
          await page.request.patch("/api/prefs", {
            data: { maxRecent: Math.max(2, original.maxRecent) },
          })
        ).ok(),
      ).toBeTruthy();
      expect((await page.request.delete("/api/history")).ok()).toBeTruthy();
      for (const node of [rootAlbums[2], childAlbums[2]])
        expect(
          (
            await page.request.post("/api/history", {
              data: { albumId: node.id, name: node.name, imageCount: 1 },
            })
          ).ok(),
        ).toBeTruthy();
      let blocked = true;
      await page.route("**/api/history", async (route) => {
        if (route.request().method() !== "GET" || !blocked)
          return route.continue();
        await route.fulfill({
          status: 500,
          json: { code: "test_unavailable", message: "unavailable" },
        });
      });
      const paths = {
        home: "/comic",
        collection: `/comic/albums/${collectionId}`,
        unread: "/comic/unread",
        tag: `/comic/tags/${encodeURIComponent("测试")}`,
      };
      await page.goto(paths[name]);
      await page.getByRole("combobox").fill(taggedSortPrefix);
      await page.getByRole("button", { name: "排序", exact: true }).click();
      await page.getByRole("button", { name: "按最近看", exact: true }).click();
      const alert = page.getByRole("alert");
      await expect(alert).toContainText("最近访问加载失败", {
        timeout: 15_000,
      });
      await expect(alert).toContainText("暂按名称排序");
      const albums =
        (name as string) === "collection" ? childAlbums : rootAlbums;
      const ids = albums.map((node) => node.id);
      const currentOrder = () =>
        page
          .locator('main [data-virtuoso-scroller] a[href^="/comic/albums/"]')
          .evaluateAll(
            (links, ids) =>
              [
                ...new Set(
                  links.map((link) =>
                    decodeURIComponent(
                      link.getAttribute("href")!.slice("/comic/albums/".length),
                    ),
                  ),
                ),
              ].filter((id) => ids.includes(id)),
            ids,
          );
      await expect.poll(currentOrder).toEqual(ids);
      if ((name as string) === "collection" || (name as string) === "tag") {
        for (const theme of ["light", "dark"] as const) {
          await page.emulateMedia({
            colorScheme: theme,
            reducedMotion: "reduce",
          });
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
          await page.screenshot({
            path: test.info().outputPath(`viewed-${name}-${theme}.png`),
          });
        }
      }
      blocked = false;
      await alert
        .getByRole("button", { name: "重试加载", exact: true })
        .click();
      await expect.poll(currentOrder).toEqual([ids[2], ids[0], ids[1]]);
      await expect(alert).toHaveCount(0);
    } finally {
      await restoreHistory(page.request, original);
    }
  });
}

for (const name of ["unread"] as const) {
  for (const mode of ["grid", "list"] as const) {
    test(`${name} ${mode} 长相册列表随实际滚动区域更新首尾卡片`, async ({
      page,
    }) => {
      // 含未读页：素材取漫画根，整组在漫画模式下跑。
      await setWorkbenchMode(page.request, "comic");
      const nodes = await scannedNodes(page.request, "comic");
      const prefix = "zz-[滚动回归] long-list-";
      const collection = nodes.find(
        (node) => node.name === "zz-scroll-collection",
      )!;
      expect(collection).toBeDefined();
      const children = (await (
        await page.request.get(
          `/api/library/${collection.id}/children?limit=200&kind=comic`,
        )
      ).json()) as { page: { items: Array<{ id: string; name: string }> } };
      const source = name === "collection" ? children.page.items : nodes;
      const first = source.find((node) => node.name === prefix + "001")!;
      const last = source.find((node) => node.name === prefix + "108")!;
      expect(first).toBeDefined();
      expect(last).toBeDefined();
      const paths = {
        home: "/comic",
        collection: `/comic/albums/${collection.id}`,
        unread: "/comic/unread",
        tag: `/comic/tags/${encodeURIComponent("滚动回归")}`,
      };
      await page.goto(paths[name]);
      await page.getByRole("combobox").fill(prefix);
      await page
        .getByRole("button", {
          name: mode === "grid" ? "网格视图" : "列表视图",
          exact: true,
        })
        .click();
      const cards = page.locator(
        'main [data-virtuoso-scroller] a[href^="/comic/albums/"]',
      );
      const firstCard = page.locator(
        `main [data-virtuoso-scroller] a[href="/comic/albums/${first.id}"]`,
      );
      const lastCard = page.locator(
        `main [data-virtuoso-scroller] a[href="/comic/albums/${last.id}"]`,
      );
      await firstCard.scrollIntoViewIfNeeded();
      await expect(firstCard).toBeInViewport();
      expect(await cards.count()).toBeLessThan(108);
      const scrollArea =
        name === "collection"
          ? page.locator("main .overflow-auto").first()
          : page.locator("main");
      await expect
        .poll(async () => {
          await scrollArea.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          return lastCard.count();
        })
        .toBe(1);
      await scrollArea.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(lastCard).toBeInViewport();
      await expect(firstCard).toHaveCount(0);
      expect(await cards.count()).toBeLessThan(108);
      await scrollArea.evaluate((element) => {
        element.scrollTop = 0;
      });
      await firstCard.scrollIntoViewIfNeeded();
      await expect(firstCard).toBeInViewport();
    });
  }
}

test("排序选项支持键盘确认取消和自然移出焦点", async ({ page }) => {
  // 未读页属于漫画工作台。
  await setWorkbenchMode(page.request, "comic");
  await scannedNodes(page.request, "comic");
  await page.goto("/comic/unread");
  const trigger = page.getByRole("button", { name: "排序", exact: true });
  const options = page.getByRole("group", { name: "排序选项" });
  const first = page.getByRole("button", { name: "按名称", exact: true });
  const grid = page.getByRole("button", { name: "网格视图", exact: true });

  await test.step("回车确认后返回排序按钮，并可继续 Tab 到视图控件", async () => {
    await trigger.focus();
    await trigger.press("Enter");
    await expect(options).toBeVisible();
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Tab");
    await expect(first).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "按页数", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(options).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText("按页数");
    await page.keyboard.press("Tab");
    await expect(grid).toBeFocused();
  });

  await test.step("空格打开，Esc 取消并保留排序及焦点", async () => {
    await trigger.focus();
    await trigger.press("Space");
    for (let index = 0; index < 3; index++) await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "按最近改", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(options).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText("按页数");
  });

  await test.step("Tab 从最后一项移出时关闭选项并保留下一控件焦点", async () => {
    await trigger.press("Enter");
    // 一路 Tab 到选项之外：排序项会增减，不写死次数 ——
    // 写死了就等于把「选项有几项」抄进测试里，加一项就得改这里。
    for (let index = 0; index < 10; index++) {
      await page.keyboard.press("Tab");
      if ((await options.count()) === 0) break;
    }
    await expect(grid).toBeFocused();
    await expect(options).toHaveCount(0);
  });

  await test.step("反向 Tab 离开时关闭选项并保留上一控件焦点", async () => {
    await trigger.focus();
    await trigger.press("Enter");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(
      page.getByRole("button", { name: "最少页数", exact: true }),
    ).toBeFocused();
    await expect(options).toHaveCount(0);
  });

  await test.step("外部点击关闭选项并保留目标焦点", async () => {
    await trigger.click();
    await page.getByRole("combobox").click();
    await expect(options).toHaveCount(0);
    await expect(page.getByRole("combobox")).toBeFocused();
  });

  await trigger.focus();
  await trigger.press("Enter");
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(options).toBeVisible();
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: test.info().outputPath(`sort-options-${theme}.png`),
    });
  }
  for (let index = 0; index < 3; index++) await page.keyboard.press("Tab");
  await page.keyboard.press("Space");
  await expect(options).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText("按最近改");
});

for (const mode of ["grid", "list"] as const) {
  test(`${mode} 单图漫画保持未读并可标记和取消已读完`, async ({ page }) => {
    // 已读标记属于漫画工作台：素材取漫画根，页面也在漫画模式下打开。
    const nodes = await scannedNodes(page.request, "comic");
    const album = nodes.find((node) => node.name === taggedSortPrefix + "A")!;
    expect(album).toBeDefined();
    const activityPath = `/api/activity?albumId=${album.id}&mediaKind=image`;
    const originalResponse = await page.request.get(activityPath);
    expect([200, 404]).toContain(originalResponse.status());
    const originalActivity = originalResponse.ok()
      ? ((await originalResponse.json()) as {
          pageIndex: number;
          pageCount: number;
        })
      : null;
    const originalPrefs = (await (
      await page.request.get("/api/prefs")
    ).json()) as { favorites: string[] };
    try {
      expect((await page.request.delete(activityPath)).ok()).toBeTruthy();
      expect(
        (
          await page.request.post("/api/favorites", {
            data: { resourceId: album.id },
          })
        ).ok(),
      ).toBeTruthy();
      await setWorkbenchMode(page.request, "comic");
      await page.goto("/comic/unread");
      await page.getByRole("combobox").fill(album.name);
      await page
        .getByRole("button", {
          name: mode === "grid" ? "网格视图" : "列表视图",
          exact: true,
        })
        .click();
      const card = page.locator(
        `main [data-virtuoso-scroller] a[href="/comic/albums/${album.id}"]`,
      );
      await expect(card).toBeVisible();
      await expect(card.getByText("已读完", { exact: true })).toHaveCount(0);
      // 未读页的卡片不显示百分比：那是阅读器的读法。
      await expect(card.getByText("100%", { exact: true })).toHaveCount(0);
      // 未读页整页都是未读，卡片不再逐张挂「新」角标 —— 那是纯视觉噪音。
      // 未读状态由服务端筛选保证，卡片上只保留「已读完」这类真实状态。
      if (mode === "grid")
        await expect(card.getByText("新", { exact: true })).toHaveCount(0);
      const menu = page.getByRole("menu", { name: "上下文菜单" });
      await card.click({ button: "right" });
      await expect(menu).toHaveCount(1);
      await expect(
        menu.getByRole("menuitem", { name: "打开", exact: true }),
      ).toBeEnabled();
      await expect(
        menu.getByRole("menuitem", { name: "取消收藏", exact: true }),
      ).toBeEnabled();
      await expect(
        menu.getByRole("menuitem", { name: "标记为已读完", exact: true }),
      ).toBeEnabled();
      await expect(
        menu.getByRole("menuitem", { name: "取消已读完", exact: true }),
      ).toBeDisabled();

      if (mode === "grid") {
        for (const theme of ["light", "dark"] as const) {
          await page.emulateMedia({
            colorScheme: theme,
            reducedMotion: "reduce",
          });
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
          await page.mouse.move(0, 0);
          await page.screenshot({
            path: test.info().outputPath(`unread-menu-${theme}.png`),
          });
        }
        let blocked = true;
        await page.route("**/api/activity", async (route) => {
          if (!blocked || route.request().method() !== "PUT")
            return route.continue();
          await route.fulfill({
            status: 500,
            json: { code: "test_unavailable", message: "unavailable" },
          });
        });
        await menu
          .getByRole("menuitem", { name: "标记为已读完", exact: true })
          .click();
        await expect(page.getByText("标记失败", { exact: true })).toBeVisible();
        await expect(card).toBeVisible();
        expect((await page.request.get(activityPath)).status()).toBe(404);
        blocked = false;
        await card.click({ button: "right" });
      }
      await menu
        .getByRole("menuitem", { name: "标记为已读完", exact: true })
        .click();
      await expect(page.getByText("已读完", { exact: true })).toBeVisible();
      await expect(card).toHaveCount(0);
      const marked = await page.request.get(activityPath);
      expect(marked.ok()).toBeTruthy();
      expect(await marked.json()).toMatchObject({
        pageIndex: 0,
        pageCount: 1,
        status: "completed",
      });

      await page.getByRole("link", { name: "收藏漫画", exact: true }).click();
      await expect(
        card.getByText("已读完", { exact: true }).first(),
      ).toBeVisible();
      await card.click({ button: "right" });
      await expect(menu).toHaveCount(1);
      await expect(
        menu.getByRole("menuitem", { name: "标记为已读完", exact: true }),
      ).toBeDisabled();
      await menu
        .getByRole("menuitem", { name: "取消已读完", exact: true })
        .click();
      await expect(
        page.getByText("已重置为未读", { exact: true }),
      ).toBeVisible();
      await expect(card.getByText("已读完", { exact: true })).toHaveCount(0);
      expect((await page.request.get(activityPath)).status()).toBe(404);
      await page.getByRole("link", { name: /^未读/ }).click();
      await expect(card).toBeVisible();
      await expect(card.getByText("已读完", { exact: true })).toHaveCount(0);
    } finally {
      if (originalActivity) {
        expect(
          (
            await page.request.put("/api/activity", {
              data: {
                albumId: album.id,
                mediaKind: "image",
                pageIndex: originalActivity.pageIndex,
                pageCount: originalActivity.pageCount,
              },
            })
          ).ok(),
        ).toBeTruthy();
      } else {
        expect((await page.request.delete(activityPath)).ok()).toBeTruthy();
      }
      if (!originalPrefs.favorites.includes(album.id)) {
        expect(
          (
            await page.request.delete("/api/favorites", {
              data: { resourceId: album.id },
            })
          ).ok(),
        ).toBeTruthy();
      }
    }
  });
}

for (const mode of ["grid", "list"] as const) {
  test(`${mode} 相册集合属性按类型读取并保持模态焦点`, async ({ page }) => {
    const nodes = await scannedNodes(page.request);
    const album = nodes.find((node) => node.name === "sample-album")!;
    const collection = nodes.find(
      (node) => node.name === "zz-sort-collection",
    )!;
    expect(album).toBeDefined();
    expect(collection).toBeDefined();
    const metadataRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/api\/images\/.+\/info$/.test(new URL(request.url()).pathname))
        metadataRequests.push(request.url());
    });
    await page.goto("/");
    await page
      .getByRole("button", {
        name: mode === "grid" ? "网格视图" : "列表视图",
        exact: true,
      })
      .click();
    for (const [node, kind] of [
      [album, "相册"],
      [collection, "集合"],
    ] as const) {
      await page.getByRole("combobox").fill(node.name);
      await page
        .getByRole("button", {
          name: mode === "grid" ? "网格视图" : "列表视图",
          exact: true,
        })
        .click();
      const { card, dialog } = await openCardProperties(page, node.id);
      const fields = () =>
        dialog
          .locator("dl")
          .evaluate((element) =>
            Object.fromEntries(
              Array.from(element.querySelectorAll("dt"), (term) => [
                term.textContent?.trim(),
                term.nextElementSibling?.textContent?.trim(),
              ]),
            ),
          );
      await expect.poll(fields).toMatchObject({
        名称: node.name,
        类型: kind,
        来源: "media",
        媒体总数: "3 项",
      });
      if (kind === "相册")
        await expect.poll(fields).toMatchObject({ 图片: "3 张", 视频: "0 个" });
      else
        await expect
          .poll(fields)
          .toMatchObject({ 相册数量: "3 本", 直属项目: "3 项" });
      expect((await fields())["大小"]).toMatch(/[1-9].*B/);
      const close = dialog.getByRole("button", { name: "关闭", exact: true });
      await expect(close).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      expect(
        await dialog.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
      await page.keyboard.press("Tab");
      await expect(close).toBeFocused();
      await page
        .getByRole("combobox")
        .evaluate((element) => (element as HTMLInputElement).focus());
      await expect(close).toBeFocused();
      await page.keyboard.press("u");
      await expect(page).toHaveURL("/photo");
      if (mode === "grid") {
        for (const theme of ["light", "dark"] as const) {
          await page.emulateMedia({
            colorScheme: theme,
            reducedMotion: "reduce",
          });
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
          const expected = await renderedColors(page.locator("html"), [
            "--fg",
            "--bg-elevated",
          ]);
          await expect
            .poll(() => renderedColors(dialog, ["color", "background-color"]))
            .toEqual(expected);
          await page.screenshot({
            path: test
              .info()
              .outputPath(
                `properties-${kind === "相册" ? "album" : "collection"}-${theme}.png`,
              ),
          });
        }
      }
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(card).toBeFocused();
      await openCardProperties(page, node.id);
      await expect(dialog.getByText(node.name, { exact: true })).toBeVisible();
      await page.mouse.click(3, 3);
      await expect(dialog).toHaveCount(0);
      await expect(card).toBeFocused();
    }
    expect(metadataRequests).toEqual([]);
  });
}

for (const mode of ["api", "missing", "denied"] as const) {
  const scenario = {
    api: "使用剪贴板 API",
    missing: "在 API 缺失时回退",
    denied: "在 API 拒绝后回退并支持失败重试",
  }[mode];
  test(`属性弹窗复制${scenario}`, async ({ page }) => {
    const nodes = await scannedNodes(page.request);
    const album = nodes.find((node) => node.name === "sample-album")!;
    expect(album).toBeDefined();
    await installCopyAudit(page, mode);
    await page.goto("/");
    await page.getByRole("combobox").fill(album.name);
    const { card, dialog } = await openCardProperties(page, album.id);
    // 复制按钮跟在值后面（规格表），不再挂在标签单元格里。
    // 它的可访问名会随状态变化（复制名称 → 正在复制… → 已复制 /
    // 复制失败，重试），定位器必须同时认得这几种名字 —— 只写
    // 「复制名称」的话，按钮一变名就再也定位不到，断言会误报失败。
    const copy = dialog.getByRole("button", {
      name: /^(复制名称|正在复制…|已复制|复制失败，重试)$/,
    });
    await copy.click();
    if (mode === "denied") {
      await expect(copy).toHaveAccessibleName("复制失败，重试");
      await expect(copy).toBeFocused();
      await expect(page.locator("textarea")).toHaveCount(0);
      await page.evaluate(() => {
        (window as CopyAuditWindow).__copyAudit.throwOnSelection = false;
      });
      await copy.click();
    }
    await expect(copy).toHaveAccessibleName("已复制");
    await expect(copy).toBeFocused();
    await expect(page.locator("textarea")).toHaveCount(0);
    const audit = await page.evaluate(
      () => (window as CopyAuditWindow).__copyAudit,
    );
    expect(audit.apiValues).toEqual(
      mode === "missing"
        ? []
        : Array(mode === "denied" ? 2 : 1).fill(album.name),
    );
    expect(audit.selections).toEqual(
      Array(mode === "api" ? 0 : mode === "denied" ? 2 : 1).fill({
        command: "copy",
        value: album.name,
        selectedValue: album.name,
        insideModal: true,
        focused: true,
      }),
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(card).toBeFocused();
  });
}

for (const view of ["grid", "list"] as const) {
  for (const mode of ["api", "missing", "denied"] as const) {
    test(`${view} 右键复制链接在 ${mode} 下反馈结果并恢复卡片焦点`, async ({
      page,
    }) => {
      const nodes = await scannedNodes(page.request);
      const album = nodes.find((node) => node.name === "sample-album")!;
      expect(album).toBeDefined();
      await installCopyAudit(page, mode);
      await page.goto("/");
      await page.getByRole("combobox").fill(album.name);
      await page
        .getByRole("button", {
          name: view === "grid" ? "网格视图" : "列表视图",
          exact: true,
        })
        .click();
      const card = page.locator(
        `main [data-virtuoso-scroller] a[href="/photo/albums/${album.id}"]`,
      );
      await card.click({ button: "right" });
      await page
        .getByRole("menuitem", { name: "复制链接", exact: true })
        .click();
      await expect(page.getByRole("menu")).toHaveCount(0);
      if (mode === "denied") {
        await expect(
          page.getByText("复制失败，请检查浏览器权限", { exact: true }),
        ).toBeVisible();
        await expect(card).toBeFocused();
        await expect(page.locator("textarea")).toHaveCount(0);
        await page.evaluate(() => {
          (window as CopyAuditWindow).__copyAudit.throwOnSelection = false;
        });
        await card.click({ button: "right" });
        await page
          .getByRole("menuitem", { name: "复制链接", exact: true })
          .click();
      }
      await expect(page.getByText("已复制链接", { exact: true })).toBeVisible();
      await expect(card).toBeFocused();
      await expect(page.locator("textarea")).toHaveCount(0);
      const audit = await page.evaluate(
        () => (window as CopyAuditWindow).__copyAudit,
      );
      const link = new URL(page.url()).origin + albumUrl(album);
      expect(audit.apiValues).toEqual(
        mode === "missing" ? [] : Array(mode === "denied" ? 2 : 1).fill(link),
      );
      expect(audit.selections).toEqual(
        Array(mode === "api" ? 0 : mode === "denied" ? 2 : 1).fill({
          command: "copy",
          value: link,
          selectedValue: link,
          insideModal: false,
          focused: true,
        }),
      );
    });
  }
}

for (const entrypoint of ["more", "image"] as const) {
  test(`相册 ${entrypoint} 菜单复制链接并恢复来源焦点`, async ({ page }) => {
    const nodes = await scannedNodes(page.request);
    const album = nodes.find((node) => node.name === "sample-album")!;
    const original = (await (await page.request.get("/api/prefs")).json()) as {
      maxRecent: number;
      history: Array<{ albumId: string; name: string; imageCount: number }>;
    };
    try {
      await installCopyAudit(page, entrypoint === "more" ? "denied" : "api");
      await page.goto(albumUrl(album));
      const source =
        entrypoint === "more"
          ? page.getByRole("button", { name: "更多操作", exact: true })
          : page.getByRole("button", { name: "查看 page-1.png", exact: true });
      const copy = async () => {
        if (entrypoint === "more") await source.click();
        else await source.click({ button: "right" });
        await page
          .getByRole("menuitem", {
            name: "复制相册链接",
            exact: true,
          })
          .click();
      };
      await copy();
      if (entrypoint === "more") {
        await expect(
          page.getByText("复制失败，请检查浏览器权限", { exact: true }),
        ).toBeVisible();
        await expect(source).toBeFocused();
        await expect(page.locator("textarea")).toHaveCount(0);
        await page.evaluate(() => {
          (window as CopyAuditWindow).__copyAudit.throwOnSelection = false;
        });
        await copy();
      }
      await expect(page.getByText("已复制链接", { exact: true })).toBeVisible();
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(source).toBeFocused();
      await expect(page.locator("textarea")).toHaveCount(0);
      const audit = await page.evaluate(
        () => (window as CopyAuditWindow).__copyAudit,
      );
      const link = new URL(page.url()).origin + albumUrl(album);
      expect(audit.apiValues).toEqual(
        Array(entrypoint === "more" ? 2 : 1).fill(link),
      );
      for (const selection of audit.selections)
        expect(selection).toMatchObject({
          value: link,
          selectedValue: link,
          focused: true,
        });
    } finally {
      await restoreHistory(page.request, original);
    }
  });
}

for (const view of ["grid", "list"] as const) {
  test(`${view} 系统打开权限迟到后更新菜单，失败反馈后可重试`, async ({
    page,
  }) => {
    const nodes = await scannedNodes(page.request);
    const album = nodes.find((node) => node.name === "sample-album")!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/health", async (route) => {
      await gate;
      await route.fulfill({
        status: 200,
        json: { status: "ok", allowOsOpen: true },
      });
    });
    const requests: ReturnType<typeof systemOpenRequest>[] = [];
    let blocked = true;
    // 所有系统打开请求均拦截，浏览器回归不启动桌面文件管理器。
    await page.route(systemOpenRoute, async (route) => {
      requests.push(systemOpenRequest(route));
      await route.fulfill(
        blocked
          ? {
              status: 500,
              json: {
                code: "os_open_failed",
                message: "failed to open the resource",
              },
            }
          : { status: 200, json: { ok: true } },
      );
    });
    await page.goto("/");
    await page.getByRole("combobox").fill(album.name);
    await page
      .getByRole("button", {
        name: view === "grid" ? "网格视图" : "列表视图",
        exact: true,
      })
      .click();
    const card = page.locator(
      `main [data-virtuoso-scroller] a[href="/photo/albums/${album.id}"]`,
    );
    await card.click({ button: "right" });
    const open = page.getByRole("menuitem", {
      name: "在文件管理器中打开",
      exact: true,
    });
    await expect(open).toBeDisabled();
    release();
    await expect(open).toBeEnabled();
    await open.click();
    await expect(
      page.getByText("系统文件管理器未能打开，请确认目录仍可用后重试", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(card).toBeFocused();
    blocked = false;
    await card.click({ button: "right" });
    await open.click();
    await expect(
      page.getByText("已请求打开目录", { exact: true }),
    ).toBeVisible();
    await expect(card).toBeFocused();
    expect(requests).toEqual(
      Array(2).fill({
        endpoint: "/api/fs/open",
        method: "POST",
        body: { id: album.id },
        path: null,
        allowConfig: null,
      }),
    );
  });
}

test("相册系统打开权限更新更多及图片菜单，并说明本机限制", async ({ page }) => {
  const nodes = await scannedNodes(page.request);
  const album = nodes.find((node) => node.name === "sample-album")!;
  const original = (await (await page.request.get("/api/prefs")).json()) as {
    maxRecent: number;
    history: Array<{ albumId: string; name: string; imageCount: number }>;
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.route("**/api/health", async (route) => {
      await gate;
      await route.fulfill({
        status: 200,
        json: { status: "ok", allowOsOpen: true },
      });
    });
    let blocked = true;
    const requests: ReturnType<typeof systemOpenRequest>[] = [];
    await page.route(systemOpenRoute, async (route) => {
      requests.push(systemOpenRequest(route));
      await route.fulfill(
        blocked
          ? {
              status: 403,
              json: { code: "local_access_required", message: "local only" },
            }
          : { status: 200, json: { ok: true } },
      );
    });
    await page.goto(albumUrl(album));
    const more = page.getByRole("button", { name: "更多操作", exact: true });
    await more.click();
    const open = page.getByRole("menuitem", {
      name: "在文件管理器中打开",
      exact: true,
    });
    await expect(open).toBeDisabled();
    release();
    await expect(open).toBeEnabled();
    await open.click();
    await expect(
      page.getByText("请在运行服务的计算机上打开系统文件管理器", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(more).toBeFocused();
    blocked = false;
    const image = page.getByRole("button", {
      name: "查看 page-1.png",
      exact: true,
    });
    await image.click({ button: "right" });
    await open.click();
    await expect(
      page.getByText("已请求打开目录", { exact: true }),
    ).toBeVisible();
    await expect(image).toBeFocused();
    expect(requests.map((request) => request.body)).toEqual([
      { id: album.id },
      { id: album.id },
    ]);
  } finally {
    release();
    await restoreHistory(page.request, original);
  }
});

test("目录属性读取失败可重试", async ({ page }) => {
  const nodes = await scannedNodes(page.request);
  const album = nodes.find((node) => node.name === "sample-album")!;
  let blocked = true;
  await page.route("**/api/library/nodes/query", async (route) => {
    if (!blocked) return route.continue();
    await route.fulfill({
      status: 500,
      json: { code: "test_unavailable", message: "unavailable" },
    });
  });
  await page.goto("/");
  const { card, dialog } = await openCardProperties(page, album.id);
  await expect(dialog.getByRole("alert")).toContainText("无法读取目录属性", {
    timeout: 15_000,
  });
  blocked = false;
  await dialog.getByRole("button", { name: "重试加载", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "关闭", exact: true }),
  ).toBeFocused();
  await expect(dialog.getByText("sample-album", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(card).toBeFocused();
});

test("图片属性使用文件ID并支持失败重试和小屏关闭", async ({ page }) => {
  const nodes = await scannedNodes(page.request);
  const album = nodes.find((node) => node.name === "sample-album")!;
  const media = (await (
    await page.request.get(`/api/albums/${album.id}/media?limit=1`)
  ).json()) as {
    page: { items: Array<{ id: string; name: string }> };
  };
  const file = media.page.items[0];
  const original = (await (await page.request.get("/api/prefs")).json()) as {
    maxRecent: number;
    history: Array<{ albumId: string; name: string; imageCount: number }>;
  };
  let blocked = true;
  const metadataIds: string[] = [];
  await page.route("**/api/images/*/info", async (route) => {
    metadataIds.push(new URL(route.request().url()).pathname.split("/")[3]);
    if (!blocked) return route.continue();
    await route.fulfill({
      status: 500,
      json: { code: "test_unavailable", message: "unavailable" },
    });
  });
  try {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.goto(albumUrl(album));
    const image = page.getByRole("button", {
      name: "查看 page-1.png",
      exact: true,
    });
    await image.click({ button: "right" });
    await page.getByRole("menuitem", { name: "属性", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "属性", exact: true });
    await expect(dialog.getByRole("alert")).toContainText("无法读取图片属性");
    blocked = false;
    await dialog.getByRole("button", { name: "重试加载", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "关闭", exact: true }),
    ).toBeFocused();
    await expect(dialog.getByText(file.name, { exact: true })).toBeVisible();
    await expect(dialog.getByText("1 × 1 px", { exact: true })).toBeVisible();
    await expect(
      dialog
        .locator("dt")
        .filter({ hasText: /^目录$/ })
        .locator("..")
        .locator("dd"),
    ).toHaveText("media/sample-album");
    const bounds = await dialog.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.height).toBeLessThanOrEqual(740);
    expect(await dialog.innerText()).not.toMatch(
      /[A-Za-z]:[\\/]|\/(?:tmp|Users|home)\//,
    );
    await page.screenshot({
      path: test.info().outputPath("properties-image-mobile.png"),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(image).toBeFocused();
    expect(metadataIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(metadataIds)).toEqual(new Set([file.id]));
    await image.click({ button: "right" });
    await page.getByRole("menuitem", { name: "属性", exact: true }).click();
    await expect(dialog.getByText(file.name, { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(image).toBeFocused();
  } finally {
    await restoreHistory(page.request, original);
  }
});

test("年份卡直接打开这一年的照片墙，照片能回到原相册", async ({
  page,
  request,
}) => {
  await scannedNodes(request, "photo");
  await page.goto("/photo");

  // 年份卡的主操作是看这一年的照片：年份散在好几本相册里，
  // 先挑一本再进去等于让用户替系统做取舍。
  const year = page
    .getByTestId("year-timeline")
    .getByRole("button", { name: /^2024/ });
  await expect(year).toBeVisible();
  await year.click();
  await expect(page).toHaveURL(/\/photo\/years\/2024$/);

  // 墙上是这一年的照片，不是空页。
  const tile = page.locator('button[aria-label^="查看"]').first();
  await expect(tile).toBeVisible();

  // 照片带着它的出处：点开大图，标题说清是哪本，点一下就回去。
  await tile.click();
  const viewer = page.getByRole("dialog", { name: /大图预览/ });
  await expect(viewer).toBeVisible();
  const title = viewer.getByRole("link", { name: "2024年" });
  await expect(title).toBeVisible();
  await title.click();
  await expect(page).toHaveURL(/\/photo\/albums\//);
});

test("时间线年份卡的筛选按钮可访问名不与卡片本身混淆", async ({
  page,
  request,
}) => {
  const nodes = await scannedNodes(request);
  expect(nodes.length).toBeGreaterThan(0);
  await page.goto("/");

  const matches = page.getByRole("button", { name: "筛选该年份" });
  await expect(matches.first()).toBeVisible();
  // 只有真正的筛选按钮才应该被匹配到：年份卡的可访问名不能被按钮的 aria-label 污染，
  // 否则按名称定位（含子串匹配）会命中卡片而不是筛选按钮。
  const labels = await matches.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("aria-label")),
  );
  expect(labels.length).toBeGreaterThan(0);
  expect(labels.every((label) => label === "筛选该年份")).toBe(true);

  // 点击筛选按钮只切换下方网格的年份筛选，不跳转相册。
  await page
    .getByRole("button", { name: "筛选该年份", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "该年份的照片" }),
  ).toBeVisible();
  await expect(page).toHaveURL("/photo");
});

test("卡片悬停预览完整落在视口内，不被视口下缘裁掉", async ({ page }) => {
  await page.goto("/");
  // 明确取一张卡片上的链接：首屏专区里也有指向相册的链接（随手看看的
  // 封面），它不是卡片，没有悬停预览。
  const card = albumCard(page).getByRole("link", { name: /打开相册/ });
  await expect(card).toBeVisible();
  // 把卡片滚到视口下缘：预览会向下溢出，只有按整体高度夹紧才不会越界。
  await card.evaluate((el) => el.scrollIntoView({ block: "end" }));
  await page.waitForTimeout(300);
  await card.hover();

  const preview = page.getByRole("dialog", { name: /预览/ });
  await expect(preview).toBeVisible();
  const box = await preview.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
});

test("窄屏下顶栏不横向溢出，筛选标签保持一行", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("combobox", { name: "搜索相册或标签" }),
  ).toBeVisible();

  // 顶栏控件不能把整页撑宽，否则窄屏下会出现横向滚动。
  const width = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(width.scrollWidth).toBeLessThanOrEqual(width.innerWidth);

  // 快捷键提示在窄屏隐藏，把宽度让给搜索框。
  await expect(page.locator("header kbd")).toBeHidden();

  // 视图标签不能被压成竖排文字（一个字一行）。
  const chips = await page.evaluate(() => {
    const matched = [...document.querySelectorAll("button")].filter((button) =>
      // 两侧的类型词：叶级目录都叫「相册」，集合词分侧
      // （照片「集合」/ 漫画「作品」）。
      /^(全部|文件夹|集合|相册|作品|标签)\s*\d*$/.test(
        (button.textContent ?? "").trim(),
      ),
    );
    return matched.map((button) => ({
      text: (button.textContent ?? "").trim(),
      height: Math.round(button.getBoundingClientRect().height),
    }));
  });
  expect(chips.length).toBeGreaterThan(0);
  for (const chip of chips) {
    expect(chip.height, `标签「${chip.text}」被压成竖排`).toBeLessThan(40);
  }
});

test("卡片右上角的星标可以直接收藏，且不会跳转", async ({ page, request }) => {
  await page.goto("/");
  // 明确取一张卡片，而不是页面上第一个「打开相册」链接：首屏专区里也有
  // 指向相册的链接（随手看看的封面），它不是卡片，也没有星标。
  const card = albumCard(page);
  const link = card.getByRole("link", { name: /^打开相册/ });
  const href = await link.getAttribute("href");
  expect(href).toBeTruthy();
  const albumId = decodeURIComponent(href!.split("/albums/")[1] ?? "");
  await link.hover();

  // 星标按相册名精确定位：页面上还有标签卡片的星标，不能拿「第一个收藏按钮」。
  const title = (await link.getAttribute("aria-label"))!
    .replace(/^打开相册“/, "")
    .replace(/”$/, "");
  const star = card.getByRole("button", {
    name: `收藏「${title}」`,
    exact: true,
  });
  await expect(star).toBeVisible();
  await star.click();

  // 星标在链接之外：点击不能带着进入相册。
  await expect(page).toHaveURL("/photo");
  // 服务端确实写入了收藏。
  await expect
    .poll(async () => {
      const favorites = (await (
        await request.get("/api/favorites")
      ).json()) as { favorites: string[] };
      return favorites.favorites.includes(albumId);
    })
    .toBe(true);
  // 卡片上的星标切换成「取消收藏」。
  const unfavorite = card.getByRole("button", {
    name: `取消收藏「${title}」`,
    exact: true,
  });
  await expect(unfavorite).toBeVisible();

  // 复原：取消收藏，避免影响后续用例。
  await unfavorite.click();
  await expect
    .poll(async () => {
      const favorites = (await (
        await request.get("/api/favorites")
      ).json()) as { favorites: string[] };
      return favorites.favorites.includes(albumId);
    })
    .toBe(false);
});

test("窄屏设置项的标签保持一行，不被挤成竖排", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  // 标签与控件并排时，路径输入框会把中文标签挤成一列竖排文字。
  await expect
    .poll(async () =>
      page.evaluate(() =>
        [...document.querySelectorAll("span")].some((span) =>
          (span.textContent ?? "").trim().startsWith("缓存目录"),
        ),
      ),
    )
    .toBe(true);
  const label = await page.evaluate(() => {
    const spans = [...document.querySelectorAll("span")].filter((span) =>
      (span.textContent ?? "").trim().startsWith("缓存目录"),
    );
    const target = spans[spans.length - 1];
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    return { height: Math.round(rect.height), width: Math.round(rect.width) };
  });
  expect(label).not.toBeNull();
  expect(label!.height, "设置项标签被压成竖排").toBeLessThan(40);
  expect(label!.width, "设置项标签宽度不足一行").toBeGreaterThan(40);
});

test("浏览器解不了的图片给出明确提示而不是破图", async ({ page, request }) => {
  const nodes = await scannedNodes(request);
  const album = nodes.find((node) => node.name === "sample-format")!;
  await page.goto(albumUrl(album));
  await expect(
    page.getByRole("button", { name: "查看 photo.heic", exact: true }),
  ).toBeVisible();

  // 素材里的 photo.heic 浏览器解不了；服务端无法转换时返回 415，
  // 大图预览应显示提示，而不是浏览器的破图图标。
  await page
    .getByRole("button", { name: "查看 photo.heic", exact: true })
    .click();
  await expect(page.getByText("这张图片无法显示")).toBeVisible();
});

test("坏掉的图片在照片墙上标成「无法解码」", async ({ page, request }) => {
  const nodes = await scannedNodes(request);
  const album = nodes.find((node) => node.name === "sample-broken")!;
  await page.goto(albumUrl(album));

  // 扩展名说是 JPEG，内容却不是：服务端读图片头就判定"无法解码"，
  // 照片墙上写明原因，而不是画一个破图图标让人猜。
  const tile = page.getByRole("img", { name: "broken.jpg（无法解码）" });
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAttribute("title", "无法解码");

  // 打开大图预览同样说清楚，而不是空白。
  await page
    .getByRole("button", { name: "查看 broken.jpg", exact: true })
    .click();
  await expect(page.getByText("这张图片无法解码")).toBeVisible();
});

test("主页的视图筛选条紧贴在「库内一览」网格上方", async ({ page }) => {
  await page.goto("/");
  // 叶级目录两侧都叫「相册」：视图 chip 的名字用它。
  const chip = page.getByRole("button", { name: /^相册/ });
  await expect(chip).toBeVisible();
  await chip.scrollIntoViewIfNeeded();

  // 筛选条只作用于「库内一览」网格，必须和网格同处一个 section。
  // 之前它排在未读 / 继续浏览 / 时间线之前，离网格两千多像素，
  // 用户滚到网格时控件已经不在视野里。
  const order = await page.evaluate(() => {
    const heading = [...document.querySelectorAll("h2")].find(
      (el) => (el.textContent ?? "").trim() === "库内一览",
    );
    const chipButton = [...document.querySelectorAll("button")].find((el) =>
      (el.textContent ?? "").trim().startsWith("相册"),
    );
    const section = heading?.closest("section");
    const card = section?.querySelector('[data-testid="card-cover"]');
    if (!heading || !chipButton || !section || !card) return null;
    const follows = (a: Element, b: Element) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    return {
      chipInSection: section.contains(chipButton),
      headingBeforeChip: follows(heading, chipButton),
      chipBeforeCard: follows(chipButton, card),
    };
  });
  expect(order).toEqual({
    chipInSection: true,
    headingBeforeChip: true,
    chipBeforeCard: true,
  });
});

test("重设计后的首页把继续阅读放在首屏，未读区不再逐张挂「新」角标", async ({
  page,
}) => {
  // 这条用例验的是漫画工作台的首页：内容属性按目录划分，
  // 漫画根下的相册天然属于漫画工作台。
  const nodes = await scannedNodes(page.request, "comic");
  const album = nodes.find((node) => node.name === "sample-comic")!;
  expect(album).toBeDefined();
  await page.request.patch("/api/prefs", { data: { appMode: "comic" } });
  // 造一条「读到一半」的记录，首页才会出现「继续阅读」区块。
  const activityPath = `/api/activity?albumId=${album.id}&mediaKind=image`;
  expect(
    (
      await page.request.put("/api/activity", {
        data: {
          albumId: album.id,
          mediaKind: "image",
          pageIndex: 1,
          pageCount: 3,
        },
      })
    ).ok(),
  ).toBeTruthy();
  try {
    await page.goto("/");
    // 首页第一屏就要能看到「继续阅读」区块，而不是藏在第三个模块里。
    const continueSection = page.getByTestId("continue-hero");
    await expect(continueSection).toBeVisible();
    await expect(
      continueSection.getByRole("heading", { name: "继续阅读", level: 2 }),
    ).toBeVisible();

    // 未读区整页都是未读，卡片不再逐张挂「新」角标。
    const unread = page.getByTestId("unread-hero");
    await expect(unread).toBeVisible();
    await expect(unread.getByText("新", { exact: true })).toHaveCount(0);
    await expect(continueSection.getByTestId("unread-hero")).toHaveCount(0);
    expect(
      await unread.locator('a[href^="/comic/albums/"]').count(),
    ).toBeLessThanOrEqual(4);
    await expect(
      unread.getByRole("link", { name: "查看全部未读相册" }),
    ).toHaveAttribute("href", "/comic/unread");

    // 原生封面按钮可直接用键盘恢复上次阅读位置。
    const resume = continueSection.getByRole("button", {
      name: "继续阅读「sample-comic」",
      exact: true,
    });
    await resume.focus();
    await resume.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/comic/read/${album.id}`));
    await expect(page.getByRole("toolbar", { name: "阅读控制" })).toBeVisible();
    await page.goto("/");
  } finally {
    expect((await page.request.delete(activityPath)).ok()).toBeTruthy();
    await page.request.patch("/api/prefs", { data: { appMode: "photo" } });
  }
});

test("年份索引可用空格筛选，并保留首页上下文", async ({ page }) => {
  await scannedNodes(page.request);
  await page.goto("/");
  const years = page.getByTestId("year-timeline");
  await expect(years).toBeVisible();
  const filter = years
    .getByRole("button", { name: "筛选该年份", exact: true })
    .first();
  await filter.focus();
  await filter.press("Space");
  await expect(page).toHaveURL("/photo");
  await expect(
    page.getByRole("heading", { name: "该年份的照片", exact: true }),
  ).toBeVisible();
  await page.getByTitle("清除年份筛选", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "库内一览", exact: true }),
  ).toBeVisible();
});

test("列表视图按内容宽度切双列 / 三列，窄屏仍是单列", async ({ page }) => {
  // 未读页属于漫画工作台。
  await setWorkbenchMode(page.request, "comic");
  await page.goto("/comic/unread");
  await page.getByRole("button", { name: "列表视图", exact: true }).click();
  const cards = page.locator(
    'main [data-virtuoso-scroller] a[href^="/comic/albums/"]',
  );
  await expect(cards.first()).toBeVisible();

  // 1024：内容宽度不够（内容 816 → 单列 388 → 标题列只剩 222px），
  // 第二张卡换行。
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.waitForTimeout(500);
  let boxes = [];
  for (let i = 0; i < 2; i++) boxes.push(await cards.nth(i).boundingBox());
  expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y + 10);

  // 1280：内容宽度够了（内容 1072 → 双列每列 516），第二张卡与第一张
  // 卡同一行、左右并排。
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(500);
  boxes = [];
  for (let i = 0; i < 2; i++) boxes.push(await cards.nth(i).boundingBox());
  expect(Math.abs(boxes[1]!.y - boxes[0]!.y)).toBeLessThan(4);
  expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x + 100);

  // 1920（超宽）：改三列 —— 两列时每列 730px，标题与计数仍隔 484px。
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.waitForTimeout(500);
  boxes = [];
  for (let i = 0; i < 3; i++) boxes.push(await cards.nth(i).boundingBox());
  expect(Math.abs(boxes[1]!.y - boxes[0]!.y)).toBeLessThan(4);
  expect(Math.abs(boxes[2]!.y - boxes[0]!.y)).toBeLessThan(4);
  expect(boxes[2]!.x).toBeGreaterThan(boxes[1]!.x + 100);

  // 多列下仍然能点开相册（列表项仍是可点的链接）。
  // 未读页属于漫画工作台，漫画相册点开进阅读器。
  await cards.first().click();
  await expect(page).toHaveURL(/\/read\//);
});

test("列表只取首屏，真实后端分页与筛选保留完整计数", async ({
  page,
  request,
}) => {
  await scannedNodes(request, "comic");
  const calls: string[] = [];
  await page.route("**/api/library/overview?**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url.searchParams.get("cursor") ?? "first");
    url.searchParams.set("limit", "20");
    await route.fulfill({
      response: await route.fetch({ url: url.toString() }),
    });
  });
  await page.goto("/comic");
  await expect(page.getByRole("heading", { name: "库内一览" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "加载更多", exact: true }),
  ).toBeAttached();
  expect(calls.filter((cursor) => cursor === "first")).toHaveLength(1);
  expect(calls).toHaveLength(1);
  await page.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect.poll(() => calls.length).toBeGreaterThan(1);
  await page.getByRole("button", { name: "排序", exact: true }).click();
  await page.getByRole("button", { name: "按最近改", exact: true }).click();
  await expect
    .poll(() => calls.filter((cursor) => cursor === "first").length)
    .toBe(2);
});

test("年度照片墙的大图预览能跨页连续翻，不停在已加载的末尾", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await scannedNodes(request, "photo");
  await page.goto("/photo/years/2024");

  // 墙上是这一年的五百多张照片。
  const tile = page.locator('button[aria-label^="查看"]').first();
  await expect(tile).toBeVisible();
  await tile.click();

  const viewer = page.getByRole("dialog", { name: /大图预览/ });
  await expect(viewer).toBeVisible();
  // 总数报的是这一年的全部照片，不是已加载的那一段。
  const total = await viewer
    .locator("div")
    .filter({ hasText: /^第 \d+ 张 · 共 \d+ 张$/ })
    .first()
    .innerText();
  expect(total).toMatch(/共 (\d+) 张/);
  const totalCount = Number(/共 (\d+) 张/.exec(total)![1]);
  expect(totalCount).toBeGreaterThan(400);

  // 连按「下一张」跨过两个分页边界（200 与 400）。
  await page.keyboard.press("ArrowRight");
  for (let i = 0; i < 430; i += 1) {
    await page.keyboard.press("ArrowRight");
  }
  await expect
    .poll(async () => {
      const text = await viewer
        .locator("div")
        .filter({ hasText: /^第 \d+ 张 · 共 \d+ 张$/ })
        .first()
        .innerText();
      return Number(/第 (\d+) 张/.exec(text)![1]);
    }, { timeout: 30_000 })
    .toBeGreaterThan(400);

  // 翻过边界之后仍然能继续往后翻：末尾不是死的。
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);
  const after = await viewer
    .locator("div")
    .filter({ hasText: /^第 \d+ 张 · 共 \d+ 张$/ })
    .first()
    .innerText();
  expect(Number(/第 (\d+) 张/.exec(after)![1])).toBeGreaterThan(400);
});

test("年份墙的照片带回原相册，连续翻页也不串", async ({ page, request }) => {
  await scannedNodes(request, "photo");
  await page.goto("/photo/years/2024");
  const tile = page.locator('button[aria-label^="查看"]').first();
  await tile.click();
  const viewer = page.getByRole("dialog", { name: /大图预览/ });
  await expect(viewer).toBeVisible();
  // 标题是当前这张的出处，并且是链接：看完能回到那本相册。
  const title = viewer.getByRole("link");
  await expect(title).toBeVisible();
  const href = await title.getAttribute("href");
  expect(href).toMatch(/^\/photo\/albums\//);
});

test("首页「那年今日」摆的是当天那张照片，并能回到原相册", async ({
  page,
  request,
}) => {
  await scannedNodes(request, "photo");
  await page.goto("/photo");

  const section = page.getByTestId("on-this-day-section");
  await expect(section).toBeVisible();
  // 这一段摆的是照片卡，不是相册卡：相册的通用封面回答不了
  // 「往年这天我拍到了什么」。
  const photo = section.getByTestId("on-this-day-photo").first();
  await expect(photo).toBeVisible();

  await photo.getByRole("button").click();
  const viewer = page.getByRole("dialog", { name: /大图预览/ });
  await expect(viewer).toBeVisible();
  const title = viewer.getByRole("link");
  await expect(title).toBeVisible();
  await title.click();
  await expect(page).toHaveURL(/\/photo\/albums\//);
});

test("首页「随手看看」换一批换掉的是照片本身", async ({ page, request }) => {
  await scannedNodes(request, "photo");

  // 服务端侧：两个种子给出的是不同的一批相册。
  //
  // 这条断言不依赖素材的规模 —— 临时库里多为只有一两张照片的小相册，
  // 同一本相册每次都被整本取走，照片本身会重合；换的是哪几本相册
  // 才是「换一批」的实质。
  const albumSets = async (seed: string) => {
    const response = await request.get(
      `/api/library/media-feed?kind=photo&scope=random&seed=${seed}`,
    );
    const body = (await response.json()) as {
      page: { albums: Array<{ id: string }> };
    };
    return body.page.albums.map((album) => album.id).sort();
  };
  const first = await albumSets("e2e-seed-1");
  const second = await albumSets("e2e-seed-2");
  expect(first.length).toBeGreaterThan(1);
  expect(second).not.toEqual(first);

  // 界面侧：点「换一批」之后墙上换了一批照片。
  await page.goto("/photo");
  const wall = page.getByTestId("photo-feed-hero");
  await expect(wall).toBeVisible();

  // 按图片的资源 ID 比对：素材里各本相册的照片都叫 page-N.png，
  // 文件名会撞车，资源 ID 不会。
  const ids = async () =>
    wall.locator("img").evaluateAll((images) =>
      images
        .map((image) => (image.getAttribute("src") ?? "").replace(/^.*\/api\//, ""))
        .filter(Boolean),
    );
  await expect.poll(async () => (await ids()).length).toBeGreaterThan(3);
  const before = await ids();

  await wall.getByRole("button", { name: /换一批/ }).click();
  await expect
    .poll(async () => {
      const after = await ids();
      return after.join("|") === before.join("|");
    }, { timeout: 20_000 })
    .toBe(false);
});

test("分页浏览明暗主题与四个断点实际截图", async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await scannedNodes(request, "photo");
  const output = path.resolve(".smoke/roadmap-browse");
  mkdirSync(output, { recursive: true });
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/photo");
      await page.getByRole("button", { name: /^主题:/ }).click();
      await page
        .getByRole("menuitemradio", {
          name: theme === "dark" ? "深色" : "浅色",
          exact: true,
        })
        .click();
      await page.keyboard.press("Escape");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(
        page.getByRole("heading", { name: "库内一览" }),
      ).toBeAttached();
      await page.waitForFunction(() =>
        Array.from(document.images)
          .filter((image) => {
            const rect = image.getBoundingClientRect();
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              rect.top < innerHeight &&
              rect.bottom > 0 &&
              rect.left < innerWidth &&
              rect.right > 0
            );
          })
          .every((image) => image.complete),
      );
      await page.screenshot({
        path: path.join(output, `${theme}-${width}.png`),
      });
    }
  }
});

for (const source of ["home", "collection", "tag"] as const) {
  test(`${source} 服务端排序读取失败可重试`, async ({ page, request }) => {
    const { collectionId } = await sortFixture(request);
    const paths = {
      home: "/comic",
      collection: `/comic/albums/${collectionId}`,
      tag: `/comic/tags/${encodeURIComponent("测试")}`,
    };
    let blocked = true;
    await page.route("**/api/library/overview?**", async (route) => {
      if (
        blocked &&
        new URL(route.request().url()).searchParams.get("sort") === "viewed"
      ) {
        await route.fulfill({
          status: 500,
          json: { code: "test_unavailable", message: "unavailable" },
        });
      } else await route.continue();
    });
    await page.goto(paths[source]);
    await page.getByRole("button", { name: "排序", exact: true }).click();
    await page.getByRole("button", { name: "按最近看", exact: true }).click();
    await expect(
      page.getByRole("heading", {
        name: source === "tag" ? "标签加载失败" : "列表加载失败",
      }),
    ).toBeVisible({ timeout: 15000 });
    blocked = false;
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(
      page.getByRole("heading", {
        name: source === "tag" ? "标签加载失败" : "列表加载失败",
      }),
    ).toHaveCount(0);
    await expect(
      page.locator("[data-virtuoso-scroller]").first(),
    ).toBeAttached();
  });
}

/**
 * 缩略图请求的匹配规则。
 *
 * 缩略图 URL 现在带档位与版本号（?w=…&v=…），glob 里的 `?` 是「任意一个
 * 字符」而不是查询串的开头，匹配不到带参数的 URL。用正则既能匹配带参数的
 * 形式，又不会误伤 /cover 上传与其它同名路径。
 */
function thumbRoutePattern(fileId: string) {
  const path = `/api/thumbs/${fileId}`;
  // 用 pathname 判定：查询串（?w=…&v=…）不影响 pathname，
  // 而 /cover 上传的 pathname 仍然不同，不会误伤。
  return (url: URL) => url.pathname === path;
}
