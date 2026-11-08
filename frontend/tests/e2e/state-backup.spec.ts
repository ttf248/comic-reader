import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import type {
  StatePreview,
  StateRestoreResult,
} from "../../src/api/stateBackup";

async function ready(request: import("@playwright/test").APIRequestContext) {
  const config = (await (await request.get("/api/config")).json()) as {
    mediaRoots: { path: string; kind: string }[];
  };
  const roots = config.mediaRoots.filter((root) => existsSync(root.path));
  const saved = await request.put("/api/config", {
    data: { mediaRoots: roots },
  });
  expect(saved.ok()).toBeTruthy();
  if (!(await request.get("/api/library/manifest")).ok())
    await request.post("/api/scans");
  await expect
    .poll(async () => (await request.get("/api/library/manifest")).status())
    .toBe(200);
}

test("本机备份下载、仅恢复收藏、过期预览拒绝覆盖", async ({
  page,
  request,
}) => {
  await ready(request);
  const original = (await (
    await request.get("/api/admin/state/export")
  ).json()) as { version: number; favorites: string[]; history: unknown[] };
  const list = (await (
    await request.get("/api/library/overview?kind=photo&view=album&limit=1")
  ).json()) as { page: { items: { node: { id: string } }[] } };
  const id = list.page.items[0].node.id;
  try {
    expect(
      (await request.post("/api/favorites", { data: { resourceId: id } })).ok(),
    ).toBeTruthy();
    await page.goto("/settings");
    const panel = page.getByRole("region", { name: "备份与恢复" });
    await panel.scrollIntoViewIfNeeded();
    const downloaded = page.waitForEvent("download");
    await panel.getByRole("button", { name: "导出状态备份" }).click();
    expect((await downloaded).suggestedFilename()).toMatch(
      /^local-gallery-state-/,
    );
    const backup = (await (
      await request.get("/api/admin/state/export")
    ).json()) as typeof original;
    expect(JSON.stringify(backup)).not.toMatch(
      /[A-Z]:\\|accessToken|configPath|internalCovers/,
    );
    expect(
      (
        await request.delete("/api/favorites", { data: { resourceId: id } })
      ).ok(),
    ).toBeTruthy();
    await panel.getByLabel("状态备份文件").setInputFiles({
      name: "state.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(backup)),
    });
    await expect(
      panel.getByRole("button", { name: "确认覆盖恢复" }),
    ).toBeVisible();
    mkdirSync(".smoke/roadmap-backup", { recursive:true });
    await page.setViewportSize({width:390,height:900});
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({path:".smoke/roadmap-backup/preview-390.png"});
    await page.setViewportSize({width:1440,height:900});
    for (const category of [
      /最近访问 ·/,
      /服务端偏好 ·/,
      /阅读与播放活动 ·/,
      /自定义封面 ·/,
    ])
      await panel.getByRole("checkbox", { name: category }).uncheck();
    page.once("dialog", (dialog) => void dialog.accept());
    await panel.getByRole("button", { name: "确认覆盖恢复" }).click();
    await expect(panel.getByText("已完成：收藏")).toBeVisible();
    const favorites = (await (await request.get("/api/favorites")).json()) as {
      favorites: string[];
    };
    expect(favorites.favorites).toContain(id);
    const preview = (await (
      await request.post("/api/admin/state/import/preview", {
        data: { backup },
      })
    ).json()) as StatePreview;
    await request.delete("/api/favorites", { data: { resourceId: id } });
    const stale = await request.post("/api/admin/state/import", {
      data: {
        backup,
        categories: ["favorites"],
        versions: preview.versions,
        libraryRevision: preview.libraryRevision,
      },
    });
    expect(stale.status()).toBe(409);
    mkdirSync(".smoke/roadmap-backup", { recursive: true });
    for (const theme of ["浅色", "深色"]) {
      await page.getByRole("button", { name: /^主题:/ }).click();
      await page
        .getByRole("menuitemradio", { name: theme, exact: true })
        .click();
      await page.keyboard.press("Escape");
      for (const width of [390, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await panel.scrollIntoViewIfNeeded();
        await expect(page.locator("html")).toHaveAttribute(
          "data-theme",
          theme === "深色" ? "dark" : "light",
        );
        await page.screenshot({
          path: `.smoke/roadmap-backup/${theme}-${width}.png`,
        });
      }
    }
  } finally {
    const preview = (await (
      await request.post("/api/admin/state/import/preview", {
        data: { backup: original },
      })
    ).json()) as StatePreview;
    const response = await request.post("/api/admin/state/import", {
      data: {
        backup: original,
        categories: ["favorites"],
        versions: preview.versions,
        libraryRevision: preview.libraryRevision,
      },
    });
    expect(response.ok()).toBeTruthy();
    expect(
      ((await response.json()) as StateRestoreResult).failed,
    ).toBeUndefined();
  }
});
