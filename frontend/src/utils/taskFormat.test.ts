import { describe, expect, it } from "vitest";
import {
  formatTaskDuration,
  formatTaskSpeed,
  groupFailures,
  jobProgressPercent,
  taskFieldLabel,
  taskResultLabel,
} from "./taskFormat";
import type { AIJob, AIJobError } from "../api/aiJobs";

function job(overrides: Partial<AIJob> = {}): AIJob {
  return {
    id: "job",
    type: "metadata",
    mode: "incremental",
    status: "running",
    stage: "metadata",
    moduleVersion: "metadata-v1",
    total: 100,
    processed: 0,
    skipped: 0,
    failed: 0,
    done: 0,
    planned: 0,
    completed: 0,
    estimatedRemainingMs: 0,
    elapsedMs: 0,
    speedPerSecond: 0,
    checkpoint: { offset: 0, batch: 0, moduleVersion: "metadata-v1" },
    createdAt: "2026-11-11T02:00:00Z",
    updatedAt: "2026-11-11T02:00:00Z",
    ...overrides,
  };
}

function failure(
  resourceId: string,
  code: string,
  message: string,
): AIJobError {
  return { resourceId, code, message, at: "2026-11-11T02:00:00Z" };
}

describe("任务格式化", () => {
  it("进度百分比按本次待处理量算", () => {
    expect(jobProgressPercent(job({ planned: 45, completed: 43 }))).toBe(96);
    expect(jobProgressPercent(job({ planned: 10, completed: 20 }))).toBe(100);
    // 清单还没整理出来：进度是 0；跑完发现没东西可做才是 100。
    expect(jobProgressPercent(job({ planned: 0, completed: 0 }))).toBe(0);
    expect(
      jobProgressPercent(
        job({ planned: 0, completed: 0, status: "completed" }),
      ),
    ).toBe(100);
  });

  it("时长与速度的空值显示为破折号", () => {
    expect(formatTaskDuration(0)).toBe("—");
    expect(formatTaskDuration(65_000)).toBe("1 分 5 秒");
    expect(formatTaskDuration(3_600_000)).toBe("1 小时 0 分");
    expect(formatTaskSpeed(0)).toBe("—");
    expect(formatTaskSpeed(1.6)).toBe("1.6 张/秒");
  });

  it("解析状态有中文名", () => {
    expect(taskResultLabel("no_exif")).toBe("无 EXIF");
    expect(taskResultLabel("recognized")).toBe("检出文字");
    expect(taskResultLabel("faces_found")).toBe("检出人脸");
    expect(taskFieldLabel("ocrText")).toBe("文字内容");
    expect(taskFieldLabel("faces")).toBe("人脸特征");
    expect(taskResultLabel("unknown_status")).toBe("unknown_status");
  });

  it("失败项按错误码与原因分组，多的排前面", () => {
    const groups = groupFailures([
      failure("a", "analysis_failed", "EXIF 数据损坏或无法解析"),
      failure("b", "source_unavailable", "无法读取图片或路径校验失败"),
      failure("c", "analysis_failed", "EXIF 数据损坏或无法解析"),
      failure("d", "analysis_failed", "另一个原因"),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0].message).toBe("EXIF 数据损坏或无法解析");
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].message).toBe("无法读取图片或路径校验失败");
    expect(groups[1].items).toHaveLength(1);
    expect(groups[2].message).toBe("另一个原因");
  });

  it("没有失败项时返回空列表", () => {
    expect(groupFailures(undefined)).toEqual([]);
    expect(groupFailures([])).toEqual([]);
  });
});
