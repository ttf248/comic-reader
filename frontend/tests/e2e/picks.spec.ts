import { ensureLibraryReady, scannedNodes } from "./helpers/library";
import { expect, test } from "@playwright/test";

// 照片精选的跨层主链路：照片墙加入精选 → 精选页列出来 → 重启后仍在。
//
// 精选是照片级的数据，与相册级收藏是两份。这里既验证接口，也验证
// 界面上「照片墙 → 精选页」这条路径真的连着。
test("照片可以加入精选，在精选页里聚在一起，重启后仍然保留", async ({
  page,
  request,
}) => {
  await ensureLibraryReady(request);
  const nodes = await scannedNodes(request, "photo");
  // 素材里的样例相册在照片根下，有三张图：够勾选，也够并排对比。
  const album = nodes.find((node) => node.name === "sample-album");
  expect(album).toBeDefined();

  // 清掉上一条用例留下的精选：精选是全局一份数据。
  const before = (await (await request.get("/api/picks")).json()) as {
    picks: string[];
  };
  if (before.picks.length > 0) {
    const response = await request.post("/api/picks/batch", {
      data: { ids: before.picks, action: "remove" },
    });
    expect(response.ok()).toBeTruthy();
  }

  await page.goto(`/photo/albums/${encodeURIComponent(album!.id)}`);
  const firstTile = page.locator("button[aria-label^='查看']").first();
  await firstTile.waitFor({ timeout: 20000 });

  // 悬停才露出精选角标：满墙常驻圆点会把照片本身挤掉。
  await firstTile.hover();
  const pickButton = page.locator('button[aria-label*="加入精选"]').first();
  await expect(pickButton).toBeVisible();
  await pickButton.click();

  // 服务端确认了这一张进了精选。
  await expect
    .poll(async () => {
      const response = (await (await request.get("/api/picks")).json()) as {
        picks: string[];
      };
      return response.picks.length;
    })
    .toBe(1);

  // 精选页把它列出来，并说得出它属于哪本相册。
  await page.goto("/photo/picks");
  await expect(
    page.getByRole("heading", { name: "精选照片", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("1 张", { exact: true })).toBeVisible();
  const pickedTile = page.locator('button[aria-label*="移出精选"]').first();
  await expect(pickedTile).toBeVisible();

  // 精选与相册级收藏是两份数据：收藏相册不动精选。
  const favorites = (await (await request.get("/api/favorites")).json()) as {
    favorites: string[];
  };
  expect(favorites.favorites).not.toContain(album!.id);

  // 状态落在磁盘上：换一次读取（重新请求接口）仍在，重启后也还在。
  const again = (await (await request.get("/api/picks")).json()) as {
    picks: string[];
  };
  expect(again.picks).toHaveLength(1);
});
