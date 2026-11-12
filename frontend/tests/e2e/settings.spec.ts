import { expect, test, type Locator } from "@playwright/test";
import { existsSync } from "node:fs";
import type { DirectoryPage } from "../../src/api/fs";
import {
  renderedColors,
  type ManifestResponse,
  type MediaRootConfig,
  scannedNodes,
  readerUrl,
  resetWorkbenchMode,
  systemOpenRoute,
  systemOpenRequest,
} from "./helpers/library";

test.beforeEach(async ({ request }) => {
  await resetWorkbenchMode(request);
});

test("扫描并打开示例相册", async ({ page }) => {
  // 服务可带离线根启动；其他文件可能已经修复，按当前真实目录准备夹具。
  const configResponse = await page.request.get("/api/config");
  expect(configResponse.ok()).toBeTruthy();
  const config = (await configResponse.json()) as {
    mediaRoots: MediaRootConfig[];
  };
  const live = config.mediaRoots.filter((root) => existsSync(root.path));
  expect(live).toHaveLength(2);
  const repaired = await page.request.put("/api/config", {
    data: { mediaRoots: live },
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
  const manifest = (await manifestResponse.json()) as ManifestResponse;
  const photoRoot = manifest.manifest.roots.find(
    (root) => root.contentKind === "photo",
  );
  expect(photoRoot).toBeTruthy();
  const rootID = photoRoot?.id;
  expect(rootID).toBeTruthy();

  const response = await page.request.get(
    `/api/library/${encodeURIComponent(rootID ?? "")}/children?limit=1&kind=photo`,
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

  // 阅读进度只属于漫画工作台：这一段用漫画根下的多页漫画。
  const comicRoot = manifest.manifest.roots.find(
    (root) => root.contentKind === "comic",
  );
  expect(comicRoot).toBeTruthy();
  const comicResponse = await page.request.get(
    `/api/library/${encodeURIComponent(comicRoot!.id)}/children?limit=200&kind=comic`,
  );
  expect(comicResponse.ok()).toBeTruthy();
  const comicBody = (await comicResponse.json()) as {
    page: { items: Array<{ id: string; name: string }> };
  };
  const comicAlbum = comicBody.page.items.find(
    (item) => item.name === "sample-comic",
  );
  expect(comicAlbum).toBeDefined();

  const albumId = comicAlbum!.id;
  await page.route("**/api/activity", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({ status: 400, json: { error: "模拟保存失败" } });
    } else {
      await route.continue();
    }
  });
  await page.goto(readerUrl(albumId, "?index=1"));
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
  await page.goto(readerUrl(albumId));
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
      // 底部状态栏已移除：扫描中断这件事现在只有左下角那张浮动卡一个
      // 出口，卡片本身必须把「中断」和「结果待确认」说清楚。
      await expect(card).toContainText("尚未确认");
      await expect(scan).toBeDisabled();
      await page.keyboard.press("Control+s");
      await page.clock.runFor(100);
      expect(starts).toBe(1);
      if (recovery === "manual") {
        await page.clock.runFor(6000);
        await expect(card).toBeVisible();
        // 「未读」只属于漫画工作台：先在侧栏切过去再点这个入口。
        // 不能刷新页面——刷新会丢掉扫描进度的本地状态，这条用例守的正是它。
        await page
          .getByRole("group", { name: "工作台模式" })
          .getByRole("button", { name: "漫画" })
          .click();
        await page
          .locator('aside[aria-label="主导航"]')
          .getByRole("link", { name: /^未读/ })
          .click();
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
    page.getByText("媒体根目录", { exact: false }).first(),
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

// 存储信息搬到任务中心之后，设置页不再摆这些。
test("设置页不再展示模型路径与派生缓存占用", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByText("媒体库索引")).toBeVisible();
  await expect(page.getByText("本机 AI 与存储")).toHaveCount(0);
  await expect(page.getByText("模型与缓存路径")).toHaveCount(0);
  await expect(page.getByText("缓存占用")).toHaveCount(0);
  await expect(page.getByText("一键全清")).toHaveCount(0);
});

// 分区条（页面级）与侧栏条目（应用级）说的是同一份分区清单：
// 点分区条跳过去，左侧「设置」条目下就标出当前分区。
test("设置页的分区条与侧栏条目联动", async ({ page }) => {
  await page.goto("/settings");
  const nav = page.getByRole("navigation", { name: "页面分区" });
  await expect(nav.getByRole("button", { name: "数据" })).toBeVisible();

  await nav.getByRole("button", { name: "数据" }).click();
  const sidebar = page.locator('aside[aria-label="主导航"]');
  await expect(sidebar.getByText("数据")).toBeVisible();
  // 分区条吸顶，不被内容顶走。
  await expect(nav).toBeInViewport();
});

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
    const [danger] = await renderedColors(page.locator("html"), ["--danger"]);
    for (const channel of [0, 1, 2]) {
      expect(Math.abs(border[channel] - danger[channel])).toBeLessThanOrEqual(
        2,
      );
      // 5% 透明度经 canvas 预乘后会出现最多约 10 个色阶的量化误差。
      expect(
        Math.abs(background[channel] - danger[channel]),
      ).toBeLessThanOrEqual(10);
    }
    await page.screenshot({
      path: test.info().outputPath(`settings-error-${theme}.png`),
    });
  }
  blocked = false;
  await alert.getByRole("button", { name: "重试加载", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "阅读到末尾自动切换下一卷" }),
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
          ? page.getByRole("switch", { name: "阅读到末尾自动切换下一卷" })
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

for (const health of ["late", "error"] as const) {
  test(`系统打开设置保存不依赖 ${health} 健康响应，配置目录使用白名单入口`, async ({
    page,
  }) => {
    const nodes = await scannedNodes(page.request);
    const album = nodes.find((node) => node.name === "sample-album")!;
    const original = (await (await page.request.get("/api/config")).json()) as {
      allowOsOpen: boolean;
      mediaRoots: MediaRootConfig[];
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
        `input[value=${JSON.stringify(original.mediaRoots[0].path)}]`,
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
          path: original.mediaRoots[0].path,
          allowConfig: "1",
        }),
      );
      await page.getByRole("link", { name: "照片库", exact: true }).click();
      await page.getByRole("combobox").fill(album.name);
      const card = page.locator(
        `main [data-virtuoso-scroller] a[href="/photo/albums/${album.id}"]`,
      );
      await card.click({ button: "right" });
      await expect(
        page.getByRole("menuitem", { name: "在文件管理器中打开", exact: true }),
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

test("设置目录选择使用真实路径，取消不保存且焦点留在弹窗内", async ({
  page,
}) => {
  const config = (await (await page.request.get("/api/config")).json()) as {
    mediaRoots: MediaRootConfig[];
    cacheDir: string;
  };
  const response = await page.request.post("/api/admin/fs/directories", {
    data: { directory: config.mediaRoots[0].path },
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
  await expect(rootInput).toHaveValue(config.mediaRoots[0].path);
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
    .toEqual([
      {
        mediaRoots: [
          { path: selected, kind: config.mediaRoots[0].kind },
          ...config.mediaRoots.slice(1),
        ],
      },
    ]);
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
          config: {
            ...config,
            mediaRoots: [{ path: selected, kind: "photo" }],
          },
          requiresRestart: [],
          mediaRootsChanged: false,
        },
      });
    }
    return route.fulfill({
      json: { ...config, mediaRoots: [{ path: original, kind: "photo" }] },
    });
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
  await expect
    .poll(() => writes)
    .toEqual([{ mediaRoots: [{ path: selected, kind: "photo" }] }]);
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
    mediaRoots: MediaRootConfig[];
    cacheDir: string;
  };
  const roots = [config.mediaRoots[0].path, config.cacheDir];
  let current = {
    ...config,
    mediaRoots: roots.map((rootPath) => ({ path: rootPath, kind: "photo" })),
  };
  const writes: { mediaRoots: MediaRootConfig[] }[] = [];
  await page.route("**/api/config", async (route) => {
    if (route.request().method() === "PUT") {
      const patch = route.request().postDataJSON() as {
        mediaRoots: MediaRootConfig[];
      };
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
  await expect(inputs.first()).toBeVisible();
  await page.clock.pauseAt(new Date("2030-01-01T00:00:00.000Z"));
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
  await expect
    .poll(() => writes)
    .toEqual([
      {
        mediaRoots: [
          { path: saved, kind: "photo" },
          { path: roots[1], kind: "photo" },
        ],
      },
    ]);
  await expect(inputs.nth(0)).toHaveValue(saved);
  await inputs.nth(0).fill(roots[0] + "_cancelled_again");
  await inputs.nth(0).press("Escape");
  await expect(inputs.nth(0)).toHaveValue(saved);
  await page.clock.runFor(700);
  expect(writes).toHaveLength(1);
});

test("设置自动保存等待组合输入确认，其他字段仍可保存", async ({ page }) => {
  const config = (await (await page.request.get("/api/config")).json()) as {
    mediaRoots: MediaRootConfig[];
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
      {
        mediaRoots: [
          { path: "/photos/确认目录", kind: "photo" },
          ...config.mediaRoots.slice(1),
        ],
      },
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
      mediaRoots: [(config.mediaRoots as MediaRootConfig[])[0]],
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
      await page.getByRole("link", { name: "照片库", exact: true }).click();
      await page.getByRole("link", { name: "设置", exact: true }).click();
      await expect(input).toHaveValue("/queue/latest");
      release[0]();
      await expect.poll(() => writes.length).toBe(2);
      await expect(input).toHaveValue("/queue/latest");
      const last = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          response.request().postDataJSON().mediaRoots?.[0]?.path ===
            "/queue/latest",
      );
      release[1]();
      expect((await last).ok()).toBe(true);
      await page.clock.runFor(5);
      await expect(input).toHaveValue("/queue/latest");
      await expect(page.getByLabel("保存中", { exact: true })).toHaveCount(0);
      await expect(page.getByLabel("保存失败", { exact: true })).toHaveCount(0);
      expect(writes).toEqual([
        { mediaRoots: [{ path: "/queue/first", kind: "photo" }] },
        { mediaRoots: [{ path: "/queue/latest", kind: "photo" }] },
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
  let current = {
    ...config,
    mediaRoots: [(config.mediaRoots as MediaRootConfig[])[0]],
  };
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
    await page.getByRole("link", { name: "照片库", exact: true }).click();
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
      { mediaRoots: [{ path: "/retry/photos", kind: "photo" }] },
      { mediaRoots: [{ path: "/retry/photos", kind: "photo" }] },
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
    // 由 runFor 精确推进自动保存时间，避免重排后的滚动消耗 debounce 窗口。
    await page.clock.pauseAt(new Date(Date.now() + 1_000));
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
