import type { AIJobModule } from "../../api/aiJobs";

interface Props {
  modules: AIJobModule[];
}

/** 已安装与尚未安装的分析模块。清单来自后端注册的模块，不是前端写死的文案。 */
export default function ModuleList({ modules }: Props) {
  if (modules.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="text-meta text-fg-subtle">分析模块</span>
      {modules.map((module) => (
        <span
          key={module.type}
          title={module.reason ? moduleReason(module.reason) : undefined}
          className="inline-flex items-center gap-1.5 rounded-full border border-border-faint px-2.5 py-1 text-meta"
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${
              module.installed ? "bg-success" : "bg-bg-strong"
            }`}
          />
          <span className={module.installed ? "text-fg" : "text-fg-subtle"}>
            {module.name}
          </span>
          <span className="font-mono text-fg-subtle">
            {module.installed
              ? module.version
              : module.reason
                ? moduleReason(module.reason)
                : "未安装"}
          </span>
        </span>
      ))}
    </div>
  );
}

function moduleReason(reason: string): string {
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
    default:
      return "未安装";
  }
}
