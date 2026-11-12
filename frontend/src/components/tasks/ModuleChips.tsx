import type { AIJobModule, AnalysisType } from "../../api/aiJobs";
import { moduleReasonLabel } from "../../utils/taskFormat";

interface Props {
  modules: AIJobModule[];
  /** 选中的模块；单选时长度为 1，多选时是勾选集合。 */
  selected: AnalysisType[];
  onToggle: (type: AnalysisType) => void;
  disabled?: boolean;
  /** 额外锁住的模块（如人物分析尚未启用）。 */
  locked?: AnalysisType[];
  /** 分组的无障碍名称；同页有多组芯片时用来区分。 */
  label?: string;
}

/**
 * 分析模块芯片。
 *
 * 模块原先藏在下拉框里：打开才知道装了哪些、哪些没装好。芯片把全部模块
 * 一次摆出来 —— 就绪的带绿点、选中的高亮、没装的灰着并写明原因，选模块
 * 变成一次点击而不是「打开菜单 → 找一项 → 确认」。
 */
export default function ModuleChips({
  modules,
  selected,
  onToggle,
  disabled = false,
  locked = [],
  label = "分析模块",
}: Props) {
  if (modules.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label={label}
    >
      {modules.map((module) => {
        const isSelected = selected.includes(module.type);
        const isLocked = locked.includes(module.type);
        const isDisabled = disabled || !module.installed || isLocked;
        const note = !module.installed
          ? moduleReasonLabel(module.reason ?? "")
          : isLocked
            ? "需先启用人物分析"
            : (module.version ?? "");
        return (
          <button
            key={module.type}
            type="button"
            aria-pressed={isSelected}
            disabled={isDisabled}
            onClick={() => onToggle(module.type)}
            title={note ? `${module.name} · ${note}` : module.name}
            className={[
              "inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-meta transition-colors",
              isSelected
                ? "border-brand/50 bg-brand-soft/60 text-fg"
                : "border-border-faint text-fg-muted hover:border-border hover:bg-bg-subtle",
              isDisabled ? "cursor-not-allowed opacity-55 hover:border-border-faint hover:bg-transparent" : "",
            ].join(" ")}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                module.installed ? "bg-success" : "bg-bg-strong"
              }`}
            />
            <span className={isSelected ? "font-medium" : ""}>{module.name}</span>
          </button>
        );
      })}
    </div>
  );
}
