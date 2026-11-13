import type { AIJob, AIJobError, AIJobEstimateMode } from "../api/aiJobs";

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
 * 预计耗时的说法。
 *
 * 没有历史记录时明说算不出来，不用 0 或猜一个值糊弄过去 —— 一个假的
 * 「不到 1 秒」比一句「不知道」更糟。
 */
export function formatEstimateDuration(milliseconds: number | null): string {
  if (milliseconds === null) return "暂无历史记录，无法预估";
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "无需处理";
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `约 ${seconds} 秒`;
  const minutes = Math.round(milliseconds / 60000);
  if (minutes < 60) return `约 ${minutes} 分钟`;
  const hours = milliseconds / 3600000;
  return `约 ${hours.toFixed(1)} 小时`;
}

/**
 * 把几个模块的核算结果加起来。
 *
 * 只要有一个模块没有历史，整体就估不出来 —— 拿有历史的那部分假装能估出
 * 整体，比说不知道更糟。
 */
export function sumEstimateModes(
  modes: (AIJobEstimateMode | null | undefined)[],
): { count: number; estimatedDurationMs: number | null } {
  let count = 0;
  let duration = 0;
  let known = true;
  for (const mode of modes) {
    if (!mode) continue;
    count += mode.count;
    if (mode.estimatedDurationMs === null) {
      known = false;
      continue;
    }
    duration += mode.estimatedDurationMs;
  }
  return { count, estimatedDurationMs: known ? duration : null };
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
    case "checking_runtime":
      return "检查 AI 运行环境";
    case "waiting_for_library":
      return "等待媒体库";
    case "building_analysis_plan":
      return "整理分析清单";
    case "loading_model":
      return "准备本机模型与首批推理";
    case "pausing":
      return "准备暂停";
    case "processing":
      return "处理中";
    case "metadata":
      return "读取照片元数据";
    case "embedding":
      return "批量推理并写入语义向量";
    case "ocr":
      return "批量识别并保存文字";
    case "face":
      return "批量识别人脸并保存特征";
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

/** 模块没装好时的原因说明。 */
export function moduleReasonLabel(reason: string): string {
  switch (reason) {
    case "python_runtime_unavailable":
      return "Python 环境未就绪";
    case "ocr_dependencies_missing":
      return "缺少 OCR 依赖";
    case "ocr_dependency_version_mismatch":
      return "OCR 依赖版本不匹配";
    case "ocr_model_load_failed":
      return "OCR 模型加载失败";
    case "face_dependencies_missing":
      return "缺少人脸依赖";
    case "face_model_missing_or_checksum_invalid":
      return "人脸权重缺失或校验失败";
    case "face_model_load_failed":
      return "人脸模型加载失败";
    case "runtime_status_not_checked":
      return "正在检查本机环境";
    case "people_analysis_disabled":
      return "需先启用人物分析";
    case "module_not_registered":
      return "模块未安装";
    default:
      return "未安装";
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
    case "indexed":
      return "已建向量";
    case "recognized":
      return "检出文字";
    case "no_text":
      return "未检出文字";
    case "faces_found":
      return "检出人脸";
    case "no_faces":
      return "未检出人脸";
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
    case "ocrText":
      return "文字内容";
    case "faces":
      return "人脸特征";
    case "embedding":
      return "语义向量";
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
