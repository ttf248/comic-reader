import type { AIJob, AIJobError } from "../api/aiJobs";

/** 千分位计数。 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString();
}

/** 毫秒时长 → "1 分 12 秒"。 */
export function formatTaskDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "—";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

/** 每秒处理张数。 */
export function formatTaskSpeed(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return `${value.toFixed(1)} 张/秒`;
}

/**
 * 本次任务的完成百分比。
 *
 * 分母是「本次实际要处理的张数」而不是整库规模：增量任务里整库大部分
 * 文件已经是最新的，拿整库当分母会让进度一上来就接近满格。
 * 清单还没整理出来时 planned 为 0，进度是 0 而不是满格。
 */
export function jobProgressPercent(job: AIJob): number {
  const planned = job.planned ?? 0;
  if (planned <= 0) {
    return job.status === "completed" ? 100 : 0;
  }
  const completed = job.completed ?? 0;
  return Math.min(100, Math.max(0, Math.round((completed / planned) * 100)));
}

export function taskStatusLabel(status: AIJob["status"]): string {
  switch (status) {
    case "pending":
      return "排队中";
    case "running":
      return "运行中";
    case "paused":
      return "已暂停";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

export function taskStageLabel(stage: string): string {
  switch (stage) {
    case "pending":
      return "排队中";
    case "waiting_for_library":
      return "等待媒体库";
    case "pausing":
      return "准备暂停";
    case "processing":
      return "处理中";
    case "metadata":
      return "读取照片元数据";
    case "paused":
      return "已暂停";
    case "complete":
      return "分析完成";
    case "failed":
      return "分析失败";
    case "cancelled":
      return "已取消";
    default:
      return stage || "准备中";
  }
}

export function taskModeLabel(mode: AIJob["mode"]): string {
  return mode === "full" ? "全量" : "增量";
}

export function taskModuleLabel(type: AIJob["type"]): string {
  switch (type) {
    case "metadata":
      return "元数据分析";
    case "embedding":
      return "向量索引";
    case "ocr":
      return "文字识别";
    case "face":
      return "人脸识别";
    default:
      return type;
  }
}

export function taskTitle(job: AIJob): string {
  return `${job.scheduled ? "每日" : "手动"} ${taskModuleLabel(job.type)}`;
}

/** 解析结果分类的中文名。 */
export function taskResultLabel(key: string): string {
  switch (key) {
    case "parsed":
      return "已解析";
    case "no_exif":
      return "无 EXIF";
    case "unsupported":
      return "格式不支持";
    case "failed":
      return "解析失败";
    case "processed":
      return "已处理";
    default:
      return key;
  }
}

/** 产出字段的中文名。 */
export function taskFieldLabel(key: string): string {
  switch (key) {
    case "exifTime":
      return "拍摄时间";
    case "camera":
      return "相机信息";
    case "gps":
      return "GPS 坐标";
    default:
      return key;
  }
}

export interface FailureGroup {
  code: string;
  message: string;
  items: AIJobError[];
}

/**
 * 按「错误码 + 原因」把失败项分组。
 *
 * 同一个原因动辄几十条，逐条铺开只是一堆重复文本；分组之后先看到
 * 「哪一类坏了、坏了几张」，需要时才展开看具体路径。
 */
export function groupFailures(
  errors: AIJobError[] | undefined,
): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const error of errors ?? []) {
    const key = `${error.code}\u0000${error.message}`;
    const group = groups.get(key);
    if (group) {
      group.items.push(error);
      continue;
    }
    groups.set(key, {
      code: error.code,
      message: error.message,
      items: [error],
    });
  }
  return [...groups.values()].sort(
    (left, right) => right.items.length - left.items.length,
  );
}
