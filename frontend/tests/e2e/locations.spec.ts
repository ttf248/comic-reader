import { expect, test } from "@playwright/test";
import { resetWorkbenchMode } from "./helpers/library";

test.beforeEach(async ({ request }) => {
  await resetWorkbenchMode(request);
});

test("拍摄地点逐级下钻并可返回", async ({ page }) => {
  await page.goto("/photo/locations");

  await expect(
    page.getByRole("heading", { name: "全国省级照片地图" }),
  ).toBeVisible();
  const provinceButtons = page.locator(
    'svg[aria-label*="照片地图"] [role="button"]',
  );
  await expect(provinceButtons).toHaveCount(34);
  await expect(page.getByText("基准：全国")).toBeVisible();
  // 全国层级没有上级，不该摆一个会退出页面的返回按钮。
  await expect(page.getByRole("button", { name: "返回" })).toHaveCount(0);

  await page.getByRole("button", { name: /^北京市，/ }).click();

  await expect(page).toHaveURL(/adcode=110000/);
  await expect(
    page.getByRole("heading", { name: "北京市地图" }),
  ).toBeVisible();
  const crumb = page.getByRole("navigation", { name: "地点层级" });
  await expect(crumb).toContainText("全国");
  await expect(crumb).toContainText("北京市");
  await expect(page.getByText("基准：北京市")).toBeVisible();
  await expect(page.getByRole("button", { name: /东城区，/ })).toBeVisible();
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
  await expect(
    page.getByRole("heading", { name: "北京市地图" }),
  ).toBeVisible();
});

test("排行面板也能进入区域", async ({ page }) => {
  await page.goto("/photo/locations");

  await page.getByRole("button", { name: /^北京市，.*进入$/ }).click();
  await expect(page).toHaveURL(/adcode=110000/);
  await expect(page.getByRole("button", { name: /东城区，/ })).toBeVisible();
});
