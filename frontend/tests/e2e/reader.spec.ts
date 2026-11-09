import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  solidPng,
  type MediaRootConfig,
  scannedNodes,
  albumUrl,
  albumUrlPattern,
  readerUrl,
  resetWorkbenchMode,
} from "./helpers/library";

test.beforeEach(async ({ request }) => {
  await resetWorkbenchMode(request);
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
    await page.goto(readerUrl(album!.id, `?type=video${hint}`));
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
      await page.goto(albumUrl(album));
      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        album.name,
      );
      await page.goto(readerUrl(album.id, `?type=${kind}&index=0`));
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
      await expect(page).toHaveURL(albumUrlPattern(album));
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
    await page.goto(albumUrl(album));
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      album.name,
    );
    await page.goto(readerUrl(album.id, `?type=${kind}&index=0`));
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
    await expect(page).toHaveURL(albumUrlPattern(album));
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
  await page.goto(readerUrl(album.id, `?type=video&index=0`));
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
    await page.goto(albumUrl(album));
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      album.name,
    );
    await page.goto(readerUrl(album.id, `?type=video&index=1`));
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
    await expect(page).toHaveURL(albumUrlPattern(album));
  });
}

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
    await page.goto(albumUrl(album));
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      album.name,
    );
    await page.goto(readerUrl(album.id, `?type=${kind}&index=0`));
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
      await expect(dialog.getByText("下一页", { exact: true })).toBeVisible();
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
    // 第一次 Esc 只关帮助，地址仍停在阅读器上。
    await expect(page).toHaveURL(new RegExp(`/comic/read/${album.id}`));
    await expect(opener).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(albumUrlPattern(album));
  });
}

test("阅读器按 G 跳转时预填值被选中，输入张数直接替换而不是追加", async ({
  page,
}) => {
  const nodes = await scannedNodes(page.request);
  const album = nodes.find((node) => node.name === "sample-paged-images");
  expect(album).toBeDefined();
  await page.goto(readerUrl(album!.id, `?index=0`));
  // 等阅读器挂载（路由是懒加载的），否则按键会落在挂载之前
  await expect(page.getByTitle("跳转到指定页 (G)")).toHaveText("1");

  // 进入跳转编辑态：预填当前张数并全选
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

test("阅读器加载态沿用深色画布，不闪白底", async ({ page }) => {
  const nodes = await scannedNodes(page.request);
  const album = nodes.find((node) => node.name === "sample-paged-images");
  expect(album).toBeDefined();
  // 固定成浅色主题：只有浅色主题下"加载态跟着主题变"才会露出白底。
  // 这里刻意写旧版本的存储（带已废弃的 accent 键），顺带覆盖偏好迁移。
  await page.addInitScript(() => {
    localStorage.setItem(
      "local-gallery-ui",
      JSON.stringify({ state: { theme: "light", accent: "blue" }, version: 0 }),
    );
  });
  // 拖慢媒体接口，让加载态停留足够长以便断言。
  await page.route("**/api/albums/*/media*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await route.continue();
  });

  await page.goto(readerUrl(album!.id, `?index=0`));
  const loading = page.getByText("正在加载图片…");
  await expect(loading).toBeVisible();

  // 阅读器画布恒为深色：加载态的背景不能跟随应用主题（浅色主题下会先闪一屏白底）。
  const bg = await loading.evaluate((el) => {
    let node: HTMLElement | null = el;
    while (node) {
      const color = getComputedStyle(node).backgroundColor;
      if (color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
        return color;
      }
      node = node.parentElement;
    }
    return "none";
  });
  const [r, g, b] = (bg.match(/\d+/g) ?? ["0"]).map(Number);
  expect(r).toBeLessThan(60);
  expect(g).toBeLessThan(60);
  expect(b).toBeLessThan(60);

  // 旧版本存储里的 accent 偏好已作废：迁移后主题照常生效，存储里不再留这个键。
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("local-gallery-ui") ?? "{}"),
  );
  expect(stored.state?.theme).toBe("light");
  expect(stored.state).not.toHaveProperty("accent");
});

