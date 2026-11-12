import { expect, test } from "@playwright/test";
import { scannedNodes } from "./helpers/library";

test.describe("任务中心", () => {
  test("按区块呈现运行、任务记录、每日计划与本机存储", async ({ page }) => {
    await page.goto("/tasks");
    await expect(page.getByRole("heading", { name: "运行" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "任务记录" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "每日计划" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "本机存储" })).toBeVisible();
    // 空闲态给出开始分析的入口：模块芯片 + 处理方式 + 开始按钮。
    await expect(
      page.getByRole("group", { name: "分析模块" }).getByRole("button", {
        name: "照片元数据",
      }),
    ).toBeVisible();
    await expect(page.getByRole("radio", { name: "增量" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "全量" })).toBeVisible();
    await expect(page.getByRole("button", { name: "开始分析" })).toBeVisible();
  });

  test("本机存储给出派生缓存占用、模型与产物路径", async ({ page }) => {
    await page.goto("/tasks");
    await expect(page.getByRole("heading", { name: "派生缓存" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "AI 模型与产物" })).toBeVisible();
    // 「缩略图」在重建范围勾选项里也有一份，这里认的是占用行。
    await expect(
      page.locator("span.text-fg-muted", { hasText: /^缩略图$/ }),
    ).toBeVisible();
    await expect(page.getByText("转换图", { exact: true })).toBeVisible();
    // 路径默认收起，展开后相对路径对所有设备可见；本机浏览器还能看到绝对锚点。
    await page.getByText("路径", { exact: true }).click();
    await expect(page.getByText("state/ai_jobs.json")).toBeVisible();
    await expect(page.getByText("缓存根目录", { exact: true })).toBeVisible();
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
    await expect(page.getByRole("radio", { name: "全量" })).toBeVisible();
    const start = page.getByRole("button", { name: "开始分析" });
    await expect(start).toBeVisible();
    const startResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/ai/jobs") &&
        response.request().method() === "POST",
    );
    await page.getByRole("radio", { name: "全量" }).click();
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
    // 展开后给出这次任务自己的产物位置与占用。
    await expect(history.getByText("本次产物")).toBeVisible();
    await expect(
      history.getByText(/derived\/metadata\/metadata\/batches\//),
    ).toBeVisible();
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
