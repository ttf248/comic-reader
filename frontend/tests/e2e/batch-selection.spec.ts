import { expect, test, type APIRequestContext } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import type { StatePreview } from "../../src/api/stateBackup";

async function ready(request: APIRequestContext) {
  const config = (await (await request.get("/api/config")).json()) as {
    mediaRoots: { path: string; kind: string }[];
  };
  await request.put("/api/config", {
    data: {
      mediaRoots: config.mediaRoots.filter((root) => existsSync(root.path)),
    },
  });
  if (!(await request.get("/api/library/manifest")).ok())
    await request.post("/api/scans");
  await expect
    .poll(async () => (await request.get("/api/library/manifest")).status())
    .toBe(200);
}
async function restore(
  request: APIRequestContext,
  backup: unknown,
  categories: string[],
) {
  const preview = (await (
    await request.post("/api/admin/state/import/preview", { data: { backup } })
  ).json()) as StatePreview;
  const response = await request.post("/api/admin/state/import", {
    data: {
      backup,
      categories,
      versions: preview.versions,
      libraryRevision: preview.libraryRevision,
    },
  });
  expect(response.ok()).toBeTruthy();
}

test("照片多选支持键盘、排序保留和失败重试，筛选清空", async ({
  page,
  request,
}) => {
  await ready(request);
  const backup: unknown = await (
    await request.get("/api/admin/state/export")
  ).json();
  try {
    await page.goto("/photo");
    await page.getByRole("button", { name: "选择", exact: true }).click();
    const card = page.getByRole("checkbox", {
      name: "选择“sample-album”",
      exact: true,
    });
    await card.click();
    await expect(card).toHaveAttribute("aria-checked", "true");
    await expect(page).toHaveURL(/\/photo$/);
    await card.press("Space");
    await expect(card).toHaveAttribute("aria-checked", "false");
    await card.press("Space");
    await expect(
      page.getByRole("button", { name: "标记已读", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "排序", exact: true }).click();
    await page.getByRole("button", { name: "按最近改", exact: true }).click();
    await expect(
      page.getByRole("checkbox", { name: "选择“sample-album”", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    let fail = true;
    await page.route("**/api/favorites/batch", async (route) => {
      if (fail)
        await route.fulfill({
          status: 500,
          json: { code: "test_error", message: "unavailable" },
        });
      else await route.continue();
    });
    await page.getByRole("button", { name: "批量收藏", exact: true }).click();
    await expect(
      page.getByText("批量操作失败，请重试。", { exact: true }),
    ).toBeVisible();
    await expect(card).toHaveAttribute("aria-checked", "true");
    fail = false;
    await page.getByRole("button", { name: "批量收藏", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "选择", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "选择", exact: true }).click();
    await page
      .getByRole("button", { name: "选择已加载项", exact: true })
      .click();
    mkdirSync(".smoke/roadmap-batch", { recursive: true });
    for (const theme of ["浅色", "深色"]) {
      await page.getByRole("button", { name: /^主题:/ }).click();
      await page
        .getByRole("menuitemradio", { name: theme, exact: true })
        .click();
      await page.keyboard.press("Escape");
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page
          .getByRole("button", { name: "批量收藏", exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `.smoke/roadmap-batch/${theme}-${width}.png`,
        });
      }
    }
    await page.getByRole("combobox").fill("sample-album");
    await expect(
      page.getByRole("button", { name: "选择", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "批量收藏", exact: true }),
    ).toHaveCount(0);
  } finally {
    await restore(request, backup, ["favorites"]);
  }
});

test("漫画批量已读与重置只修改所选阅读活动", async ({ page, request }) => {
  await ready(request);
  const backup: unknown = await (
    await request.get("/api/admin/state/export")
  ).json();
  try {
    await page.goto("/comic");
    await page.getByRole("combobox").fill("sample-comic");
    await page.getByRole("button", { name: "选择", exact: true }).click();
    await page
      .getByRole("button", { name: "选择已加载项", exact: true })
      .click();
    const marked = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/activity/batch" &&
        response.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "标记已读", exact: true }).click();
    expect((await marked).ok()).toBeTruthy();
    await expect(
      page.getByRole("button", { name: "选择", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "选择", exact: true }).click();
    await page
      .getByRole("button", { name: "选择已加载项", exact: true })
      .click();
    const reset = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/activity/batch" &&
        response.request().method() === "DELETE",
    );
    await page.getByRole("button", { name: "重置未读", exact: true }).click();
    expect((await reset).ok()).toBeTruthy();
    await expect(
      page.getByRole("button", { name: "选择", exact: true }),
    ).toBeVisible();
  } finally {
    await restore(request, backup, ["activities"]);
  }
});

for(const view of ["网格视图","列表视图"] as const) {
  test(`选择模式 ${view} 长列表滚动与宽度切换无崩溃`,async({page,request})=>{
    await ready(request);const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    await page.goto("/comic");await page.getByRole("combobox").fill("long-list");
    await page.getByRole("button",{name:view,exact:true}).click();
    await page.getByRole("button",{name:"选择",exact:true}).click();await page.getByRole("button",{name:"选择已加载项",exact:true}).click();
    for(const width of [390,1440]) {
      await page.setViewportSize({width,height:900});
      await page.locator("main").evaluate(element=>{element.scrollTop=element.scrollHeight});
      await expect(page.getByRole("checkbox",{name:/long-list-108/})).toBeVisible();
      await page.locator("main").evaluate(element=>{
        const toolbar=element.querySelector('[aria-label="批量操作"]');
        const wrapper=toolbar?.parentElement;
        if(!wrapper)throw new Error("选择列表不存在");
        element.scrollTop=wrapper.getBoundingClientRect().top-element.getBoundingClientRect().top+element.scrollTop;
      });
      await expect(page.getByRole("checkbox",{name:/long-list-001/})).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
}
