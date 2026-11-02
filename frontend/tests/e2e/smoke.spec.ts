import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import { crc32, deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { VideoInfo, VideoInfoBatchItem } from "../../src/api/videos";
import type { DirectoryPage } from "../../src/api/fs";

// 生成一张纯色 PNG：用于验证阅读器按像素显示（原始尺寸）时，
// 图片不会被视口宽度夹住。测试素材目录是脚本建的临时目录。
function solidPng(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x66)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function renderedColors(locator: Locator, properties: string[]) {
  return locator.evaluate((element, properties) => {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) throw new Error("无法读取渲染颜色");
    const style = getComputedStyle(element);
    return properties.map((property) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = style.getPropertyValue(property);
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    });
  }, properties);
}

interface ManifestResponse {
  manifest: { scannedAt: string; roots: Array<{ id: string }> };
}

async function scannedNodes(request: APIRequestContext) {
  const config = (await (await request.get("/api/config")).json()) as {
    mediaRoots: string[];
  };
  if (config.mediaRoots.length > 1) {
    const response = await request.put("/api/config", {
      data: { mediaRoots: config.mediaRoots.slice(0, 1) },
    });
    expect(response.ok()).toBeTruthy();
  }
  const before = (await (
    await request.get("/api/library/manifest")
  ).json()) as Partial<ManifestResponse>;
  const previousScannedAt = before.manifest?.scannedAt;
  expect((await request.post("/api/scans")).ok()).toBeTruthy();
  await expect
    .poll(async () => {
      const response = await request.get("/api/library/manifest");
      if (!response.ok()) return previousScannedAt;
      return ((await response.json()) as ManifestResponse).manifest.scannedAt;
    })
    .not.toBe(previousScannedAt);
  const manifest = (await (
    await request.get("/api/library/manifest")
  ).json()) as ManifestResponse;
  const rootId = manifest.manifest.roots[0].id;
  const response = await request.get(
    `/api/library/${rootId}/children?limit=200`,
  );
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    page: {
      items: Array<{
        id: string;
        name: string;
        imageCount?: number;
        modTime?: string;
        date?: string;
      }>;
    };
  };
  return body.page.items;
}

const taggedSortPrefix =
  "zz-[测试][空 格][C++][100%][字面%20][字面%2F][字面%25] tagged-";

async function sortFixture(request: APIRequestContext) {
  const nodes = await scannedNodes(request);
  const rootAlbums = ["A", "M", "Z"].map((suffix) =>
    nodes.find((node) => node.name === taggedSortPrefix + suffix)!,
  );
  for (const node of rootAlbums) expect(node).toBeDefined();
  const collection = nodes.find((node) => node.name === "zz-sort-collection")!;
  expect(collection).toBeDefined();
  const response = await request.get(
    `/api/library/${collection.id}/children?limit=200`,
  );
  expect(response.ok()).toBeTruthy();
  const children = (await response.json()) as {
    page: { items: Array<{ id: string; name: string; imageCount?: number }> };
  };
  const childAlbums = ["A", "M", "Z"].map((suffix) =>
    children.page.items.find(
      (node) => node.name === taggedSortPrefix + suffix,
    )!,
  );
  for (const node of childAlbums) expect(node).toBeDefined();
  return { rootAlbums, childAlbums, collectionId: collection.id };
}

async function restoreHistory(
  request: APIRequestContext,
  original: {
    maxRecent: number;
    history: Array<{ albumId: string; name: string; imageCount: number }>;
  },
) {
  expect(
    (
      await request.patch("/api/prefs", {
        data: { maxRecent: original.maxRecent },
      })
    ).ok(),
  ).toBeTruthy();
  expect((await request.delete("/api/history")).ok()).toBeTruthy();
  for (const entry of [...original.history].reverse())
    expect(
      (await request.post("/api/history", { data: entry })).ok(),
    ).toBeTruthy();
}

async function openCardProperties(page: Page, nodeId: string) {
  const card = page.locator(
    `main [data-virtuoso-scroller] a[href="/albums/${nodeId}"]`,
  );
  await card.scrollIntoViewIfNeeded();
  await card.click({ button: "right" });
  await page.getByRole("menuitem", { name: "属性", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "属性", exact: true });
  await expect(dialog).toBeVisible();
  return { card, dialog };
}

test("扫描并打开示例相册", async ({ page }) => {
  // 服务带一个不存在的目录启动，仍可通过设置接口修复后扫描。
  const configResponse = await page.request.get("/api/config");
  expect(configResponse.ok()).toBeTruthy();
  const config = (await configResponse.json()) as { mediaRoots: string[] };
  expect(config.mediaRoots).toHaveLength(2);
  const repaired = await page.request.put("/api/config", {
    data: { mediaRoots: config.mediaRoots.slice(0, 1) },
  });
  expect(repaired.ok()).toBeTruthy();
  await page.goto("/");
  await expect(
    page.getByText("Local Gallery", { exact: false }).first(),
  ).toBeVisible();

  const scanButton = page
    .getByRole("button", { name: /开始扫描|重新扫描/ })
    .first();
  if (await scanButton.isVisible()) {
    await scanButton.click();
  }

  await expect(
    page.getByText("sample-album", { exact: false }).first(),
  ).toBeVisible({
    timeout: 20_000,
  });

  const manifestResponse = await page.request.get("/api/library/manifest");
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = (await manifestResponse.json()) as {
    manifest: { roots: Array<{ id: string }> };
  };
  const rootID = manifest.manifest.roots[0]?.id;
  expect(rootID).toBeTruthy();

  const response = await page.request.get(
    `/api/library/${encodeURIComponent(rootID ?? "")}/children?limit=1`,
  );
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    page: {
      items: Array<{
        id: string;
        coverImages: string[];
      }>;
    };
  };
  expect(body.page.items[0]?.id).toMatch(/^a_[A-Za-z0-9_-]+$/);
  expect(body.page.items[0]?.coverImages[0]).toMatch(/^f_/);

  await page
    .getByRole("link", { name: /打开相册“sample-album”/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/albums\/a_[A-Za-z0-9_-]+$/);

  const albumId = body.page.items[0].id;
  await page.route("**/api/activity", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({ status: 400, json: { error: "模拟保存失败" } });
    } else {
      await route.continue();
    }
  });
  await page.goto(`/gallery?path=${encodeURIComponent(albumId)}&index=1`);
  await expect(page.getByRole("alert")).toContainText("阅读进度未保存");
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.screenshot({
      path: test.info().outputPath(`progress-save-error-${theme}.png`),
    });
  }
  await page.unroute("**/api/activity");
  await page.getByRole("button", { name: "重试进度" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/activity?albumId=${encodeURIComponent(albumId)}&mediaKind=image`,
      );
      return response.ok() ? (await response.json()).pageIndex : -1;
    })
    .toBe(1);
  await page.goto(`/gallery?path=${encodeURIComponent(albumId)}`);
  await expect(page.getByTitle("跳转到指定页 (G)")).toHaveText("2");
});

for (const recovery of ["manual", "automatic"] as const) {
  test(`扫描进度连接中断后${recovery === "manual" ? "手动" : "自动"}恢复同一任务，不重复启动扫描`, async ({
    page,
  }) => {
    await scannedNodes(page.request);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const urls: string[] = [];
    let starts = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/scans") && request.method() === "POST")
        starts++;
    });
    let release = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const tasks: Promise<void>[] = [];
    let closing = false;
    await page.route("**/api/scans/*/events", (route) => {
      const attempt = urls.push(route.request().url());
      const task = (async () => {
        if (attempt === 1) {
          if (recovery === "manual")
            return route.fulfill({
              status: 503,
              json: { code: "test_disconnect", message: "进度连接暂不可用" },
            });
          const scanId = new URL(route.request().url()).pathname.split("/")[3];
          return route.fulfill({
            contentType: "text/event-stream",
            body: `retry: 1000\n\nevent: running\ndata: ${JSON.stringify({ scanId, status: "running", progress: 37, albumsFound: 7, elapsedMs: 500 })}\n\n`,
          });
        }
        await gate;
        if (closing) return route.abort().catch(() => {});
        const response = await route.fetch();
        await route.fulfill({ response }).catch(() => {});
      })();
      tasks.push(task);
      return task;
    });
    try {
      await page.clock.install();
      await page.goto("/settings");
      const scan = page.getByTitle("扫描 (Ctrl+S)", { exact: true });
      await scan.click();
      const card = page.getByTestId("scan-progress");
      await expect(card).toContainText("进度连接中断");
      await expect(page.locator("footer")).toContainText("扫描进度连接中断");
      await expect(scan).toBeDisabled();
      await page.keyboard.press("Control+s");
      await page.clock.runFor(100);
      expect(starts).toBe(1);
      if (recovery === "manual") {
        await page.clock.runFor(6000);
        await expect(card).toBeVisible();
        await page.getByRole("link", { name: /^未读/ }).click();
        await expect(card).toContainText("进度连接中断");
        await page.getByRole("link", { name: "设置", exact: true }).click();
        await page.getByRole("button", { name: "折叠扫描详情" }).click();
        await page
          .getByRole("button", { name: "重新连接进度", exact: true })
          .evaluate((element) => {
            const button = element as HTMLButtonElement;
            button.click();
            button.click();
          });
        await expect(card).toContainText("正在连接进度");
      } else {
        await expect(card).toContainText("37%");
        await expect(card).toContainText("正在自动重连");
      }
      await expect.poll(() => urls.length).toBe(2);
      expect(urls[0]).toBe(urls[1]);
      release();
      await expect(card).toContainText("扫描完成");
      expect(starts).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      closing = true;
      release();
      await page.close();
      await Promise.allSettled(tasks);
    }
  });
}

test("扫描进度任务无法读取时可停止跟踪，停止操作不取消或重新启动后台扫描", async ({
  page,
}) => {
  await scannedNodes(page.request);
  let starts = 0;
  let cancels = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/scans"))
      starts++;
    if (
      request.method() === "DELETE" &&
      new URL(request.url()).pathname.startsWith("/api/scans/")
    )
      cancels++;
  });
  await page.route("**/api/scans/*/events", (route) =>
    route.fulfill({
      status: 404,
      json: { code: "scan_not_found", message: "scan not found" },
    }),
  );
  await page.goto("/settings");
  const scan = page.getByTitle("扫描 (Ctrl+S)", { exact: true });
  await scan.click();
  const card = page.getByTestId("scan-progress");
  await expect(card).toContainText("进度连接中断");
  await expect(scan).toBeDisabled();
  await card.getByRole("button", { name: "停止跟踪", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(scan).toBeEnabled();
  expect(starts).toBe(1);
  expect(cancels).toBe(0);
});

test("扫描 error 业务事件显示任务失败，连接错误不混入业务进度", async ({
  page,
}) => {
  await scannedNodes(page.request);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let subscriptions = 0;
  await page.route("**/api/scans/*/events", (route) => {
    subscriptions++;
    const scanId = new URL(route.request().url()).pathname.split("/")[3];
    return route.fulfill({
      contentType: "text/event-stream",
      body: `event: error\ndata: ${JSON.stringify({ scanId, status: "error", progress: 0, albumsFound: 0, elapsedMs: 500, error: "root_missing" })}\n\n`,
    });
  });
  await page.goto("/settings");
  const scan = page.getByRole("button", { name: "重新扫描", exact: true });
  await scan.click();
  const card = page.getByTestId("scan-progress");
  await expect(card).toContainText("扫描失败");
  // 服务端给机器可读的错误码，界面翻译成中文说明。
  await expect(card).toContainText("媒体根不存在");
  await expect(card.getByRole("button", { name: "重新连接进度" })).toHaveCount(
    0,
  );
  await expect(scan).toBeEnabled();
  expect(subscriptions).toBe(1);
  expect(errors).toEqual([]);
});

test("设置页可加载服务端配置", async ({ page }) => {
  await page.goto("/settings");
  await expect(
    page.getByText("服务端", { exact: false }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("图像根目录", { exact: false }).first(),
  ).toBeVisible();
  const capacity = page
    .locator('input[type="number"]')
    .filter({ visible: true });
  const budget = capacity.locator('xpath=./self::input[@value="10240"]');
  await budget.fill("0");
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/config");
      return (await response.json()).cacheMaxSizeMB;
    })
    .toBe(0);
  await page.reload();
  await expect(
    page.locator('input[type="number"][value="0"]').first(),
  ).toBeVisible();
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
    await page.goto(`/albums/${album!.id}`);
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
        scroller.getByRole("button", { name: "打开第 1 张", exact: true }),
      ).toBeVisible();
      expect(failedRequests).toBe(4);
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await page.screenshot({
          path: test.info().outputPath(`media-page-error-${theme}.png`),
        });
      }
      failNextPage = false;
      await alert.getByRole("button", { name: "重试加载" }).click();
      await expect(alert).toHaveCount(0);
    }
    await expect.poll(() => mediaRequests.length).toBe(2);

    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const lastName =
      kind === "videos"
        ? "播放视频 405"
        : kind === "mixed"
          ? "播放zz-video.mp4"
          : "打开第 405 张";
    await expect(
      scroller.getByRole("button", { name: lastName, exact: true }),
    ).toBeVisible();
    expect(mediaRequests).toHaveLength(3);
  });
}

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
  await page.route(`**/api/thumbs/${fileId}`, async (route) => {
    if (route.request().method() === "HEAD" && !uploaded) {
      probes++;
      await route.fulfill({ status: 404 });
    } else {
      await route.continue();
    }
  });
  await page.goto(`/albums/${album!.id}`);
  await expect.poll(() => probes).toBeGreaterThan(0);
  await page.clock.fastForward(21_000);
  await expect.poll(() => uploaded).toBe(true);
  const cover = page.getByRole("img", {
    name: "sample-video-cover",
    exact: true,
  });
  await expect(cover).toHaveAttribute("src", `/api/thumbs/${fileId}`);
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
    await page.route(`**/api/thumbs/${fileId}`, async (route) => {
      if (fail && route.request().method() === "HEAD")
        await route.abort("failed");
      else await route.continue();
    });
    await page.goto(`/albums/${album!.id}`);
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
    const cover = grid.locator(`img[src="/api/thumbs/${fileId}"]`);
    await expect
      .poll(() =>
        cover.evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect(page).toHaveURL(new RegExp(`/albums/${album!.id}$`));
    await grid.getByRole("button", { name: /^播放/ }).focus();
    await page.keyboard.press("Space");
    await expect(page).toHaveURL(/\/gallery\?.*type=video/);
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
  await page.goto(`/albums/${album!.id}`);
  const cover = page.locator(`img[src="/api/thumbs/${fileId}"]`).first();
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
  await page.route(`**/api/thumbs/${fileId}`, async (route) => {
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
    await page.goto(`/albums/${album!.id}`);
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

test("空收藏返回数组且无失效项时清理显示零项成功", async ({ page }) => {
  await scannedNodes(page.request);
  const favorites = await page.request.get("/api/favorites");
  expect(favorites.ok()).toBeTruthy();
  expect((await favorites.json()).favorites).toEqual([]);
  await page.goto("/settings");
  await page.getByRole("button", { name: "清理", exact: true }).click();
  await expect(
    page.getByText("已清理 0 项失效收藏", { exact: true }),
  ).toBeVisible();
});

test("新打开相册立即出现在最近阅读，媒体分页不重复记录访问", async ({
  page,
}) => {
  const nodes = await scannedNodes(page.request);
  const album = nodes.find((node) => node.name === "sample-paged-images");
  expect(album).toBeDefined();
  expect((await page.request.delete("/api/history")).ok()).toBeTruthy();
  let historyWrites = 0;
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/history" &&
      request.method() === "POST"
    )
      historyWrites++;
  });
  await page.goto("/recents");
  await expect(page.getByText("还没有最近阅读", { exact: true })).toBeVisible();
  const search = page.getByRole("combobox");
  await search.fill("sample-paged-images");
  await expect(page.getByRole("option").first()).toBeVisible();
  await search.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/albums/${album!.id}$`));
  const scroller = page.locator("[data-virtuoso-scroller]");
  await expect(scroller.getByRole("button").first()).toBeVisible();
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    scroller.getByRole("button", { name: "打开第 405 张", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/history");
      const result = (await response.json()) as {
        history: Array<{ albumId: string }>;
      };
      return result.history[0]?.albumId;
    })
    .toBe(album!.id);
  await page.getByRole("link", { name: "最近", exact: true }).click();
  await expect(
    page.locator(`a[href="/albums/${album!.id}"]`).first(),
  ).toBeVisible();
  expect(historyWrites).toBe(1);
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
    mediaRoots: string[];
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

