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
    page: { items: Array<{ id: string; name: string; imageCount?: number }> };
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
