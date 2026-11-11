import { ApiError } from "../api/client";

// 后端错误码 → 中文提示。
//
// 后端返回的 message 是英文机器文案（例如 "resource type does not support
// this operation"），直接展示给用户既看不懂也读不顺。这里按错误码给出
// 可读的中文说明；没有收录的错误码统一用调用方给的兜底文案，不再把英文
// 原文抛到界面上。
const CODE_MESSAGES: Record<string, string> = {
  // 资源与媒体
  invalid_resource_kind: "该目录不是相册，无法读取其中的媒体",
  invalid_resource_id: "资源标识无效，请重新扫描后重试",
  resource_not_found: "资源已失效，请重新扫描后重试",
  media_not_found: "文件已不存在，可能已被移动或删除",
  video_not_found: "视频已不存在，可能已被移动或删除",
  source_not_found: "源文件已不存在",
  unsupported_image_format: "不支持的图片格式",
  unsupported_format: "不支持的文件格式",
  unsupported_media: "不支持的媒体类型",
  unsupported_video_format: "不支持的视频格式",
  video_cover_missing: "视频封面还没生成，稍后会自动补上",
  thumbnail_error: "缩略图生成失败",
  image_info_failed: "无法读取图片信息",
  video_info_failed: "无法读取视频信息",
  // 媒体库
  library_not_ready: "媒体库还没准备好，请先扫描",
  stale_cursor: "媒体库已更新，请重新打开相册",
  invalid_cursor: "分页已失效，请重新打开相册",
  no_matching_album: "没有找到匹配的相册",
  media_roots_unconfigured: "还没有配置媒体根目录",
  tag_not_found: "标签已不存在",
  // 访问与权限
  authentication_required: "需要重新验证访问令牌",
  invalid_access_token: "访问令牌不正确",
  local_access_required: "当前访问模式不允许该操作",
  directory_access_denied: "没有权限访问该目录",
  directory_not_found: "目录不存在",
  // 系统
  ai_module_unavailable:
    "本机识别模块或模型未就绪，请运行 AI 安装脚本并重启应用",
  ai_runtime_unavailable:
    "本机 AI 运行环境未就绪，请运行 AI 安装脚本并重启应用",
  ai_model_missing: "本机语义模型缺失或校验失败，请运行 AI 安装脚本",
  os_open_disabled: "当前环境不允许打开系统文件管理器",
  os_open_failed: "系统文件管理器未能打开",
  // 其它
  internal_error: "服务内部错误",
};

/**
 * 把后端错误翻译成给用户看的中文文案。
 *
 * @param error 捕获到的异常（ApiError 会按错误码查表）
 * @param fallback 未知错误码 / 非业务异常时的兜底文案
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const mapped = error.code ? CODE_MESSAGES[error.code] : undefined;
    if (mapped) return mapped;
  }
  return fallback;
}