test("阅读器放大与旋转真正作用到图片上", async ({ page }) => {
  const nodes = await scannedNodes(page.request);
  const album = nodes.find((node) => node.name === "sample-paged-images");
  expect(album).toBeDefined();
  await page.goto(readerUrl(album!.id, `?index=0`));
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
  await expect
    .poll(async () => Math.abs((await matrix())[1]))
    .toBeGreaterThan(0.5);
});

test("图片信息面板不遮挡阅读器顶栏：宽屏并排，窄屏落到顶栏下方", async ({
  page,
}) => {
  const nodes = await scannedNodes(page.request);
  const album = nodes.find((node) => node.name === "sample-paged-images");
  expect(album).toBeDefined();
  await page.goto(readerUrl(album!.id, `?index=0`));
  await expect(page.getByTitle("跳转到指定页 (G)")).toHaveText("1");

  const panel = page.getByTestId("image-info-panel");
  const header = page.locator("header").first();

  await page.keyboard.press("i");
  await expect(panel).toBeVisible();

  // 宽屏：面板是右侧独立一栏，左边缘不越过顶栏右边缘。
  const widePanel = await panel.boundingBox();
  const wideHeader = await header.boundingBox();
  expect(widePanel).not.toBeNull();
  expect(wideHeader).not.toBeNull();
  expect(widePanel!.x).toBeGreaterThanOrEqual(
    wideHeader!.x + wideHeader!.width,
  );
  expect(widePanel!.y).toBe(0);
  expect(widePanel!.height).toBeGreaterThan(400);

  // 窄屏：没有并排空间，面板落到顶栏下方，不覆盖返回按钮与相册名。
  await page.setViewportSize({ width: 390, height: 780 });
  await expect(panel).toBeVisible();
  const narrowPanel = await panel.boundingBox();
  const narrowHeader = await header.boundingBox();
  expect(narrowPanel).not.toBeNull();
  expect(narrowHeader).not.toBeNull();
  expect(narrowPanel!.y).toBeGreaterThanOrEqual(
    narrowHeader!.y + narrowHeader!.height,
  );
});

test("阅读器「原始」适配模式按像素显示图片，超出视口时可滚动查看", async ({
  page,
  request,
}) => {
  const config = (await (await request.get("/api/config")).json()) as {
    mediaRoots: MediaRootConfig[];
  };
  const root = config.mediaRoots[0].path;
  expect(root).toBeTruthy();
  const dir = path.join(root, "sample-original-size");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "big.png"), solidPng(1400, 1000));

  const nodes = await scannedNodes(request);
  const album = nodes.find((node) => node.name === "sample-original-size");
  expect(album).toBeDefined();
  await page.goto(readerUrl(album!.id, `?index=0`));
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
    return {
      scrollLeft: container.scrollLeft,
      scrollWidth: container.scrollWidth,
    };
  });
  expect(scrolled.scrollWidth).toBeGreaterThan(scrolled.scrollLeft);
});

test("窄屏阅读器不再显示右侧悬浮控件，阅读设置收进底部工具条", async ({
  page,
  request,
}) => {
  // 阅读器属于漫画工作台：素材取漫画根下的多页漫画。
  const nodes = await scannedNodes(request, "comic");
  const album = nodes.find((node) => node.name === "sample-comic")!;
  expect(album).toBeDefined();
  const total = album.imageCount!;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(readerUrl(album.id, `?index=0`));
  await expect(page.getByText(new RegExp(`^1 / ${total}$`))).toBeVisible();

  // 右侧竖排浮层已经整体取消：它会盖住图片右缘。
  await expect(page.getByRole("button", { name: "适应 (F 循环)" })).toHaveCount(
    0,
  );

  // 阅读设置改由底部浮动工具条提供（窄屏也直接可点，不需要再开菜单）。
  const toolbar = page.getByRole("toolbar", { name: "阅读控制" });
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole("button", { name: "双页" }).click();
  await expect(page.getByText("1–2 /")).toBeVisible();

  // 工具条让开后，图片右三分之一可以正常翻到下一张。
  await toolbar.getByRole("button", { name: "单页" }).click();
  await expect(page.getByText(new RegExp(`^1 / ${total}$`))).toBeVisible();
  await page.mouse.click(360, 300);
  await expect(page.getByText(new RegExp(`^2 / ${total}$`))).toBeVisible();
});

