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
            {module.installed ? module.version : "未安装"}
          </span>
        </span>
      ))}
    </div>
  );
}
