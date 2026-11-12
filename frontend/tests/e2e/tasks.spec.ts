import { expect, test } from "@playwright/test";
import { scannedNodes } from "./helpers/library";

test.describe("任务中心", () => {
  test("按区块呈现状态、等待队列、每日计划与任务记录", async ({ page }) => {
    await page.goto("/tasks");
    await expect(page.getByRole("heading", { name: "状态" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "等待队列" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "每日计划" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "任务记录" })).toBeVisible();
    // 空闲态给出开始分析的入口。
    await expect(page.getByRole("button", { name: "增量分析" })).toBeVisible();
    await expect(page.getByRole("button", { name: "全量分析" })).toBeVisible();
  });

  test("每日计划的时间可以保存并在刷新后保留", async ({ page }) => {
    await page.goto("/tasks");
    const timeInput = page.getByLabel("每日分析开始时间");
    await expect(timeInput).toBeEnabled();
    await timeInput.fill("04:15");
    await page.getByRole("button", { name: "保存计划" }).click();
    await expect(page.getByText("已保存")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("每日分析开始时间")).toHaveValue("04:15");
  });

  test("跑完一次分析后任务记录里出现新的任务与产出明细", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/tasks");
    await scannedNodes(page.request);
    const start = page.getByRole("button", { name: "全量分析" });
    await expect(start).toBeVisible();
    const startResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/ai/jobs") &&
        response.request().method() === "POST",
    );
    await start.click();
    const startedJob = (await (await startResponse).json()).job as {
      id: string;
    };

    // 任务跑起来后状态面板给出进度读数。
    await expect(page.getByText("预计剩余")).toBeVisible({ timeout: 30_000 });

    // 同一测试库可能已有定时任务；跟踪本次启动的 ID，避免把旧记录当成本次结果。
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/ai/jobs/${encodeURIComponent(startedJob.id)}`,
          );
          if (!response.ok()) return "missing";
          const job = (await response.json()) as { status: string };
          return job.status;
        },
        { timeout: 90_000 },
      )
      .toMatch(/^(completed|failed|cancelled)$/);

    // 任务结束后任务记录里多出一行，展开后有产出明细。
    const history = page.locator(
      `[data-testid="task-history-row"][data-job-id="${startedJob.id}"]`,
    );
    await expect(history).toBeVisible({ timeout: 60_000 });
    await history.locator(":scope > summary").click();
    await expect(history.getByText("产出明细")).toBeVisible();
    await expect(history.getByText("解析结果")).toBeVisible();
    // 临时库的图都是无 EXIF 的 1×1 PNG，取不到拍摄时间 / 相机 / GPS，
    // 因此这里只断言解析结果这一行；字段产出的渲染由 Vitest 覆盖。

    page.once("dialog", (dialog) => dialog.accept());
    await history.getByRole("button", { name: "删除任务记录" }).click();
    await expect(history).toHaveCount(0);
    const response = await page.request.get("/api/ai/jobs");
    const body = (await response.json()) as {
      snapshot: { jobs: { id: string }[]; queue: string[] };
    };
    expect(body.snapshot.jobs.some((job) => job.id === startedJob.id)).toBe(
      false,
    );
    expect(body.snapshot.queue).not.toContain(startedJob.id);
  });
});
