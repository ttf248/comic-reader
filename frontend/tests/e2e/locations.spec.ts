import { expect, test } from "@playwright/test";
import { ensureLibraryReady, resetWorkbenchMode } from "./helpers/library";

/** 地图上的区域（SVG 里的可聚焦节点）。 */
const mapRegion = (page: import("@playwright/test").Page, name: string) =>
  page.locator(
    `svg[aria-label*="照片地图"] g[role="button"][aria-label^="${name}，"]`,
  );

/** 排行面板里的行。 */
const rankingRow = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("button", { name: new RegExp(`^${name}，.*进入$`) });

test.beforeEach(async ({ request }) => {
  await resetWorkbenchMode(request);
  // 地图读的是媒体库快照：这条用例要能单独跑，不能等别的用例先把库准备好。
  await ensureLibraryReady(request);
});

test("拍摄地点逐级下钻并可返回", async ({ page }) => {
  await page.goto("/photo/locations");

  await expect(
    page.getByRole("heading", { name: "全国省级照片地图" }),
  ).toBeVisible();
  const provinceButtons = page.locator(
    'svg[aria-label*="照片地图"] g[role="button"]',
  );
  await expect(provinceButtons).toHaveCount(34);
  await expect(page.getByText("基准：全国")).toBeVisible();
  // 全国层级没有上级，不该摆一个会退出页面的返回按钮。
  await expect(page.getByRole("button", { name: "返回" })).toHaveCount(0);

  await mapRegion(page, "北京市").click();

  await expect(page).toHaveURL(/adcode=110000/);
  await expect(page.getByRole("heading", { name: "北京市地图" })).toBeVisible();
  const crumb = page.getByRole("navigation", { name: "地点层级" });
  await expect(crumb).toContainText("全国");
  await expect(crumb).toContainText("北京市");
  await expect(page.getByText("基准：北京市")).toBeVisible();
  await expect(mapRegion(page, "东城区")).toBeVisible();
  await expect(page.getByText(/GPS 坐标聚合|坐标\s+\d/)).toHaveCount(0);

  // 面包屑回到全国。
  await page.getByRole("button", { name: "全国" }).click();
  await expect(page).not.toHaveURL(/adcode=/);
  await expect(
    page.getByRole("heading", { name: "全国省级照片地图" }),
  ).toBeVisible();
  await expect(provinceButtons).toHaveCount(34);

  // 浏览器后退回到刚才那一级。
  await page.goBack();
  await expect(page).toHaveURL(/adcode=110000/);
  await expect(page.getByRole("heading", { name: "北京市地图" })).toBeVisible();
});

test("排行面板也能进入区域", async ({ page }) => {
  await page.goto("/photo/locations");

  await rankingRow(page, "北京市").click();
  await expect(page).toHaveURL(/adcode=110000/);
  await expect(mapRegion(page, "东城区")).toBeVisible();
});

test("时间轴在没有拍摄时间时如实说明", async ({ page }) => {
  await page.goto("/photo/locations");

  const axis = page.getByRole("region", { name: "时间轴" });
  await expect(axis).toBeVisible();
  // 临时库里的照片没有 EXIF，时间轴不编造年份。
  await expect(axis.getByText(/没有拍摄时间，暂时画不出时间轴/)).toBeVisible();
  await expect(page.getByText(/基准：全国 · 全部时间/)).toBeVisible();
});
