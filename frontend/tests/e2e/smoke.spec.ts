import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";

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
