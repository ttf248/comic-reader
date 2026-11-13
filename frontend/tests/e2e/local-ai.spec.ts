import { expect, test } from "@playwright/test";

test.describe("本机智能照片功能", () => {
  test("人物分析默认关闭并可前往任务中心", async ({ page }) => {
    await page.goto("/photo/people");
    await expect(page.getByRole("heading", { name: "人物相册" })).toBeVisible();
    await expect(page.getByText("人物分析默认关闭")).toBeVisible();
    const peopleResponse = await page.request.get("/api/people");
    expect(peopleResponse.ok()).toBeTruthy();
    await expect(peopleResponse.json()).resolves.toMatchObject({
      people: [],
      totalGroups: 0,
      limit: 50,
    });
    const peopleSearchResponse = await page.request.get(
      "/api/people?q=%E4%B8%8D%E5%AD%98%E5%9C%A8&limit=20",
    );
    expect(peopleSearchResponse.ok()).toBeTruthy();
    await expect(peopleSearchResponse.json()).resolves.toMatchObject({
      people: [],
      totalGroups: 0,
      limit: 20,
    });
    await page.getByRole("link", { name: "打开任务中心" }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(
      page.getByRole("checkbox", { name: "启用人物分析（默认关闭）" }),
    ).toBeVisible();
  });

  test("Chinese-CLIP 不可用时仍能从智能搜索提交 OCR 条件", async ({ page }) => {
    await page.goto("/photo/semantic");
    await page
      .getByPlaceholder("例如：车站名称、招牌或照片里的日期")
      .fill("入口");
    await page.getByRole("button", { name: "搜索照片" }).click();
    await expect(page.getByText("还没有可搜索的文字结果")).toBeVisible();
  });
});