test("阅读器连续模式按视口宽度请求预览图，不发原图", async ({ page }) => {
  const nodes = await scannedNodes(page.request);
  const album = nodes.find((node) => node.name === "sample-paged-images");
  expect(album).toBeDefined();
  await page.goto(readerUrl(album!.id, `?index=0`));

  // 单张模式仍走原图（缩放 / 原始尺寸需要完整分辨率）。
  await expect(
    page.locator("[data-image-gallery] img").first(),
  ).toHaveAttribute("src", /\/api\/media\//);

  // 连续模式按视口宽度展示，必须换成服务端预览图：
  // 原图动辄 5MB+，翻一本相册就是 GB 级流量。
  await page.keyboard.press("2");
  await expect(
    page.locator("[data-image-gallery] img").first(),
  ).toHaveAttribute("src", /\/api\/previews\/.*\?w=\d+/);
});

// ==== UI 重设计新增的界面契约 ====
//
// 这次重设计把阅读器的核心操作（阅读模式 / 适配方式）从"…"菜单提到顶栏常驻，
// 并给首页重排了信息架构。下面几条用例把这些新契约固定下来，避免后续
// 迭代时把可发现性改回去。

test("阅读器底部工具条常驻阅读模式与适配方式，切换后写入本地偏好", async ({
  page,
}) => {
  const nodes = await scannedNodes(page.request);
  const album = nodes.find((node) => node.name === "sample-album")!;
  expect(album).toBeDefined();
  await page.goto(readerUrl(album.id, `?type=image`));
  const toolbar = page.getByRole("toolbar", { name: "阅读控制" });
  await expect(toolbar).toBeVisible();
  const group = toolbar.getByRole("group", { name: "阅读模式" });

  // 阅读模式：分段控件直接可点，不必先打开任何菜单。
  await group.getByRole("button", { name: "连续", exact: true }).click();
  await expect(
    group.getByRole("button", { name: "连续", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("local-gallery") ?? "{}").state
            ?.mode ?? null,
      ),
    )
    .toBe("continuous");

  // 适配方式：一个按钮循环 适应 → 按宽 → 按高 → 原始。
  const fit = toolbar.getByRole("button", { name: /^适配方式：/ });
  await expect(fit).toHaveAttribute("aria-label", "适配方式：适应");
  await fit.click();
  await expect(fit).toHaveAttribute("aria-label", "适配方式：按宽");

  // 键盘路径依旧可用：1 / 2 / 3 切模式。
  await page.keyboard.press("1");
  await expect(
    group.getByRole("button", { name: "单页", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

for (const width of [1920, 1440, 1024, 768, 390]) {
  test(`${width}px 下首页、相册与阅读器均无横向溢出`, async ({ page }) => {
    const nodes = await scannedNodes(page.request);
    const album = nodes.find((node) => node.name === "sample-album")!;
    expect(album).toBeDefined();
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const path of [
      "/photo",
      "/comic/unread",
      `/photo/albums/${album.id}`,
    ]) {
      await page.goto(path);
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => {
        const root = document.documentElement;
        const main = document.querySelector("main");
        return {
          doc: root.scrollWidth - root.clientWidth,
          main: main ? main.scrollWidth - main.clientWidth : 0,
        };
      });
      expect(overflow.doc, `${path} 文档横向溢出`).toBeLessThanOrEqual(1);
      expect(overflow.main, `${path} 主内容横向溢出`).toBeLessThanOrEqual(1);
    }
    // 阅读器是独立路由（不套 AppShell），单独检查。
    await page.goto(readerUrl(album.id, `?type=image`));
    await page.waitForTimeout(600);
    const galleryOverflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(galleryOverflow).toBeLessThanOrEqual(1);
  });
}

test("阅读器全屏按钮可点击，点击后阅读器控制仍然可用", async ({ page }) => {
  // 阅读器属于漫画工作台：素材取漫画根下的多页漫画。
  const nodes = await scannedNodes(page.request, "comic");
  const album = nodes.find((node) => node.name === "sample-comic")!;
  expect(album).toBeDefined();
  // 阅读器会恢复到上次读到的位置：先清掉记录，保证从第一页开始。
  expect(
    (
      await page.request.delete(
        `/api/activity?albumId=${encodeURIComponent(album.id)}&mediaKind=image`,
      )
    ).ok(),
  ).toBeTruthy();
  await page.goto(readerUrl(album.id, `?type=image`));
  await page.waitForTimeout(800);

  const fullscreen = page.getByRole("button", { name: "全屏 (F11)" });
  await expect(fullscreen).toBeVisible();
  await fullscreen.click();
  // 无头浏览器里 Fullscreen API 不一定生效，这里只锁定"点击不报错、
  // 阅读器状态不被破坏"。
  await page.waitForTimeout(400);
  await expect(page.getByRole("toolbar", { name: "阅读控制" })).toBeVisible();
  await expect(page.getByRole("button", { name: "下一页" })).toBeEnabled();
});

test("迟到的图片进度不会覆盖随后标记的已读或重置未读", async ({
  page,
  request,
}) => {
  const nodes = await scannedNodes(request, "comic");
  const album = nodes.find((node) => node.name === "sample-comic")!;
  expect(album.imageCount).toBeGreaterThan(2);
  const activityPath = `/api/activity?albumId=${album.id}&mediaKind=image`;
  const originalResponse = await request.get(activityPath);
  const original: unknown = originalResponse.ok()
    ? await originalResponse.json()
    : null;
  await request.delete(activityPath);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: number[] = [];
  await page.route("**/api/activity", async (route) => {
    const req = route.request();
    if (req.method() === "PUT") {
      const body = req.postDataJSON() as { albumId: string; pageIndex: number };
      if (body.albumId === album.id) {
        writes.push(body.pageIndex);
        if (writes.length === 1) await gate;
      }
    }
    await route.continue();
  });
  try {
    await page.goto("/comic");
    const card = page.locator(
      `main [data-virtuoso-scroller] a[href="/comic/albums/${album.id}"]`,
    );
    await card.click();
    await expect(page.getByRole("toolbar", { name: "阅读控制" })).toBeVisible();
    await expect.poll(() => writes.length).toBe(1);
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    // 超过去抖窗口，制造一个等待发送的较新进度。
    await page.waitForTimeout(700);
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/comic$/);
    await card.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "标记为已读完", exact: true })
      .click();
    expect(writes).toEqual([0]);
    release();
    await expect
      .poll(async () => {
        const response = await request.get(activityPath);
        return response.ok()
          ? ((await response.json()) as { pageIndex: number }).pageIndex
          : -1;
      })
      .toBe(album.imageCount! - 1);
    expect(writes).toEqual([0, 1, album.imageCount! - 1]);
    await expect(card.getByText("已读完", { exact: true })).toBeVisible();
    mkdirSync(".smoke/roadmap-activity", { recursive: true });
    await page.screenshot({ path: ".smoke/roadmap-activity/confirmed.png" });
    await card.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "取消已读完", exact: true })
      .click();
    await expect
      .poll(async () => (await request.get(activityPath)).status())
      .toBe(404);
  } finally {
    release();
    await page.close();
    if (original)
      expect(
        (await request.put("/api/activity", { data: original })).ok(),
      ).toBeTruthy();
    else await request.delete(activityPath);
  }
});
