import { expect, test } from "@playwright/test";
import {
  scannedNodes,
  albumUrl,
  albumUrlPattern,
  resetWorkbenchMode,
  type CopyAuditWindow,
  installCopyAudit,
} from "./helpers/library";

test.beforeEach(async ({ request }) => {
  await resetWorkbenchMode(request);
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
  await page.goto("/photo/recents");
  await expect(page.getByText("还没有最近浏览", { exact: true })).toBeVisible();
  const search = page.getByRole("combobox");
  await search.fill("sample-paged-images");
  await expect(page.getByRole("option").first()).toBeVisible();
  await search.press("Enter");
  await expect(page).toHaveURL(albumUrlPattern(album!));
  const scroller = page.locator("[data-virtuoso-scroller]");
  await expect(scroller.getByRole("button").first()).toBeVisible();
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    scroller.getByRole("button", { name: "查看 page-405.png", exact: true }),
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
  // 照片工作台的入口叫「最近浏览」。
  await page.getByRole("link", { name: "最近浏览", exact: true }).click();
  await expect(
    page.locator(`a[href="/photo/albums/${album!.id}"]`).first(),
  ).toBeVisible();
  expect(historyWrites).toBe(1);
});

for (const failure of ["history", "nodes"] as const) {
  test(`最近浏览 ${failure} 读取失败不显示为空且可重试`, async ({ page }) => {
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
    await page.goto("/photo/recents");
    const alert = page.getByRole("alert");
    await expect(alert).toContainText(
      failure === "history" ? "最近浏览加载失败" : "相册信息加载失败",
      { timeout: 15_000 },
    );
    await expect(page.getByText("还没有最近浏览", { exact: true })).toHaveCount(
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
      page.locator(`a[href="/photo/albums/${album!.id}"]`).first(),
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
      const tags = (await (
        await page.request.get("/api/tags?kind=photo")
      ).json()) as {
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
      // 标签收藏走「按名解析」接口：它一次给出两侧的册数，客户端才能区分
      // 「标签失效了」与「它只属于另一侧」。拦截要落在实际调用的这条路径上。
      const pathname = {
        favorites: "/api/favorites",
        nodes: "/api/library/nodes/query",
        tags: "/api/tags/query",
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
      await page.goto("/photo/favorites");
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
          ? `/photo/tags/${encodeURIComponent("测试")}`
          : albumUrl(album!);
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
    await page.goto(albumUrl(album!));
    await expect(
      page.getByRole("button", { name: "取消收藏", exact: true }),
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
    await page.getByRole("button", { name: "取消收藏", exact: true }).click();
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
      page.getByRole("button", { name: "取消收藏", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("已加入收藏", { exact: true })).toBeVisible();
    const added = (await (await page.request.get("/api/favorites")).json()) as {
      favorites: string[];
    };
    expect(added.favorites).toContain(resourceId);
    await page.getByRole("link", { name: "收藏照片", exact: true }).click();
    await expect(
      page.locator(`a[href="${albumUrl(album!)}"]`).first(),
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
      await page.goto("/photo/recents");
      await expect(
        page.locator(`main a[href="/photo/albums/${first.id}"]`).first(),
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
        await expect(page).toHaveURL(new RegExp(`/photo/albums/${second.id}$`));
      } else {
        await expect(
          page.locator(`main a[href="/photo/albums/${second.id}"]`).first(),
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
      await page.getByRole("link", { name: "最近浏览", exact: true }).click();
      await expect
        .poll(() => failedReads, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(8);
      await expect(page.getByRole("alert")).toContainText("最近浏览加载失败");
      const firstCard = page
        .locator(`main a[href="/photo/albums/${first.id}"]`)
        .first();
      const secondCard = page
        .locator(`main a[href="/photo/albums/${second.id}"]`)
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
    await page.goto("/photo/favorites");
    await expect(
      page.locator(`main a[href="/photo/albums/${album.id}"]`).first(),
    ).toBeVisible();
    // 计数在筛选条上：页头不再重复报条数（同一页两处各写一遍同一个数，
    // 读起来像两处不同的统计），筛选条上那行「共 N 项」说的就是它。
    const count = page.getByTestId("filter-bar-count");
    // 计数是「这一侧能看到的项数」：失效的那一条渲染不出来，
    // 另起一行说明，不混进计数里。
    await expect(count).toHaveText(`共 ${seededCount - 1} 项`);
    await expect(page.getByText("其中 1 项暂时找不到")).toBeVisible();
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
    await page.getByRole("link", { name: "收藏照片", exact: true }).click();
    await expect
      .poll(() => failedReads, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(8);
    await expect(count).toHaveText(`共 ${confirmed.length} 项`);
    await expect(
      page.locator(`main a[href="/photo/albums/${album.id}"]`).first(),
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
    await page.goto("/photo/favorites");
    const tagPath = `/photo/tags/${encodeURIComponent(tag)}`;
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
      page
        .locator('main [data-virtuoso-scroller] a[href^="/photo/albums/"]')
        .first(),
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
