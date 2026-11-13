import { expect, test } from "@playwright/test";
import {
  ensureLibraryReady,
  ensureMetadataReady,
  resetWorkbenchMode,
} from "./helpers/library";

test.beforeEach(async ({ request }) => {
  test.setTimeout(180_000);
  await resetWorkbenchMode(request);
  // 地点页读的是媒体库快照：这条用例要能单独跑，不能等别的用例先把库准备好。
  await ensureLibraryReady(request);
  // 坐标来自元数据分析任务：没有这一趟，临时库里就没有带位置的照片。
  await ensureMetadataReady(request);
});

test("侧栏的足迹入口打开的是新的地点页", async ({ page }) => {
  await page.goto("/photo");

  await page.getByRole("link", { name: "足迹" }).click();
  await expect(page).toHaveURL(/\/photo\/travels$/);
  await expect(page.getByRole("heading", { name: "足迹" })).toBeVisible();
});

test("足迹页按时间排成段流，每段带一条照片带", async ({ page }) => {
  await page.goto("/photo/travels");

  const ledger = page.getByRole("region", { name: /规模/ });
  await expect(ledger).toBeVisible();
  await expect(ledger.getByText("段足迹")).toBeVisible();

  // 杭州 → 上海相隔一天，是同一段行程；北京隔了一年，另起一段。
  const segment = page.getByRole("region", {
    name: "2024-05-02 至 2024-05-03",
  });
  await expect(segment).toBeVisible();
  await expect(segment.getByRole("button", { name: /杭州市/ })).toBeVisible();
  await expect(segment.getByRole("button", { name: /上海市/ })).toBeVisible();

  // 照片带是这一段的门面：五张照片都在带子上。
  await expect(
    segment.getByRole("button", { name: "看这一段的照片" }),
  ).toHaveCount(5);

  await expect(
    page.getByRole("region", { name: "2025-09-10 至 2025-09-10" }),
  ).toBeVisible();
});

test("选中一段，右栏才出现这段的说明", async ({ page }) => {
  await page.goto("/photo/travels");

  // 面板平时不存在：地图是一件按需出现的配图，不常驻版面。
  await expect(page.getByRole("complementary", { name: "上下文" })).toHaveCount(
    0,
  );

  await page
    .getByRole("button", { name: /2024-05-02 至 2024-05-03/ })
    .click();

  const panel = page.getByRole("complementary", { name: "上下文" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "这段行程" })).toBeVisible();
  // 地图画的是这段走过的行政区。
  await expect(panel.getByRole("group", { name: /照片地图/ })).toBeVisible();
  const stops = panel.locator(".travel-context__stops");
  await expect(stops.getByText("杭州市")).toBeVisible();
  await expect(stops.getByText("上海市")).toBeVisible();
});

test("「地方」列出去过的地方", async ({ page }) => {
  await page.goto("/photo/travels");

  await page.getByRole("button", { name: "地方" }).click();

  const panel = page.getByRole("complementary", { name: "上下文" });
  await expect(panel.getByText("去过的地方")).toBeVisible();
  await expect(panel.getByText("杭州市")).toBeVisible();
  await expect(panel.getByText("上海市")).toBeVisible();
  await expect(panel.getByText("北京市")).toBeVisible();
});

test("展开一段，就地把这一段的照片取回来", async ({ page }) => {
  await page.goto("/photo/travels");

  const segment = page.getByRole("region", {
    name: "2024-05-02 至 2024-05-03",
  });
  await segment.getByRole("button", { name: "看这 5 张" }).click();

  await expect(segment.locator(".travel-segment__grid")).toBeVisible();
  // 整段的五张照片都在展开后的照片墙里。
  await expect(segment.locator(".travel-segment__grid img")).toHaveCount(5);
});

test("点地名进这个地方，并且带着筛选条件", async ({ page }) => {
  await page.goto("/photo/travels?level=city");

  await page
    .getByRole("region", { name: "2024-05-02 至 2024-05-03" })
    .getByRole("button", { name: /杭州市/ })
    .click();

  await expect(page).toHaveURL(/\/photo\/travels\/place\/330100/);
  await expect(page).toHaveURL(/level=city/);
});

test("归并粒度可以切换", async ({ page }) => {
  await page.goto("/photo/travels");

  const level = page.getByRole("radiogroup", { name: "归并粒度" });
  await expect(level).toBeVisible();
  await level.getByRole("radio", { name: "市" }).click();
  await expect(page).toHaveURL(/level=city/);
  await level.getByRole("radio", { name: "区县" }).click();
  await expect(page).toHaveURL(/level=district/);
});

test("旧的拍摄地点路由已经不存在", async ({ page }) => {
  await page.goto("/photo/locations");

  // 破坏性改名后不留兼容跳转：旧地址落回照片库。
  await expect(page).toHaveURL(/\/photo$/);
  await expect(page.getByRole("heading", { name: "足迹" })).toHaveCount(0);
});