for (const albumName of ["sample-mixed-cover", "sample-video-cover"]) {
  test(`${albumName} 视频阅读标题和历史采用真实相册摘要`, async ({ page }) => {
    const nodes = await scannedNodes(page.request);
    const album = nodes.find((node) => node.name === albumName);
    expect(album).toBeDefined();
    const imageCount = albumName === "sample-mixed-cover" ? 2 : 0;
    expect(album!.imageCount ?? 0).toBe(imageCount);
    expect((await page.request.delete("/api/history")).ok()).toBeTruthy();
    let writes = 0;
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname === "/api/history" &&
        request.method() === "POST"
      )
        writes++;
    });
    const hint =
      albumName === "sample-mixed-cover"
        ? `&name=${encodeURIComponent("URL旧标题")}`
        : "";
    await page.goto(`/gallery?path=${album!.id}&type=video${hint}`);
    await expect(page.locator("header h1")).toContainText(albumName);
    await expect
      .poll(async () => {
        const response = await page.request.get("/api/history");
        const result = (await response.json()) as {
          history: Array<{ albumId: string; name: string; imageCount: number }>;
        };
        return result.history[0];
      })
      .toMatchObject({ albumId: album!.id, name: albumName, imageCount });
    expect(writes).toBe(1);
  });
}

for (const kind of ["image", "video"] as const) {
  for (const menuType of ["popover", "context"] as const) {
    test(`${kind} 阅读器 ${menuType} 菜单独立处理方向键和 Esc`, async ({
      page,
    }) => {
      const nodes = await scannedNodes(page.request);
      const album = nodes.find(
        (node) =>
          node.name ===
          (kind === "image" ? "sample-album" : "sample-video-shortcuts"),
      )!;
      expect(album).toBeDefined();
      await page.goto(`/albums/${album.id}`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        album.name,
      );
      await page.goto(`/gallery?path=${album.id}&type=${kind}&index=0`);
      const video = page.locator("video");
      if (kind === "video") {
        await expect
          .poll(() =>
            video.evaluate((element: HTMLVideoElement) => element.readyState),
          )
          .toBeGreaterThanOrEqual(1);
        await video.evaluate((element: HTMLVideoElement) => {
          element.pause();
          element.currentTime = 5;
          element.volume = 1;
        });
      } else await expect(page.getByTitle("跳转到指定页 (G)")).toHaveText("1");
      const initialURL = page.url();
      const opener = page.getByTitle("更多", { exact: true });
      if (menuType === "popover") await opener.click();
      else
        await page
          .locator(kind === "video" ? "video" : "[data-image-gallery]")
          .click({ button: "right" });
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      const enabled = menu.locator('[role="menuitem"]:not(:disabled)');
      const count = await enabled.count();
      expect(count).toBeGreaterThan(0);
      await expect(enabled.first()).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(enabled.nth(count > 1 ? 1 : 0)).toBeFocused();
      if (kind === "video")
        expect(
          await video.evaluate((element: HTMLVideoElement) => element.volume),
        ).toBe(1);
      await page.keyboard.press("ArrowUp");
      await expect(enabled.first()).toBeFocused();
      await page.keyboard.press("End");
      await expect(enabled.last()).toBeFocused();
      await page.keyboard.press("Home");
      await expect(enabled.first()).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("PageDown");
      await expect(page).toHaveURL(initialURL);
      if (kind === "video")
        await expect
          .poll(() =>
            video.evaluate((element: HTMLVideoElement) => element.currentTime),
          )
          .toBeCloseTo(5, 1);
      else await expect(page.getByTitle("跳转到指定页 (G)")).toHaveText("1");
      await page.keyboard.press("Escape");
      await expect(menu).not.toBeVisible();
      await expect(page).toHaveURL(initialURL);
      if (menuType === "popover") await expect(opener).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(new RegExp(`/albums/${album.id}$`));
    });
  }
}

