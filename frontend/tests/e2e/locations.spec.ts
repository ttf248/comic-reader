import { expect, test } from "@playwright/test";
import { resetWorkbenchMode } from "./helpers/library";

test.beforeEach(async ({ request }) => {
  await resetWorkbenchMode(request);
});

test("离线地点地图可选择省份并展开城市区县", async ({ page }) => {
  await page.goto("/photo/locations");

  await expect(
    page.getByRole("heading", { name: "中国省级地图" }),
  ).toBeVisible();
  const provinceButtons = page.locator(
    'svg[aria-label="中国省份地图，可用键盘选择省份"] path[role="button"]',
  );
  await expect(provinceButtons).toHaveCount(34);
  await page.getByRole("button", { name: "北京市，0 张照片" }).click();

  await expect(page.getByRole("heading", { name: "北京市" })).toBeVisible();
  await expect(page.getByText("东城区")).toBeVisible();
  await expect(page.getByText("西城区")).toBeVisible();
  await expect(page.getByText(/GPS 坐标聚合|坐标\s+\d/)).toHaveCount(0);
});
