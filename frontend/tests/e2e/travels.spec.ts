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

test("地图在正文右栏，照片位置画成点云", async ({ page }) => {
  await page.goto("/photo/travels");

  // 地图不用选中什么就一直在：它就在正文右栏里，滚动时跟着。
  const map = page.locator(".travel-layout__aside").getByRole("img", { name: /小地图/ });
  await expect(map).toBeVisible();

  // 临时库里三个坐标（杭州 ×3、上海 ×2、北京 ×1）—— 这一条断言是
  // EXIF → 匹配 → 聚合 → 端点 → 渲染整条链路的端到端验证。
  await expect(page.locator(".travel-mini-map__point")).toHaveCount(3);
});

test("时间轴是一排月格，两端能拖出一个区间", async ({ page }) => {
  await page.goto("/photo/travels");

  const timeline = page.getByRole("region", { name: "时间轴" });
  await expect(timeline).toBeVisible();
  const handles = timeline.getByRole("slider");
  await expect(handles).toHaveCount(2);
  // 临时库的照片拍在 2024-05 与 2025-09：尺子量的是整条历史。
  await expect(handles.first()).toHaveAttribute("aria-valuetext", "2024-05");

  // 一格一个月：2024-05 到 2025-09 共 17 个月，空档的月份也占位。
  await expect(page.locator(".travel-timeline__cell")).toHaveCount(17);

  // 拖右端的手柄：区间写进地址。
  // 时间轴在页面下半屏，先滚到可见处 —— 否则鼠标坐标落在视口之外。
  const end = handles.nth(1);
  await end.scrollIntoViewIfNeeded();
  const box = await end.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x - 60, box!.y + box!.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect(page).toHaveURL(/from=/);
  await expect(page).toHaveURL(/to=/);
});

test("行程一行一段，点开才展开照片", async ({ page }) => {
  await page.goto("/photo/travels");

  // 杭州 → 上海相隔一天，是同一段行程；北京隔了一年，另起一段。
  const segment = page.getByRole("region", { name: "2024-05-02 至 2024-05-03" });
  await expect(segment).toBeVisible();
  await expect(segment.getByRole("button", { name: /杭州市/ })).toBeVisible();
  await expect(segment.getByRole("button", { name: /上海市/ })).toBeVisible();

  // 收起的时候没有照片带。
  await expect(
    segment.getByRole("button", { name: "看这一段的照片" }),
  ).toHaveCount(0);

  await segment.getByRole("button", { name: /2024-05-02 至 2024-05-03/ }).click();

  // 照片带是这一段的门面：五张照片都在带子上。
  await expect(
    segment.getByRole("button", { name: "看这一段的照片" }),
  ).toHaveCount(5);

  await expect(
    page.getByRole("region", { name: "2025-09-10 至 2025-09-10" }),
  ).toBeVisible();
});

test("展开一段，就地把这一段的照片取回来", async ({ page }) => {
  await page.goto("/photo/travels");

  const segment = page.getByRole("region", { name: "2024-05-02 至 2024-05-03" });
  await segment.getByRole("button", { name: /2024-05-02 至 2024-05-03/ }).click();

  await expect(segment.locator(".travel-segment__grid")).toBeVisible();
  // 整段的五张照片都在展开后的照片墙里。
  await expect(segment.locator(".travel-segment__grid img")).toHaveCount(5);
});

test("「地方」列出去过的地方", async ({ page }) => {
  await page.goto("/photo/travels");

  await page.getByRole("button", { name: "地方" }).click();

  const panel = page.getByRole("complementary", { name: "去过的地方" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("杭州市")).toBeVisible();
  await expect(panel.getByText("上海市")).toBeVisible();
  await expect(panel.getByText("北京市")).toBeVisible();
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