for (const kind of ["image", "video"] as const) {
  test(`${kind} 阅读器保留按钮空格激活与系统修饰组合`, async ({ page }) => {
    const nodes = await scannedNodes(page.request);
    const album = nodes.find(
      (node) =>
        node.name ===
        (kind === "image" ? "sample-album" : "sample-video-shortcuts"),
    )!;
    expect(album).toBeDefined();
    await page.goto(`/albums/${album.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      album.name,
    );
    await page.goto(`/gallery?path=${album.id}&type=${kind}&index=0`);
    const back = page.getByTitle("返回 (Esc)", { exact: true });
    await expect(back).toBeVisible();
    if (kind === "video") {
      const video = page.locator("video");
      await expect
        .poll(() =>
          video.evaluate((element: HTMLVideoElement) => element.readyState),
        )
        .toBeGreaterThanOrEqual(1);
      await video.evaluate((element: HTMLVideoElement) => {
        element.pause();
        element.currentTime = 5;
        if (document.activeElement instanceof HTMLElement)
          document.activeElement.blur();
      });
      await page.keyboard.press("Control+ArrowLeft");
      await expect
        .poll(() =>
          video.evaluate((element: HTMLVideoElement) => element.currentTime),
        )
        .toBeCloseTo(5, 1);
    } else {
      await expect(page.getByTitle("跳转到指定页 (G)")).toHaveText("1");
      await page.keyboard.press("Control+g");
      await expect(page.locator('input[inputmode="numeric"]')).toHaveCount(0);
      await page.keyboard.press("g");
      const input = page.locator('input[inputmode="numeric"]');
      await expect(input).toBeFocused();
      await input.fill("2");
      await input.press("Enter");
      await expect(page.getByTitle("跳转到指定页 (G)")).toHaveText("2");
    }
    await back.focus();
    await page.keyboard.press("Space");
    await expect(page).toHaveURL(new RegExp(`/albums/${album.id}$`));
  });
}

test("视频失败后的重试按钮可用空格激活，重新读取媒体", async ({ page }) => {
  const nodes = await scannedNodes(page.request);
  const album = nodes.find((node) => node.name === "sample-video-shortcuts")!;
  expect(album).toBeDefined();
  const media = (await (
    await page.request.get(`/api/albums/${album.id}/media`)
  ).json()) as { page: { items: Array<{ id: string }> } };
  const fileId = media.page.items[0].id;
  await page.route(
    (url) => url.pathname === `/api/media/${fileId}`,
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"code":"test_media_unavailable"}',
      }),
  );
  await page.goto(`/gallery?path=${album.id}&type=video&index=0`);
  const retry = page.getByRole("button", { name: "重试", exact: true });
  await expect(retry).toBeVisible();
  const video = page.locator("video");
  const source = await video.getAttribute("src");
  await retry.focus();
  await page.keyboard.press("Space");
  await expect.poll(() => video.getAttribute("src")).not.toBe(source);
});

for (const mode of ["double", "continuous"] as const) {
  test(`视频快捷键不受图片 ${mode} 模式干扰，方向键定位、翻页键换片、Esc 返回`, async ({
    page,
  }) => {
    const nodes = await scannedNodes(page.request);
    const album = nodes.find((node) => node.name === "sample-video-shortcuts")!;
    expect(album).toBeDefined();
    await page.addInitScript((mode) => {
      localStorage.setItem(
        "local-gallery",
        JSON.stringify({
          state: { mode, fit: "fit", direction: "ltr" },
          version: 0,
        }),
      );
    }, mode);
    await page.goto(`/albums/${album.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      album.name,
    );
    await page.goto(`/gallery?path=${album.id}&type=video&index=1`);
    const video = page.locator("video");
    await expect
      .poll(() =>
        video.evaluate((element: HTMLVideoElement) => element.readyState),
      )
      .toBeGreaterThanOrEqual(1);
    await video.evaluate((element: HTMLVideoElement) => {
      element.pause();
      element.currentTime = 5;
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    });
    await expect(page.locator("header h1")).toContainText("2 / 3");
    const source = await video.getAttribute("src");
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() =>
        video.evaluate((element: HTMLVideoElement) => element.currentTime),
      )
      .toBeCloseTo(10, 1);
    await expect(page).toHaveURL(/type=video&index=1$/);
    await expect(video).toHaveAttribute("src", source!);
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(() =>
        video.evaluate((element: HTMLVideoElement) => element.currentTime),
      )
      .toBeCloseTo(5, 1);
    await page.keyboard.press("Space");
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
      .toBe(false);
    await page.keyboard.press("Space");
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
      .toBe(true);
    for (const key of ["1", "2", "3", "f", "l", "r"])
      await page.keyboard.press(key);
    expect(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("local-gallery")!).state,
      ),
    ).toEqual({ mode, fit: "fit", direction: "ltr" });
    for (const [key, index] of [
      ["PageDown", 2],
      ["PageUp", 1],
      ["Home", 0],
      ["End", 2],
    ] as const) {
      await page.keyboard.press(key);
      await expect(page).toHaveURL(new RegExp(`type=video&index=${index}$`));
    }
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/albums/${album.id}$`));
  });
}

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
  await expect(dialog.getByText("回到主页", { exact: true })).toBeVisible();
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

for (const kind of ["image", "video"] as const) {
  test(`${kind} 阅读器帮助不穿透按键，Esc 先关闭帮助再返回相册`, async ({
    page,
  }) => {
    const nodes = await scannedNodes(page.request);
    const album = nodes.find(
      (node) =>
        node.name ===
        (kind === "image" ? "sample-album" : "sample-video-shortcuts"),
    )!;
    expect(album).toBeDefined();
    await page.goto(`/albums/${album.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      album.name,
    );
    await page.goto(`/gallery?path=${album.id}&type=${kind}&index=0`);
    const video = page.locator("video");
    if (kind === "video") {
      await expect
        .poll(() =>
          video.evaluate((element: HTMLVideoElement) => element.readyState),
        )
        .toBeGreaterThanOrEqual(1);
      await video.evaluate((element: HTMLVideoElement) => {
        element.pause();
        element.muted = false;
        element.currentTime = 5;
      });
    } else await expect(page.getByTitle("跳转到指定页 (G)")).toHaveText("1");
    const opener = page.getByTitle("更多", { exact: true });
    await opener.click();
    await page.getByRole("menuitem", { name: "快捷键", exact: false }).click();
    const dialog = page.getByRole("dialog", { name: "快捷键", exact: true });
    await expect(
      dialog.getByRole("textbox", { name: "搜索快捷键" }),
    ).toBeFocused();
    await expect(dialog.getByText("回到主页", { exact: true })).toHaveCount(0);
    await expect(
      dialog.getByText("当前内容设为封面", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText("清除自定义封面", { exact: true }),
    ).toBeVisible();
    const search = dialog.getByRole("textbox", { name: "搜索快捷键" });
    if (kind === "video") {
      await expect(
        dialog.getByText("下一个视频", { exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByText("静音 / 取消静音", { exact: true }),
      ).toBeVisible();
      await expect(dialog.getByText("下一张", { exact: true })).toHaveCount(0);
      await expect(dialog.getByText(/旋转 90°/)).toHaveCount(0);
      await expect(dialog.getByText(/幻灯片/)).toHaveCount(0);
    } else
      await expect(dialog.getByText("下一张", { exact: true })).toBeVisible();
    await search.fill("Space");
    await expect(
      dialog.getByText(kind === "video" ? "播放 / 暂停" : "幻灯片播放/暂停", {
        exact: true,
      }),
    ).toBeVisible();
    await search.fill("");
    await dialog.getByRole("button", { name: "关闭", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    if (kind === "video") {
      await page.keyboard.press("k");
      await page.keyboard.press("m");
      await expect
        .poll(() =>
          video.evaluate((element: HTMLVideoElement) => element.currentTime),
        )
        .toBeCloseTo(5, 1);
      expect(
        await video.evaluate(
          (element: HTMLVideoElement) => element.paused && !element.muted,
        ),
      ).toBe(true);
    } else await expect(page.getByTitle("跳转到指定页 (G)")).toHaveText("1");
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page).toHaveURL(/\/gallery\?/);
    await expect(opener).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/albums/${album.id}$`));
  });
}

for (const failure of ["history", "nodes"] as const) {
  test(`最近阅读 ${failure} 读取失败不显示为空且可重试`, async ({ page }) => {
    const nodes = await scannedNodes(page.request);
    const album = nodes.find((node) => node.name === "sample-album");
    expect(album).toBeDefined();
    expect(
      (
        await page.request.post("/api/history", {
          data: { albumId: album!.id, name: album!.name, imageCount: 3 },
        })
      ).ok(),
    ).toBeTruthy();
    let blocked = true;
    const pattern =
      failure === "history" ? "**/api/history" : "**/api/library/nodes/query";
    await page.route(pattern, async (route) => {
      if (blocked)
        await route.fulfill({
          status: 500,
          json: { code: "test_unavailable", message: "unavailable" },
        });
      else await route.continue();
    });
    await page.goto("/recents");
    const alert = page.getByRole("alert");
    await expect(alert).toContainText(
      failure === "history" ? "最近阅读加载失败" : "相册信息加载失败",
      { timeout: 15_000 },
    );
    await expect(page.getByText("还没有最近阅读", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByText("没有匹配的最近访问", { exact: true }),
    ).toHaveCount(0);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.screenshot({
        path: test.info().outputPath(`recent-error-${theme}.png`),
      });
    }
    blocked = false;
    await alert.getByRole("button", { name: "重试加载", exact: true }).click();
    await expect(
      page.locator(`a[href="/albums/${album!.id}"]`).first(),
    ).toBeVisible();
    await expect(alert).toHaveCount(0);
  });
}

for (const failure of ["favorites", "nodes", "tags"] as const) {
  test(`收藏 ${failure} 读取失败不显示为空且可重试`, async ({ page }) => {
    const nodes = await scannedNodes(page.request);
    const album = nodes.find((node) => node.name === "sample-album");
    expect(album).toBeDefined();
    const resourceId = failure === "tags" ? "smart:测试" : album!.id;
    if (failure === "tags") {
      const tags = (await (await page.request.get("/api/tags")).json()) as {
        page: { items: Array<{ tag: string }> };
      };
      expect(tags.page.items).toContainEqual(
        expect.objectContaining({ tag: "测试" }),
      );
    }
    const original = (await (
      await page.request.get("/api/favorites")
    ).json()) as {
      favorites: string[];
    };
    expect(
      (
        await page.request.post("/api/favorites", { data: { resourceId } })
      ).ok(),
    ).toBeTruthy();
    try {
      let blocked = true;
      const pathname = {
        favorites: "/api/favorites",
        nodes: "/api/library/nodes/query",
        tags: "/api/tags",
      }[failure];
      await page.route(
        (url) => url.pathname === pathname,
        async (route) => {
          if (blocked)
            await route.fulfill({
              status: 500,
              json: { code: "test_unavailable", message: "unavailable" },
            });
          else await route.continue();
        },
      );
      await page.goto("/favorites");
      const alert = page.getByRole("alert");
      await expect(alert).toContainText(
        failure === "favorites" ? "收藏加载失败" : "收藏详情加载失败",
        { timeout: 15_000 },
      );
      await expect(page.getByText("还没有收藏", { exact: true })).toHaveCount(
        0,
      );
      await expect(
        page.getByText("没有匹配的收藏", { exact: true }),
      ).toHaveCount(0);
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await page.screenshot({
          path: test
            .info()
            .outputPath(`favorites-${failure}-error-${theme}.png`),
        });
      }
      blocked = false;
      await alert
        .getByRole("button", { name: "重试加载", exact: true })
        .click();
      const target =
        failure === "tags"
          ? `/tags/${encodeURIComponent("测试")}`
          : `/albums/${album!.id}`;
      await expect(page.locator(`a[href="${target}"]`).first()).toBeVisible();
      await expect(alert).toHaveCount(0);
    } finally {
      if (!original.favorites.includes(resourceId)) {
        expect(
          (
            await page.request.delete("/api/favorites", {
              data: { resourceId },
            })
          ).ok(),
        ).toBeTruthy();
      }
    }
  });
}

test("设置读取失败可重试，恢复后显示阅读设置", async ({ page }) => {
  let blocked = true;
  await page.route("**/api/prefs", async (route) => {
    if (blocked)
      await route.fulfill({
        status: 500,
        json: { code: "test_unavailable", message: "unavailable" },
      });
    else await route.continue();
  });
  await page.goto("/settings");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("设置加载失败", { timeout: 15_000 });
  await expect(page.getByText("加载中…", { exact: true })).toHaveCount(0);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const [border, background] = await renderedColors(alert, [
      "border-top-color",
      "background-color",
    ]);
    expect(border[3]).toBe(77);
    expect(background[3]).toBe(13);
    expect(border[0]).toBeGreaterThan(border[1] * 1.8);
    expect(background[0]).toBeGreaterThan(background[1] * 1.8);
    await page.screenshot({
      path: test.info().outputPath(`settings-error-${theme}.png`),
    });
  }
  blocked = false;
  await alert.getByRole("button", { name: "重试加载", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "阅读到末尾自动切换下一本" }),
  ).toBeVisible();
  await expect(alert).toHaveCount(0);
});

for (const operation of ["prefs", "prune", "history"] as const) {
  test(`设置 ${operation} 操作期间禁止重复请求，失败提示后可以重试`, async ({
    page,
  }) => {
    const original = (await (await page.request.get("/api/prefs")).json()) as {
      autoSwitchAlbum: boolean;
    };
    const pathname = {
      prefs: "/api/prefs",
      prune: "/api/favorites/prune",
      history: "/api/history",
    }[operation];
    const method = { prefs: "PATCH", prune: "POST", history: "DELETE" }[
      operation
    ];
    let blocked = true;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => url.pathname === pathname,
      async (route) => {
        if (!blocked || route.request().method() !== method)
          return route.continue();
        await gate;
        await route.fulfill({
          status: 500,
          json: { code: "test_unavailable", message: "unavailable" },
        });
      },
    );
    try {
      await page.goto("/settings");
      const action =
        operation === "prefs"
          ? page.getByRole("switch", { name: "阅读到末尾自动切换下一本" })
          : page.getByRole("button", {
              name: operation === "prune" ? /^清理(?:中…)?$/ : /^清空(?:中…)?$/,
            });
      await action.click();
      await expect(action).toBeDisabled();
      if (operation === "prefs") {
        await expect(
          page.getByRole("switch", { name: "切换时显示通知" }),
        ).toBeDisabled();
        await expect(
          page.getByRole("button", { name: "增加最近访问保留条数" }),
        ).toBeDisabled();
      }
      release();
      const message = {
        prefs: "保存阅读设置失败",
        prune: "清理失效收藏失败",
        history: "清空最近访问失败",
      }[operation];
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      await expect(action).toBeEnabled();
      if (operation === "prefs")
        await expect(action).toHaveAttribute(
          "aria-checked",
          String(original.autoSwitchAlbum),
        );
      blocked = false;
      await action.click();
      if (operation === "prefs") {
        await expect(action).toHaveAttribute(
          "aria-checked",
          String(!original.autoSwitchAlbum),
        );
      } else {
        await expect(
          page.getByText(
            operation === "prune"
              ? /^已清理 \d+ 项失效收藏$/
              : "已清空最近访问",
          ),
        ).toBeVisible();
      }
    } finally {
      release();
      if (operation === "prefs") {
        expect(
          (
            await page.request.patch("/api/prefs", {
              data: { autoSwitchAlbum: original.autoSwitchAlbum },
            })
          ).ok(),
        ).toBeTruthy();
      }
    }
  });
}

test("收藏写入成功后列表刷新失败仍保留已确认的状态", async ({ page }) => {
  const nodes = await scannedNodes(page.request);
  const album = nodes.find((node) => node.name === "sample-album");
  expect(album).toBeDefined();
  const resourceId = album!.id;
  const original = (await (
    await page.request.get("/api/favorites")
  ).json()) as { favorites: string[] };
  expect(
    (await page.request.post("/api/favorites", { data: { resourceId } })).ok(),
  ).toBeTruthy();
  try {
    await page.goto(`/albums/${resourceId}`);
    await expect(
      page.getByRole("button", { name: "已收藏", exact: true }),
    ).toBeVisible();
    let failedReads = 0;
    await page.route("**/api/favorites", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      failedReads++;
      await route.fulfill({
        status: 500,
        json: { code: "test_unavailable", message: "unavailable" },
      });
    });
    await page.getByRole("button", { name: "已收藏", exact: true }).click();
    const unselected = page.getByRole("button", { name: "收藏", exact: true });
    await expect(unselected).toBeVisible();
    await expect(page.getByText("已取消收藏", { exact: true })).toBeVisible();
    const removed = (await (
      await page.request.get("/api/favorites")
    ).json()) as { favorites: string[] };
    expect(removed.favorites).not.toContain(resourceId);
    await expect
      .poll(() => failedReads, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(8);
    await expect(unselected).toBeVisible();
    await unselected.click();
    await expect(
      page.getByRole("button", { name: "已收藏", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("已加入收藏", { exact: true })).toBeVisible();
    const added = (await (await page.request.get("/api/favorites")).json()) as {
      favorites: string[];
    };
    expect(added.favorites).toContain(resourceId);
    await page.getByRole("link", { name: "收藏", exact: true }).click();
    await expect(
      page.locator(`a[href="/albums/${resourceId}"]`).first(),
    ).toBeVisible();
    await expect(page.getByText("还没有收藏", { exact: true })).toHaveCount(0);
  } finally {
    if (!original.favorites.includes(resourceId)) {
      expect(
        (
          await page.request.delete("/api/favorites", { data: { resourceId } })
        ).ok(),
      ).toBeTruthy();
    }
  }
});

test("主题菜单隔离页面快捷键，支持键盘连续选择并持久保存", async ({ page }) => {
  const album = (await scannedNodes(page.request)).find(
    (node) => node.name === "sample-album",
  )!;
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`/albums/${album.id}`);
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
  const menu = page.getByRole("menu", { name: "主题与强调色" });
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
  await page.keyboard.press("End");
  await expect(
    menu.getByRole("menuitemradio", { name: "紫罗兰" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(light).toBeFocused();
  const indigo = menu.getByRole("menuitemradio", { name: "靛蓝" });
  await indigo.focus();
  await page.keyboard.press("Space");
  await expect(root).toHaveAttribute("data-accent", "indigo");
  await expect(indigo).toHaveAttribute("aria-checked", "true");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(root).toHaveAttribute("data-accent", "indigo");
  await trigger.click();
  await expect(dark).toHaveAttribute("aria-checked", "true");
  await expect(indigo).toHaveAttribute("aria-checked", "true");
  expect(errors).toEqual([]);
});

test("主题菜单保留 Tab 操作和外部焦点，关闭后恢复页面快捷键", async ({
  page,
}) => {
  await scannedNodes(page.request);
  await page.goto("/settings");
  const trigger = page.getByRole("button", { name: /^主题:/ });
  const menu = page.getByRole("menu", { name: "主题与强调色" });
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
  await page.keyboard.press("u");
  await expect(page).toHaveURL(/\/unread$/);
});

test("主题令牌在明暗模式和六种强调色下保持边框及透明背景", async ({ page }) => {
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
      "--border-faint",
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
    for (const [accent, name] of [
      ["graphite", "石墨"],
      ["indigo", "靛蓝"],
      ["rose", "绯红"],
      ["forest", "森林"],
      ["ochre", "琥珀"],
      ["plum", "紫罗兰"],
    ]) {
      await page.getByRole("button", { name, exact: true }).click();
      await expect(root).toHaveAttribute("data-accent", accent);
      const expected = await renderedColors(root, ["--accent-soft", "--fg"]);
      await expect
        .poll(() =>
          renderedColors(activeNavigation, ["background-color", "color"]),
        )
        .toEqual(expected);
    }
    await page.screenshot({
      path: test.info().outputPath(`theme-tokens-${theme}.png`),
    });
  }
});

for (const operation of ["limit", "clear", "visit"] as const) {
  test(`历史 ${operation} 写入成功后读取失败也保持最新列表`, async ({
    page,
  }) => {
    const nodes = await scannedNodes(page.request);
    const first = nodes.find((node) => node.name === "sample-album")!;
    const second = nodes.find((node) => node.name === "sample-mixed-cover")!;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const original = (await (await page.request.get("/api/prefs")).json()) as {
      maxRecent: number;
      history: Array<{ albumId: string; name: string; imageCount: number }>;
    };
    try {
      expect(
        (
          await page.request.patch("/api/prefs", { data: { maxRecent: 2 } })
        ).ok(),
      ).toBeTruthy();
      expect((await page.request.delete("/api/history")).ok()).toBeTruthy();
      for (const node of operation === "visit" ? [first] : [second, first]) {
        expect(
          (
            await page.request.post("/api/history", {
              data: {
                albumId: node.id,
                name: node.name,
                imageCount: node.imageCount ?? 0,
              },
            })
          ).ok(),
        ).toBeTruthy();
      }
      await page.goto("/recents");
      await expect(
        page.locator(`main a[href="/albums/${first.id}"]`).first(),
      ).toBeVisible();
      let failedReads = 0;
      await page.route("**/api/history", async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        failedReads++;
        await route.fulfill({
          status: 500,
          json: { code: "test_unavailable", message: "unavailable" },
        });
      });
      if (operation === "visit") {
        const search = page.getByRole("combobox");
        await search.fill(second.name);
        await expect(page.getByRole("option").first()).toBeVisible();
        await search.press("Enter");
        await expect(page).toHaveURL(new RegExp(`/albums/${second.id}$`));
      } else {
        await expect(
          page.locator(`main a[href="/albums/${second.id}"]`).first(),
        ).toBeVisible();
        await page.getByRole("link", { name: "设置", exact: true }).click();
        await page
          .getByRole("button", {
            name: operation === "limit" ? "减少最近访问保留条数" : "清空",
            exact: true,
          })
          .click();
      }
      await expect
        .poll(async () => {
          const result = (await (
            await page.request.get("/api/history")
          ).json()) as { history: Array<{ albumId: string }> };
          return result.history.map((entry) => entry.albumId);
        })
        .toEqual(
          operation === "clear"
            ? []
            : operation === "limit"
              ? [first.id]
              : [second.id, first.id],
        );
      await page.getByRole("link", { name: "最近", exact: true }).click();
      await expect
        .poll(() => failedReads, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(8);
      await expect(page.getByRole("alert")).toContainText("最近阅读加载失败");
      const firstCard = page
        .locator(`main a[href="/albums/${first.id}"]`)
        .first();
      const secondCard = page
        .locator(`main a[href="/albums/${second.id}"]`)
        .first();
      if (operation === "clear") await expect(firstCard).toHaveCount(0);
      else await expect(firstCard).toBeVisible();
      if (operation === "visit") await expect(secondCard).toBeVisible();
      else await expect(secondCard).toHaveCount(0);
    } finally {
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
}

test("失效收藏清理成功后刷新失败也立即更新收藏项数", async ({ page }) => {
  const nodes = await scannedNodes(page.request);
  const album = nodes.find((node) => node.name === "sample-album")!;
  expect(album).toBeDefined();
  const missing = "a_smoke_missing_20261031";
  const list = async () =>
    (await (await page.request.get("/api/favorites")).json()) as {
      favorites: string[];
    };
  const original = (await list()).favorites;
  try {
    for (const resourceId of [album.id, missing])
      expect(
        (
          await page.request.post("/api/favorites", { data: { resourceId } })
        ).ok(),
      ).toBeTruthy();
    const seededCount = (await list()).favorites.length;
    await page.goto("/favorites");
    await expect(
      page.locator(`main a[href="/albums/${album.id}"]`).first(),
    ).toBeVisible();
    const count = page.locator("main section").first().locator("p");
    await expect(count).toHaveText(`${seededCount} 项`);
    await page.getByRole("link", { name: "设置", exact: true }).click();
    let failedReads = 0;
    await page.route("**/api/favorites", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      failedReads++;
      await route.fulfill({
        status: 500,
        json: { code: "test_unavailable", message: "unavailable" },
      });
    });
    await page.getByRole("button", { name: "清理", exact: true }).click();
    await expect(page.getByText(/^已清理 \d+ 项失效收藏$/)).toBeVisible();
    const confirmed = (await list()).favorites;
    expect(confirmed).not.toContain(missing);
    await page.getByRole("link", { name: "收藏", exact: true }).click();
    await expect
      .poll(() => failedReads, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(8);
    await expect(count).toHaveText(`${confirmed.length} 项`);
    await expect(
      page.locator(`main a[href="/albums/${album.id}"]`).first(),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("仍显示已加载的收藏");
  } finally {
    for (const resourceId of (await list()).favorites)
      if (!original.includes(resourceId))
        expect(
          (
            await page.request.delete("/api/favorites", {
              data: { resourceId },
            })
          ).ok(),
        ).toBeTruthy();
    for (const resourceId of original)
      if (!(await list()).favorites.includes(resourceId))
        expect(
          (
            await page.request.post("/api/favorites", { data: { resourceId } })
          ).ok(),
        ).toBeTruthy();
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
      await page.goto(`/tags/${encodeURIComponent(tag)}`);
      await expect(
        page.getByRole("heading", { name: tag, exact: true }),
      ).toBeVisible();
      await expect(
        page
          .locator('main [data-virtuoso-scroller] a[href^="/albums/"]')
          .first(),
      ).toBeVisible();
    });
  }
});

test("六个列表的最近改排序使用真实修改时间", async ({ page }) => {
  const nodes = await scannedNodes(page.request);
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
    await page.request.get(`/api/library/${collection.id}/children?limit=200`)
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
      ["/", ids],
      [`/albums/${collection.id}`, childIds],
      ["/favorites", ids],
      ["/recents", ids],
      ["/unread", ids],
      [`/tags/${encodeURIComponent("测试")}`, ids],
    ] as const;
    for (const [path, expected] of pages) {
      await test.step(path, async () => {
        await page.goto(path);
        await page.getByRole("combobox").fill(prefix);
        if (path === "/") {
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
              .locator('main [data-virtuoso-scroller] a[href^="/albums/"]')
              .evaluateAll(
                (links, expected) =>
                  [
                    ...new Set(
                      links.map((link) =>
                        decodeURIComponent(
                          link.getAttribute("href")!.slice("/albums/".length),
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
      ["/", expectedRoot],
      [`/albums/${collectionId}`, expectedChildren],
      ["/favorites", expectedRoot],
      ["/recents", expectedRoot.slice(0, 2)],
      ["/unread", expectedRoot],
      [`/tags/${encodeURIComponent("测试")}`, expectedRoot],
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
              .locator('main [data-virtuoso-scroller] a[href^="/albums/"]')
              .evaluateAll(
                (links, expected) =>
                  [
                    ...new Set(
                      links.map((link) =>
                        decodeURIComponent(
                          link.getAttribute("href")!.slice("/albums/".length),
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
              `main [data-virtuoso-scroller] a[href="/albums/${expected[0]}"]`,
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

for (const name of ["home", "collection", "unread", "tag"] as const) {
  test(`${name} 最近看读取失败保留列表并可重试`, async ({ page }) => {
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
        home: "/",
        collection: `/albums/${collectionId}`,
        unread: "/unread",
        tag: `/tags/${encodeURIComponent("测试")}`,
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
      const albums = name === "collection" ? childAlbums : rootAlbums;
      const ids = albums.map((node) => node.id);
      const currentOrder = () =>
        page
          .locator('main [data-virtuoso-scroller] a[href^="/albums/"]')
          .evaluateAll(
            (links, ids) =>
              [
                ...new Set(
                  links.map((link) =>
                    decodeURIComponent(
                      link.getAttribute("href")!.slice("/albums/".length),
                    ),
                  ),
                ),
              ].filter((id) => ids.includes(id)),
            ids,
          );
      await expect.poll(currentOrder).toEqual(ids);
      if (name === "collection" || name === "tag") {
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

for (const name of ["home", "collection", "unread", "tag"] as const) {
  for (const mode of ["grid", "list"] as const) {
    test(`${name} ${mode} 长相册列表随实际滚动区域更新首尾卡片`, async ({
      page,
    }) => {
      const nodes = await scannedNodes(page.request);
      const prefix = "zz-[滚动回归] long-list-";
      const collection = nodes.find(
        (node) => node.name === "zz-scroll-collection",
      )!;
      expect(collection).toBeDefined();
      const children = (await (
        await page.request.get(
          `/api/library/${collection.id}/children?limit=200`,
        )
      ).json()) as { page: { items: Array<{ id: string; name: string }> } };
      const source = name === "collection" ? children.page.items : nodes;
      const first = source.find((node) => node.name === prefix + "001")!;
      const last = source.find((node) => node.name === prefix + "108")!;
      expect(first).toBeDefined();
      expect(last).toBeDefined();
      const paths = {
        home: "/",
        collection: `/albums/${collection.id}`,
        unread: "/unread",
        tag: `/tags/${encodeURIComponent("滚动回归")}`,
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
        'main [data-virtuoso-scroller] a[href^="/albums/"]',
      );
      const firstCard = page.locator(
        `main [data-virtuoso-scroller] a[href="/albums/${first.id}"]`,
      );
      const lastCard = page.locator(
        `main [data-virtuoso-scroller] a[href="/albums/${last.id}"]`,
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
  await scannedNodes(page.request);
  await page.goto("/unread");
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
      page.getByRole("button", { name: "按张数", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(options).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText("按张数");
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
    await expect(trigger).toContainText("按张数");
  });

  await test.step("Tab 从最后一项移出时关闭选项并保留下一控件焦点", async () => {
    await trigger.press("Enter");
    for (let index = 0; index < 5; index++) await page.keyboard.press("Tab");
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
    await expect(page.locator('main input[type="number"]')).toBeFocused();
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
  test(`${mode} 单图相册保持未读并可标记和取消已读`, async ({ page }) => {
    const nodes = await scannedNodes(page.request);
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
      await page.goto("/unread");
      await page.getByRole("combobox").fill(album.name);
      await page
        .getByRole("button", {
          name: mode === "grid" ? "网格视图" : "列表视图",
          exact: true,
        })
        .click();
      const card = page.locator(
        `main [data-virtuoso-scroller] a[href="/albums/${album.id}"]`,
      );
      await expect(card).toBeVisible();
      await expect(card.getByText("已读", { exact: true })).toHaveCount(0);
      await expect(card.getByText("100%", { exact: true })).toHaveCount(0);
      if (mode === "grid")
        await expect(card.getByText("新", { exact: true })).toBeVisible();
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
        menu.getByRole("menuitem", { name: "标记为已读", exact: true }),
      ).toBeEnabled();
      await expect(
        menu.getByRole("menuitem", { name: "取消已读", exact: true }),
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
          .getByRole("menuitem", { name: "标记为已读", exact: true })
          .click();
        await expect(page.getByText("标记失败", { exact: true })).toBeVisible();
        await expect(card).toBeVisible();
        expect((await page.request.get(activityPath)).status()).toBe(404);
        blocked = false;
        await card.click({ button: "right" });
      }
      await menu
        .getByRole("menuitem", { name: "标记为已读", exact: true })
        .click();
      await expect(
        page.getByText("已标记为已读", { exact: true }),
      ).toBeVisible();
      await expect(card).toHaveCount(0);
      const marked = await page.request.get(activityPath);
      expect(marked.ok()).toBeTruthy();
      expect(await marked.json()).toMatchObject({
        pageIndex: 0,
        pageCount: 1,
        status: "completed",
      });

      await page.getByRole("link", { name: "收藏", exact: true }).click();
      await expect(
        card.getByText("已读", { exact: true }).first(),
      ).toBeVisible();
      await card.click({ button: "right" });
      await expect(menu).toHaveCount(1);
      await expect(
        menu.getByRole("menuitem", { name: "标记为已读", exact: true }),
      ).toBeDisabled();
      await menu
        .getByRole("menuitem", { name: "取消已读", exact: true })
        .click();
      await expect(
        page.getByText("已重置为未读", { exact: true }),
      ).toBeVisible();
      await expect(card.getByText("已读", { exact: true })).toHaveCount(0);
      expect((await page.request.get(activityPath)).status()).toBe(404);
      await page.getByRole("link", { name: /^未读/ }).click();
      await expect(card).toBeVisible();
      await expect(card.getByText("已读", { exact: true })).toHaveCount(0);
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
      await expect(page).toHaveURL(/\/$/);
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

interface CopyAudit {
  apiValues: string[];
  selections: Array<{
    command: string;
    value: string;
    selectedValue: string;
    insideModal: boolean;
    focused: boolean;
  }>;
  throwOnSelection: boolean;
}

type CopyAuditWindow = Window & { __copyAudit: CopyAudit };

async function installCopyAudit(
  page: Page,
  mode: "api" | "missing" | "denied",
) {
  // 隔离系统剪贴板，记录浏览器中的真实焦点和选区。
  await page.addInitScript((mode) => {
    const audit: CopyAudit = {
      apiValues: [],
      selections: [],
      throwOnSelection: mode === "denied",
    };
    (window as CopyAuditWindow).__copyAudit = audit;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value:
        mode === "missing"
          ? undefined
          : {
              writeText(value: string) {
                audit.apiValues.push(value);
                return mode === "api"
                  ? Promise.resolve()
                  : Promise.reject(new Error("test denied"));
              },
            },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value(command: string) {
        const textarea = document.querySelector("textarea");
        const selection = {
          command,
          value: textarea?.value ?? "",
          selectedValue:
            textarea?.value.slice(
              textarea.selectionStart,
              textarea.selectionEnd,
            ) ?? "",
          insideModal: Boolean(textarea?.closest("dialog:modal")),
          focused: document.activeElement === textarea,
        };
        audit.selections.push(selection);
        if (audit.throwOnSelection) throw new Error("test copy failed");
        return selection.focused && selection.value === selection.selectedValue;
      },
    });
  }, mode);
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
    const copy = dialog
      .locator("dt")
      .filter({ hasText: /^名称$/ })
      .getByRole("button");
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
        `main [data-virtuoso-scroller] a[href="/albums/${album.id}"]`,
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
      const link = new URL(page.url()).origin + `/albums/${album.id}`;
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

test("收藏标签复制链接保留字面百分号并可直接打开", async ({ page }) => {
  await scannedNodes(page.request);
  const tag = "字面%2F";
  const resourceId = `smart:${tag}`;
  const original = (await (
    await page.request.get("/api/favorites")
  ).json()) as { favorites: string[] };
  try {
    expect(
      (
        await page.request.post("/api/favorites", { data: { resourceId } })
      ).ok(),
    ).toBeTruthy();
    await installCopyAudit(page, "api");
    await page.goto("/favorites");
    const tagPath = `/tags/${encodeURIComponent(tag)}`;
    const card = page.locator(
      `main [data-virtuoso-scroller] a[href="${tagPath}"]`,
    );
    await card.click({ button: "right" });
    await page.getByRole("menuitem", { name: "复制链接", exact: true }).click();
    await expect(page.getByText("已复制链接", { exact: true })).toBeVisible();
    await expect(card).toBeFocused();
    const audit = await page.evaluate(
      () => (window as CopyAuditWindow).__copyAudit,
    );
    expect(audit.apiValues).toEqual([new URL(page.url()).origin + tagPath]);
    await page.goto(audit.apiValues[0]);
    await expect(
      page.getByRole("heading", { name: tag, exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('main [data-virtuoso-scroller] a[href^="/albums/"]').first(),
    ).toBeVisible();
  } finally {
    if (!original.favorites.includes(resourceId))
      expect(
        (
          await page.request.delete("/api/favorites", { data: { resourceId } })
        ).ok(),
      ).toBeTruthy();
  }
});

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
      await page.goto(`/albums/${album.id}`);
      const source =
        entrypoint === "more"
          ? page.getByRole("button", { name: "更多操作", exact: true })
          : page.getByRole("button", { name: "打开第 1 张", exact: true });
      const copy = async () => {
        if (entrypoint === "more") await source.click();
        else await source.click({ button: "right" });
        await page
          .getByRole("menuitem", {
            name: entrypoint === "more" ? "复制链接" : "复制相册链接",
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
      const link = new URL(page.url()).origin + `/albums/${album.id}`;
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

const systemOpenRoute = /\/api\/(?:admin\/fs|fs)\/open(?:\?|$)/;

function systemOpenRequest(route: Route) {
  const request = route.request();
  const url = new URL(request.url());
  return {
    endpoint: url.pathname,
    method: request.method(),
    body:
      request.method() === "POST" ? (request.postDataJSON() as unknown) : null,
    path: url.searchParams.get("path"),
    allowConfig: url.searchParams.get("allowConfig"),
  };
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
      `main [data-virtuoso-scroller] a[href="/albums/${album.id}"]`,
    );
    await card.click({ button: "right" });
    const open = page.getByRole("menuitem", {
      name: "在资源管理器中打开",
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
    await page.goto(`/albums/${album.id}`);
    const more = page.getByRole("button", { name: "更多操作", exact: true });
    await more.click();
    const open = page.getByRole("menuitem", {
      name: "在资源管理器中打开",
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
      name: "打开第 1 张",
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

for (const health of ["late", "error"] as const) {
  test(`系统打开设置保存不依赖 ${health} 健康响应，配置目录使用白名单入口`, async ({
    page,
  }) => {
    const nodes = await scannedNodes(page.request);
    const album = nodes.find((node) => node.name === "sample-album")!;
    const original = (await (await page.request.get("/api/config")).json()) as {
      allowOsOpen: boolean;
      mediaRoots: string[];
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let completedHealth = 0;
    try {
      expect(
        (
          await page.request.put("/api/config", {
            data: { allowOsOpen: false },
          })
        ).ok(),
      ).toBeTruthy();
      await page.route("**/api/health", async (route) => {
        if (health === "late") await gate;
        await route
          .fulfill(
            health === "late"
              ? {
                  status: 200,
                  json: { status: "ok", allowOsOpen: false },
                }
              : {
                  status: 500,
                  json: { code: "test_unavailable", message: "unavailable" },
                },
          )
          .catch(() => {});
        completedHealth++;
      });
      const requests: ReturnType<typeof systemOpenRequest>[] = [];
      let blocked = true;
      await page.route(systemOpenRoute, async (route) => {
        requests.push(systemOpenRequest(route));
        await route.fulfill(
          blocked
            ? {
                status: 403,
                json: {
                  code: "config_path_not_allowed",
                  message: "path is not configured",
                },
              }
            : { status: 200, json: { ok: true } },
        );
      });
      const initialHealth = page.waitForRequest("**/api/health");
      await page.goto("/");
      await initialHealth;
      await page.getByRole("link", { name: "设置", exact: true }).click();
      const toggle = page.getByRole("switch", {
        name: "允许在系统文件管理器中打开",
        exact: true,
      });
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      const saved = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/config" &&
          response.request().method() === "PUT",
      );
      await toggle.click();
      expect((await saved).ok()).toBeTruthy();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      release();
      await expect.poll(() => completedHealth).toBeGreaterThan(0);
      const root = page.locator(
        `input[value=${JSON.stringify(original.mediaRoots[0])}]`,
      );
      const openRoot = root.locator("..").getByRole("button", {
        name: "在系统文件管理器中打开此目录",
        exact: true,
      });
      await openRoot.click();
      await expect(
        page.getByText("此目录尚未保存到配置，请保存后重试", { exact: true }),
      ).toBeVisible();
      blocked = false;
      await openRoot.click();
      await expect(
        page.getByText("已请求打开目录", { exact: true }),
      ).toBeVisible();
      expect(requests).toEqual(
        Array(2).fill({
          endpoint: "/api/admin/fs/open",
          method: "GET",
          body: null,
          path: original.mediaRoots[0],
          allowConfig: "1",
        }),
      );
      await page.getByRole("link", { name: "主页", exact: true }).click();
      await page.getByRole("combobox").fill(album.name);
      const card = page.locator(
        `main [data-virtuoso-scroller] a[href="/albums/${album.id}"]`,
      );
      await card.click({ button: "right" });
      await expect(
        page.getByRole("menuitem", { name: "在资源管理器中打开", exact: true }),
      ).toBeEnabled();
    } finally {
      release();
      expect(
        (
          await page.request.put("/api/config", {
            data: { allowOsOpen: original.allowOsOpen },
          })
        ).ok(),
      ).toBeTruthy();
    }
  });
}

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
    await page.goto(`/albums/${album.id}`);
    const image = page.getByRole("button", {
      name: "打开第 1 张",
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

test("设置目录选择使用真实路径，取消不保存且焦点留在弹窗内", async ({
  page,
}) => {
  const config = (await (await page.request.get("/api/config")).json()) as {
    mediaRoots: string[];
    cacheDir: string;
  };
  const response = await page.request.post("/api/admin/fs/directories", {
    data: { directory: config.mediaRoots[0] },
  });
  expect(response.ok()).toBe(true);
  const actual = (await response.json()) as DirectoryPage;
  expect(actual.items.length).toBeGreaterThan(0);
  const writes: unknown[] = [];
  await page.route("**/api/config", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    writes.push(route.request().postDataJSON());
    await route.fulfill({
      status: 400,
      json: { code: "test_blocked", message: "audit: no config write" },
    });
  });
  await page.goto("/settings");
  const rootInput = page
    .getByPlaceholder("E:\\照片 或 /home/user/pics")
    .first();
  const picker = rootInput
    .locator("..")
    .getByRole("button", { name: "选择本地目录", exact: true });
  await picker.click();
  const dialog = page.getByRole("dialog", { name: "选择目录", exact: true });
  const address = dialog.getByRole("textbox", {
    name: "目录路径",
    exact: true,
  });
  const useDirectory = dialog.getByRole("button", {
    name: "使用此目录",
    exact: true,
  });
  await expect(address).toHaveValue(actual.directory);
  await expect(useDirectory).toBeEnabled();
  await expect(address).toBeFocused();
  await useDirectory.focus();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "关闭", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(useDirectory).toBeFocused();
  await page.keyboard.press("Control+h");
  await expect(page).toHaveURL(/\/settings$/);
  await dialog
    .getByRole("button", { name: actual.items[0].name, exact: true })
    .click();
  await expect(address).toHaveValue(actual.items[0].path);
  await expect(useDirectory).toBeEnabled();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.screenshot({
      path: test.info().outputPath(`directory-picker-${theme}.png`),
    });
  }
  await page.setViewportSize({ width: 390, height: 660 });
  await expect
    .poll(
      async () => {
        const bounds = await dialog.boundingBox();
        return (
          bounds !== null &&
          bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= 390 &&
          bounds.y + bounds.height <= 660
        );
      },
      { message: "等待缩放后的目录弹窗完整位于视口内" },
    )
    .toBe(true);
  await page.screenshot({
    path: test.info().outputPath("directory-picker-mobile.png"),
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(picker).toBeFocused();
  await expect(rootInput).toHaveValue(config.mediaRoots[0]);
  expect(writes).toEqual([]);
  await picker.click();
  await expect(useDirectory).toBeEnabled();
  await address.fill(config.cacheDir);
  await expect(useDirectory).toBeDisabled();
  await address.press("Enter");
  await expect(useDirectory).toBeEnabled();
  const selected = await address.inputValue();
  await useDirectory.click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => writes)
    .toEqual([{ mediaRoots: [selected, ...config.mediaRoots.slice(1)] }]);
});

test("设置目录选择可分页和错误重试，完整保留 POSIX 路径", async ({ page }) => {
  const config = (await (
    await page.request.get("/api/config")
  ).json()) as Record<string, unknown>;
  const original = "/mnt/photos/archive";
  const selected = "/other/原图 [100%] #";
  const writes: unknown[] = [];
  let fail = true;
  await page.route("**/api/config", (route) => {
    if (route.request().method() === "PUT") {
      writes.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          ok: true,
          config: { ...config, mediaRoots: [selected] },
          requiresRestart: [],
          mediaRootsChanged: false,
        },
      });
    }
    return route.fulfill({ json: { ...config, mediaRoots: [original] } });
  });
  await page.route("**/api/admin/fs/directories", async (route) => {
    const body = route.request().postDataJSON() as {
      directory: string;
      after: string;
    };
    if (body.directory === selected && fail)
      return route.fulfill({
        status: 500,
        json: { code: "directory_read_failed", message: "private C:\\secret" },
      });
    const result: DirectoryPage =
      body.directory === selected
        ? {
            directory: selected,
            parent: "/other",
            roots: ["/"],
            items: [],
            nextAfter: "",
          }
        : {
            directory: original,
            parent: "/mnt/photos",
            roots: ["/"],
            items: [{ name: body.after ? "第二页" : "第一页", path: selected }],
            nextAfter: body.after ? "" : "第一页",
          };
    return route.fulfill({ json: result });
  });
  await page.goto("/settings");
  const rootInput = page.getByPlaceholder("E:\\照片 或 /home/user/pics");
  await rootInput
    .locator("..")
    .getByRole("button", { name: "选择本地目录", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "选择目录", exact: true });
  await dialog
    .getByRole("button", { name: "加载更多目录", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "第一页", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "第二页", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(/无法读取目录/);
  await expect(dialog).not.toContainText("private");
  await expect(
    dialog.getByRole("button", { name: "使用此目录", exact: true }),
  ).toBeDisabled();
  expect(writes).toEqual([]);
  fail = false;
  await dialog.getByRole("button", { name: "重试", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", { name: "目录路径", exact: true }),
  ).toHaveValue(selected);
  await dialog.getByRole("button", { name: "使用此目录", exact: true }).click();
  await expect.poll(() => writes).toEqual([{ mediaRoots: [selected] }]);
  await expect(rootInput).toHaveValue(selected);
});

test("设置缓存与静态目录按 Esc 撤销，Enter 和失焦只提交确认内容", async ({
  page,
}) => {
  const config = (await (
    await page.request.get("/api/config")
  ).json()) as Record<string, unknown>;
  const current = { ...config };
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/config", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const patch = route.request().postDataJSON() as Record<string, unknown>;
    writes.push(patch);
    Object.assign(current, patch);
    await route.fulfill({
      json: {
        ok: true,
        config: current,
        requiresRestart: [],
        mediaRootsChanged: false,
      },
    });
  });
  await page.goto("/settings");
  for (const field of ["cacheDir", "staticDir"] as const) {
    const original = String(config[field]);
    const placeholder = await page
      .locator(`input[value=${JSON.stringify(original)}]`)
      .getAttribute("placeholder");
    const input = page.getByPlaceholder(placeholder!, { exact: true });
    const before = writes.length;
    await input.fill(original + "_cancelled");
    await input.press("Escape");
    await expect(input).toHaveValue(original);
    await expect(input).not.toBeFocused();
    expect(writes).toHaveLength(before);
    await input.fill(original + "_confirmed");
    await input.press("Enter");
    await expect.poll(() => writes.length).toBe(before + 1);
    expect(writes[before]).toEqual({ [field]: original + "_confirmed" });
    await expect(input).toHaveValue(original + "_confirmed");
    await input.fill(original + "_blurred");
    await input.press("Tab");
    await expect.poll(() => writes.length).toBe(before + 2);
    expect(writes[before + 1]).toEqual({ [field]: original + "_blurred" });
  }
  expect(writes).toHaveLength(4);
  expect(JSON.stringify(writes)).not.toContain("_cancelled");
});

test("设置媒体根按 Esc 撤销整组未提交内容并保留已经确认的自动保存", async ({
  page,
}) => {
  const config = (await (await page.request.get("/api/config")).json()) as {
    mediaRoots: string[];
    cacheDir: string;
  };
  const roots = [config.mediaRoots[0], config.cacheDir];
  let current = { ...config, mediaRoots: roots };
  const writes: { mediaRoots: string[] }[] = [];
  await page.route("**/api/config", async (route) => {
    if (route.request().method() === "PUT") {
      const patch = route.request().postDataJSON() as { mediaRoots: string[] };
      writes.push(patch);
      current = { ...current, ...patch };
      return route.fulfill({
        json: {
          ok: true,
          config: current,
          requiresRestart: [],
          mediaRootsChanged: false,
        },
      });
    }
    return route.fulfill({ json: current });
  });
  await page.clock.install();
  await page.goto("/settings");
  const inputs = page.getByPlaceholder("E:\\照片 或 /home/user/pics");
  await inputs.nth(0).fill(roots[0] + "_cancelled");
  await inputs.nth(1).fill(roots[1] + "_cancelled");
  await page.getByRole("button", { name: "添加根目录", exact: true }).click();
  await inputs.nth(2).press("Escape");
  await expect(inputs).toHaveCount(2);
  await expect(inputs.nth(0)).toHaveValue(roots[0]);
  await expect(inputs.nth(1)).toHaveValue(roots[1]);
  // 推进超过自动保存窗口，确认取消的旧定时结果不会发出写请求。
  await page.clock.runFor(700);
  expect(writes).toEqual([]);

  const saved = roots[0] + "_confirmed";
  await inputs.nth(0).fill(saved);
  const acknowledged = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === "/api/config",
  );
  await page.clock.runFor(500);
  expect((await acknowledged).ok()).toBe(true);
  await expect.poll(() => writes).toEqual([{ mediaRoots: [saved, roots[1]] }]);
  await expect(inputs.nth(0)).toHaveValue(saved);
  await inputs.nth(0).fill(roots[0] + "_cancelled_again");
  await inputs.nth(0).press("Escape");
  await expect(inputs.nth(0)).toHaveValue(saved);
  await page.clock.runFor(700);
  expect(writes).toHaveLength(1);
});

test("设置自动保存等待组合输入确认，其他字段仍可保存", async ({ page }) => {
  const config = (await (await page.request.get("/api/config")).json()) as {
    mediaRoots: string[];
    host: string;
    port: number;
  };
  const current = { ...config };
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/config", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const patch = route.request().postDataJSON() as Record<string, unknown>;
    writes.push(patch);
    Object.assign(current, patch);
    return route.fulfill({
      json: {
        ok: true,
        config: current,
        requiresRestart: [],
        mediaRootsChanged: false,
      },
    });
  });
  const compose = async (
    input: Locator,
    phase: "start" | "end",
    value: string,
  ) => {
    await input.evaluate(
      (element, { phase, value }) => {
        if (!(element instanceof HTMLInputElement))
          throw new Error("expected input");
        if (phase === "start") {
          element.focus();
          element.dispatchEvent(
            new CompositionEvent("compositionstart", { bubbles: true }),
          );
        }
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        if (!setter) throw new Error("input value setter unavailable");
        setter.call(element, value);
        element.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: value,
            inputType: "insertCompositionText",
            isComposing: true,
          }),
        );
        if (phase === "end")
          element.dispatchEvent(
            new CompositionEvent("compositionend", {
              bubbles: true,
              data: value,
            }),
          );
      },
      { phase, value },
    );
  };
  await page.clock.install();
  await page.goto("/settings");
  const root = page.getByPlaceholder("E:\\照片 或 /home/user/pics").first();
  await compose(root, "start", "/photos/候选目录");
  await page.clock.runFor(1000);
  expect(writes).toEqual([]);
  await expect(root).toHaveValue("/photos/候选目录");
  await compose(root, "end", "/photos/确认目录");
  await page.clock.runFor(200);
  expect(writes).toEqual([]);
  const rootSaved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === "/api/config",
  );
  await page.clock.runFor(300);
  expect((await rootSaved).ok()).toBe(true);
  await expect
    .poll(() => writes)
    .toEqual([
      { mediaRoots: ["/photos/确认目录", ...config.mediaRoots.slice(1)] },
    ]);

  // 依据服务端原值定位一次，后续不再用会随输入变化的 value 选择器。
  const hostIndex = await page
    .locator('input[type="text"]')
    .evaluateAll(
      (inputs, host) =>
        inputs.findIndex((input) => (input as HTMLInputElement).value === host),
      config.host,
    );
  expect(hostIndex).toBeGreaterThanOrEqual(0);
  const host = page.locator('input[type="text"]').nth(hostIndex);
  await page
    .locator(`input[type="number"][value="${config.port}"]`)
    .fill("9090");
  await compose(host, "start", "候选.local");
  const portSaved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === "/api/config",
  );
  await page.clock.runFor(700);
  expect((await portSaved).ok()).toBe(true);
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ port: 9090 });
  await expect(host).toHaveValue("候选.local");
  await compose(host, "end", "localhost");
  await page.clock.runFor(200);
  expect(writes).toHaveLength(2);
  const hostSaved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === "/api/config",
  );
  await page.clock.runFor(500);
  expect((await hostSaved).ok()).toBe(true);
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2]).toEqual({ host: "localhost" });
  const numberIndex = await page
    .locator('input[type="number"]')
    .evaluateAll((inputs) =>
      inputs.findIndex((input) => (input as HTMLInputElement).value === "9090"),
    );
  expect(numberIndex).toBeGreaterThanOrEqual(0);
  const numberInput = page.locator('input[type="number"]').nth(numberIndex);
  await compose(numberInput, "start", "909");
  await page.clock.runFor(1000);
  expect(writes).toHaveLength(3);
  await compose(numberInput, "end", "9091");
  await page.clock.runFor(200);
  expect(writes).toHaveLength(3);
  const numberSaved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === "/api/config",
  );
  await page.clock.runFor(500);
  expect((await numberSaved).ok()).toBe(true);
  await expect.poll(() => writes.length).toBe(4);
  expect(writes[3]).toEqual({ port: 9091 });
  expect(JSON.stringify(writes)).not.toContain("候选");
});

for (const failFirst of [false, true]) {
  test(`配置保存串行并在重新进入后保留最新值，首次${failFirst ? "失败" : "成功"}`, async ({
    page,
  }) => {
    const config = (await (
      await page.request.get("/api/config")
    ).json()) as Record<string, unknown>;
    let confirmed = {
      ...config,
      mediaRoots: [String((config.mediaRoots as string[])[0])],
    };
    const writes: Record<string, unknown>[] = [];
    const release: Array<() => void> = [];
    const tasks: Promise<void>[] = [];
    let closing = false;
    let active = 0;
    let maxActive = 0;
    await page.route("**/api/config", (route) => {
      if (route.request().method() !== "PUT")
        return route.fulfill({ json: confirmed });
      if (closing)
        return route
          .fulfill({
            status: 500,
            json: { code: "test_closed", message: "closed" },
          })
          .catch(() => {});
      const task = (async () => {
        const patch = route.request().postDataJSON() as Record<string, unknown>;
        const index = writes.push(patch) - 1;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => {
          release[index] = resolve;
        });
        active--;
        if (index === 0 && failFirst)
          return route
            .fulfill({
              status: 500,
              json: { code: "test_save_failed", message: "保存失败，请重试" },
            })
            .catch(() => {});
        confirmed = { ...confirmed, ...patch };
        await route
          .fulfill({
            json: {
              ok: true,
              config: confirmed,
              requiresRestart: [],
              mediaRootsChanged: false,
            },
          })
          .catch(() => {});
      })();
      tasks.push(task);
      return task;
    });
    try {
      await page.clock.install();
      await page.goto("/settings");
      const input = page.getByPlaceholder("E:\\照片 或 /home/user/pics");
      await input.fill("/queue/first");
      await page.clock.runFor(500);
      await expect.poll(() => writes.length).toBe(1);
      await expect(input).toHaveValue("/queue/first");
      await input.fill("/queue/latest");
      await page.clock.runFor(700);
      expect(writes).toHaveLength(1);
      await expect(input).toHaveValue("/queue/latest");
      await page.getByRole("link", { name: /^主页/ }).click();
      await page.getByRole("link", { name: "设置", exact: true }).click();
      await expect(input).toHaveValue("/queue/latest");
      release[0]();
      await expect.poll(() => writes.length).toBe(2);
      await expect(input).toHaveValue("/queue/latest");
      const last = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          response.request().postDataJSON().mediaRoots?.[0] === "/queue/latest",
      );
      release[1]();
      expect((await last).ok()).toBe(true);
      await page.clock.runFor(5);
      await expect(input).toHaveValue("/queue/latest");
      await expect(page.getByLabel("保存中", { exact: true })).toHaveCount(0);
      await expect(page.getByLabel("保存失败", { exact: true })).toHaveCount(0);
      expect(writes).toEqual([
        { mediaRoots: ["/queue/first"] },
        { mediaRoots: ["/queue/latest"] },
      ]);
      expect(maxActive).toBe(1);
    } finally {
      closing = true;
      release.forEach((done) => done());
      await page.close();
      await Promise.allSettled(tasks);
    }
  });
}

test("配置保存失败离开后仍保留输入，按 Enter 显式重试且不自动重放", async ({
  page,
}) => {
  const config = (await (
    await page.request.get("/api/config")
  ).json()) as Record<string, unknown>;
  let current = { ...config, mediaRoots: [(config.mediaRoots as string[])[0]] };
  const writes: Record<string, unknown>[] = [];
  let release = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const tasks: Promise<void>[] = [];
  let closing = false;
  await page.route("**/api/config", (route) => {
    if (route.request().method() !== "PUT")
      return route.fulfill({ json: current });
    const patch = route.request().postDataJSON() as Record<string, unknown>;
    const attempt = writes.push(patch);
    const task = (async () => {
      if (attempt === 1) {
        await gate;
        if (closing) return route.abort().catch(() => {});
        await route.fulfill({
          status: 500,
          json: { code: "test_failure", message: "保存中断" },
        });
      } else {
        current = { ...current, ...patch };
        await route.fulfill({
          json: {
            ok: true,
            config: current,
            requiresRestart: [],
            mediaRootsChanged: false,
          },
        });
      }
    })();
    tasks.push(task);
    return task;
  });
  try {
    await page.clock.install();
    await page.goto("/settings");
    const input = page.getByPlaceholder("E:\\照片 或 /home/user/pics");
    await input.fill("/retry/photos");
    await page.clock.runFor(500);
    await expect.poll(() => writes.length).toBe(1);
    await page.getByRole("link", { name: /^主页/ }).click();
    const failed = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith("/api/config"),
    );
    release();
    expect((await failed).status()).toBe(500);
    await page.getByRole("link", { name: "设置", exact: true }).click();
    await expect(input).toHaveValue("/retry/photos");
    await expect(page.getByRole("button", { name: "重试保存" })).toBeVisible();
    await page.clock.runFor(1500);
    expect(writes).toHaveLength(1);
    await input.press("Enter");
    await expect.poll(() => writes.length).toBe(2);
    await expect(page.getByRole("button", { name: "重试保存" })).toHaveCount(0);
    await expect(input).toHaveValue("/retry/photos");
    expect(writes).toEqual([
      { mediaRoots: ["/retry/photos"] },
      { mediaRoots: ["/retry/photos"] },
    ]);
    await expect(
      page.getByText("媒体根目录配置已确认，建议重新扫描以刷新媒体库"),
    ).toBeVisible();
  } finally {
    closing = true;
    release();
    await page.close();
    await Promise.allSettled(tasks);
  }
});

test("配置失败后可取消重新读取，迟到结果不覆盖新读取且其他草稿继续保存", async ({
  page,
}) => {
  const config = (await (
    await page.request.get("/api/config")
  ).json()) as Record<string, unknown>;
  let current = { ...config };
  let holdRead = false;
  let held = false;
  let release = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const tasks: Promise<void>[] = [];
  const writes: Record<string, unknown>[] = [];
  let closing = false;
  await page.route("**/api/config", (route) => {
    const task = (async () => {
      if (route.request().method() === "PUT") {
        const patch = route.request().postDataJSON() as Record<string, unknown>;
        writes.push(patch);
        if (patch.cacheDir !== undefined)
          return route.fulfill({
            status: 500,
            json: { code: "test_failure", message: "保存中断" },
          });
        current = { ...current, ...patch };
        return route.fulfill({
          json: {
            ok: true,
            config: current,
            requiresRestart: [],
            mediaRootsChanged: false,
          },
        });
      }
      const snapshot = { ...current };
      if (holdRead) {
        held = true;
        await gate;
      }
      if (closing) return route.abort().catch(() => {});
      await route.fulfill({ json: snapshot }).catch(() => {});
    })();
    tasks.push(task);
    return task;
  });
  try {
    await page.clock.install();
    await page.goto("/settings");
    const cache = page.getByPlaceholder(
      "存放缩略图 / 扫描结果 / 用户偏好，修改后需重启",
      { exact: true },
    );
    await cache.fill("/failed/cache");
    await cache.press("Tab");
    await expect(page.getByLabel("保存失败", { exact: true })).toBeVisible();
    await expect(cache).toHaveValue("/failed/cache");
    const port = page.locator(`input[value="${String(config.port)}"]`);
    const editedPort = Number(config.port) === 9001 ? 9002 : 9001;
    const portInput = page.getByRole("spinbutton").last();
    await expect(port).toHaveCount(1);
    await portInput.fill(String(editedPort));
    holdRead = true;
    await page.getByRole("button", { name: "重新读取配置" }).click();
    await expect.poll(() => held).toBe(true);
    await expect(cache).toBeDisabled();
    await expect(portInput).toHaveValue(String(editedPort));
    await page.clock.runFor(1000);
    expect(writes).toHaveLength(1);
    await page.getByRole("button", { name: "取消读取" }).click();
    await expect(cache).toBeEnabled();
    holdRead = false;
    current = { ...current, cacheDir: "/confirmed/cache" };
    await page.getByRole("button", { name: "重新读取配置" }).click();
    await expect(cache).toHaveValue("/confirmed/cache");
    release();
    await page.clock.runFor(50);
    await expect(cache).toHaveValue("/confirmed/cache");
    await expect(portInput).toHaveValue(String(editedPort));
    await page.clock.runFor(650);
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1]).toEqual({ port: editedPort });
    await expect(page.getByRole("button", { name: "重试保存" })).toHaveCount(0);
  } finally {
    closing = true;
    release();
    await page.close();
    await Promise.allSettled(tasks);
  }
});

test("配置保存等待 LAN 会话建立后再发送后续写入", async ({ page }) => {
  const config = (await (
    await page.request.get("/api/config")
  ).json()) as Record<string, unknown>;
  let current = { ...config };
  const writes: Record<string, unknown>[] = [];
  const readyAtWrite: boolean[] = [];
  let releaseLogin = () => {};
  const login = new Promise<void>((resolve) => {
    releaseLogin = resolve;
  });
  let ready = false;
  let loginStarted = false;
  let closing = false;
  await page.route("**/api/config", (route) => {
    if (route.request().method() !== "PUT")
      return route.fulfill({ json: current });
    const patch = route.request().postDataJSON() as Record<string, unknown>;
    writes.push(patch);
    readyAtWrite.push(ready);
    current = { ...current, ...patch, accessTokenConfigured: true };
    delete current.accessToken;
    return route
      .fulfill({
        json: {
          ok: true,
          config: current,
          requiresRestart: [],
          mediaRootsChanged: false,
        },
      })
      .catch(() => {});
  });
  await page.route("**/api/auth/session", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    loginStarted = true;
    await login;
    ready = true;
    if (closing) return route.abort().catch(() => {});
    return route
      .fulfill({ json: { authenticated: true, mode: "lan" } })
      .catch(() => {});
  });
  try {
    await page.clock.install();
    await page.goto("/settings");
    await page
      .getByLabel("LAN 访问令牌")
      .fill("0123456789abcdef0123456789abcdef");
    await page
      .getByRole("button", { name: "开启 LAN 访问", exact: true })
      .click();
    await expect.poll(() => loginStarted).toBe(true);
    const original = String(config.cacheDir);
    const placeholder = await page
      .locator(`input[value=${JSON.stringify(original)}]`)
      .getAttribute("placeholder");
    const input = page.getByPlaceholder(placeholder!, { exact: true });
    await input.fill(original + "_queued");
    await input.press("Tab");
    await page.clock.runFor(300);
    await expect(input).toHaveValue(original + "_queued");
    expect(writes).toHaveLength(1);
    releaseLogin();
    await expect.poll(() => writes.length).toBe(2);
    expect(readyAtWrite[1]).toBe(true);
    expect(writes[1]).toEqual({ cacheDir: original + "_queued" });
  } finally {
    closing = true;
    releaseLogin();
    await page.close();
  }
});

test("阅读器按 G 跳页时预填值被选中，输入页码直接替换而不是追加", async ({
  page,
}) => {
  const nodes = await scannedNodes(page.request);
  const album = nodes.find((node) => node.name === "sample-paged-images");
  expect(album).toBeDefined();
  await page.goto(`/gallery?path=${encodeURIComponent(album!.id)}&index=0`);
  // 等阅读器挂载（路由是懒加载的），否则按键会落在挂载之前
  await expect(page.getByTitle("跳转到指定页 (G)")).toHaveText("1");

  // 进入跳页编辑态：预填当前页并全选
  await page.keyboard.press("g");
  const input = page.getByRole("textbox");
  await expect(input).toHaveValue("1");
  // 直接敲数字应替换预填值；若光标停在末尾，"100" 会变成 "1100"
  // 并被夹到最后一页。
  await page.keyboard.type("100");
  await expect(input).toHaveValue("100");
  await page.keyboard.press("Enter");

  await expect(page.getByTitle("跳转到指定页 (G)")).toHaveText("100");
});

test("阅读器放大与旋转真正作用到图片上", async ({ page }) => {
  const nodes = await scannedNodes(page.request);
  const album = nodes.find((node) => node.name === "sample-paged-images");
  expect(album).toBeDefined();
  await page.goto(`/gallery?path=${encodeURIComponent(album!.id)}&index=0`);
  await expect(page.getByTitle("跳转到指定页 (G)")).toHaveText("1");

  const img = page.locator("[data-image-gallery] img").first();
  const matrix = async () =>
    img.evaluate((element) => {
      const value = getComputedStyle(element).transform;
      return (value.match(/-?[\d.]+/g) ?? []).map(Number);
    });

  // 初始为原图
  expect((await matrix())[0]).toBeCloseTo(1, 1);
  // 放大：矩阵的缩放分量必须真的变大（而不是只有右侧面板的数字变了）
  await page.keyboard.press("+");
  await expect.poll(async () => (await matrix())[0]).toBeGreaterThan(1.1);
  // 旋转 90°：矩阵出现旋转分量
  await page.keyboard.press("r");
  await expect.poll(async () => Math.abs((await matrix())[1])).toBeGreaterThan(
    0.5,
  );
});

test("阅读器「原始」适配模式按像素显示图片，超出视口时可滚动查看", async ({
  page,
  request,
}) => {
  const config = (await (await request.get("/api/config")).json()) as {
    mediaRoots: string[];
  };
  const root = config.mediaRoots[0];
  expect(root).toBeTruthy();
  const dir = path.join(root, "sample-original-size");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "big.png"), solidPng(1400, 1000));

  const nodes = await scannedNodes(request);
  const album = nodes.find((node) => node.name === "sample-original-size");
  expect(album).toBeDefined();
  await page.goto(`/gallery?path=${encodeURIComponent(album!.id)}&index=0`);
  await expect(page.getByTitle("跳转到指定页 (G)")).toHaveText("1");

  const img = page.locator("[data-image-gallery] img").first();
  // 切到「原始」适配模式：适应 → 按宽 → 按高 → 原始
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("f");
    await page.waitForTimeout(150);
  }
  const size = await img.evaluate((element) => ({
    natural: element.naturalWidth,
    rendered: Math.round(element.getBoundingClientRect().width),
  }));
  // 视口宽 1280，图片宽 1400：按像素显示时不能被夹到视口宽度
  expect(size.natural).toBe(1400);
  expect(size.rendered).toBe(1400);
  // 超出视口的部分可以滚动到
  const scrolled = await page.evaluate(() => {
    const container = document.querySelector("[data-image-gallery]")!;
    container.scrollLeft = 9999;
    return { scrollLeft: container.scrollLeft, scrollWidth: container.scrollWidth };
  });
  expect(scrolled.scrollWidth).toBeGreaterThan(scrolled.scrollLeft);
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
    page.getByRole("heading", { name: "该年份的图像" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("窄屏下顶栏不横向溢出，筛选标签保持一行", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("combobox", { name: "搜索文件夹或标签" }),
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
      /^(全部|文件夹|集合|标签)\s*\d*$/.test((button.textContent ?? "").trim()),
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
  const link = page.getByRole("link", { name: /^打开相册/ }).first();
  const href = await link.getAttribute("href");
  expect(href).toBeTruthy();
  const albumId = decodeURIComponent(href!.replace("/albums/", ""));
  await link.hover();

  const star = page.getByRole("button", { name: /^收藏「/ }).first();
  await expect(star).toBeVisible();
  await star.click();

  // 星标在链接之外：点击不能带着进入相册。
  await expect(page).toHaveURL(/\/$/);
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
  await expect(
    page.getByRole("button", { name: /^取消收藏「/ }).first(),
  ).toBeVisible();

  // 复原：取消收藏，避免影响后续用例。
  await page
    .getByRole("button", { name: /^取消收藏「/ })
    .first()
    .click();
  await expect
    .poll(async () => {
      const favorites = (await (
        await request.get("/api/favorites")
      ).json()) as { favorites: string[] };
      return favorites.favorites.includes(albumId);
    })
    .toBe(false);
});

test("窄屏阅读器不再显示悬浮控件，显示设置收进顶栏弹层", async ({
  page,
  request,
}) => {
  const nodes = await scannedNodes(request);
  const album = nodes.find((node) => (node.imageCount ?? 0) >= 2)!;
  expect(album).toBeDefined();
  const total = album.imageCount!;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/gallery?path=${album.id}&index=0`);
  await expect(page.getByText(new RegExp(`^1 / ${total}$`))).toBeVisible();

  // 右侧悬浮控件在窄屏会盖住图片右缘，这里应当已经隐藏。
  await expect(
    page.getByRole("button", { name: "适应 (F 循环)" }),
  ).toBeHidden();

  // 显示设置改由顶栏弹层提供。
  const menuButton = page.getByRole("button", { name: "阅读设置" });
  await expect(menuButton).toBeVisible();
  await menuButton.click();
  await page.getByRole("menuitem", { name: /并排/ }).click();
  await expect(page.getByText("1–2 /")).toBeVisible();

  // 悬浮控件让开后，图片右三分之一可以正常翻到下一张。
  await page.getByRole("button", { name: "阅读设置" }).click();
  await page.getByRole("menuitem", { name: /单张/ }).click();
  await expect(page.getByText(new RegExp(`^1 / ${total}$`))).toBeVisible();
  await page.mouse.click(360, 400);
  await expect(page.getByText(new RegExp(`^2 / ${total}$`))).toBeVisible();
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
  await page.goto(`/albums/${album.id}`);
  await expect(
    page.getByRole("button", { name: "打开第 1 张", exact: true }),
  ).toBeVisible();

  // 素材里的 photo.heic 浏览器解不了；服务端无法转换时返回 415，
  // 阅读器应显示提示，而不是浏览器的破图图标。
  await page.getByRole("button", { name: "打开第 1 张", exact: true }).click();
  await expect(page.getByText("该图片无法显示")).toBeVisible();
});
