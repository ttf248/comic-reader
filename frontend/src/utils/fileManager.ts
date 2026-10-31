import { ApiError } from "../api/client";

// 只把业务错误映射为提示，不把原始响应或本地路径写入通知状态。
export function fileManagerErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "os_open_disabled":
        return "请先在设置中允许打开系统文件管理器";
      case "local_access_required":
        return "请在运行服务的计算机上打开系统文件管理器";
      case "resource_not_found":
        return "此资源已失效，请重新扫描后重试";
      case "config_path_not_allowed":
        return "此目录尚未保存到配置，请保存后重试";
      case "invalid_resource_kind":
        return "此项目不是本地目录";
      case "os_open_failed":
        return "系统文件管理器未能打开，请确认目录仍可用后重试";
    }
  }
  return "打开失败，请稍后重试";
}
