import { expect, test } from "@playwright/test";
import { ensureLibraryReady, resetWorkbenchMode } from "./helpers/library";

test.beforeEach(async ({ request }) => {
  await resetWorkbenchMode(request);
  // 地点页读的是媒体库快照：这条用例要能单独跑，不能等别的用例先把库准备好。
  await ensureLibraryReady(request);
});

test("侧栏的足迹入口打开的是新的地点页", async ({ page }) => {
  await page.goto("/photo");

  await page.getByRole("link", { name: "足迹" }).click();
  await expect(page).toHaveURL(/\/photo\/travels$/);
  await expect(page.getByRole("heading", { name: "足迹" })).toBeVisible();
});

test("足迹页先给规模，再给地点与行程", async ({ page }) => {
  await page.goto("/photo/travels");

  const ledger = page.getByRole("region", { name: /规模/ });
  await expect(ledger).toBeVisible();
  await expect(ledger.getByText("段足迹")).toBeVisible();
  await expect(ledger.getByText("去过的地方")).toBeVisible();
  await expect(ledger.getByText("张带位置的照片")).toBeVisible();

  // 地点索引与行程是两个独立区块，标题固定。
  await expect(
    page.getByRole("region", { name: "去过的地方" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "行程" })).toBeVisible();
});

test("临时库没有 GPS 坐标时如实说明，不编造地点", async ({ page }) => {
  await page.goto("/photo/travels");

  await expect(
    page.getByRole("region", { name: "去过的地方" }).getByText(/还没有去过什么地方/),
  ).toBeVisible();
  // 地图仍然完整：34 个省级区划一个不少。
  const provinces = page.locator(
    'svg[aria-label*="照片地图"] g[role="button"]',
  );
  await expect(provinces).toHaveCount(34);
});

test("时间轴在没有拍摄时间时如实说明", async ({ page }) => {
  await page.goto("/photo/travels");

  const axis = page.getByRole("region", { name: "时间轴" });
  await expect(axis).toBeVisible();
  await expect(axis.getByText(/没有拍摄时间，暂时画不出时间轴/)).toBeVisible();
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
