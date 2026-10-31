import { expect, test, type APIRequestContext } from "@playwright/test";

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
  ).json()) as ManifestResponse;
  expect((await request.post("/api/scans")).ok()).toBeTruthy();
  await expect
    .poll(async () => {
      const response = await request.get("/api/library/manifest");
      return ((await response.json()) as ManifestResponse).manifest.scannedAt;
    })
    .not.toBe(before.manifest.scannedAt);
  const manifest = (await (
    await request.get("/api/library/manifest")
  ).json()) as ManifestResponse;
  const rootId = manifest.manifest.roots[0].id;
  const response = await request.get(
    `/api/library/${rootId}/children?limit=200`,
  );
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    page: { items: Array<{ id: string; name: string }> };
  };
  return body.page.items;
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
  await page.route(`**/api/media/${fileId}`, async (route) => {
    started++;
    await waiting;
    // 取消后的请求可能已从浏览器路由表移除。
    await route.continue().catch(() => {});
  });
  try {
    await page.goto(`/albums/${album!.id}`);
    await expect.poll(() => probes).toBeGreaterThan(0);
    await page.clock.fastForward(21_000);
    await expect.poll(() => started).toBeGreaterThan(0);
    // 使用 SPA 导航，确保中止来自组件清理，而非整页卸载。
    await page.getByRole("link", { name: "主页", exact: true }).click();
    release();
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(() => cancelled).toBeGreaterThan(0);
    await page.clock.fastForward(60_000);
    expect(uploaded).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    release();
  }
});
