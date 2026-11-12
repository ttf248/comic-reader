import type { AIJobModule, AnalysisType } from "../../api/aiJobs";
import Toggle from "../common/Toggle";
import ModuleChips from "./ModuleChips";

interface Props {
  enabled: boolean;
  time: string;
  selectedModules: AnalysisType[];
  peopleEnabled: boolean;
  /** 服务器设置还没到之前不允许编辑。 */
  ready: boolean;
  onEnabledChange: (value: boolean) => void;
  onTimeChange: (value: string) => void;
  onModulesChange: (value: AnalysisType[]) => void;
  onPeopleEnabledChange: (value: boolean) => void;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
  error: boolean;
  /** 后端记录的上次计划执行日期。 */
  lastScheduledDate?: string;
  modules: AIJobModule[];
}

/**
 * 每日增量计划：一条紧凑的设置条，不做成独立表单。
 *
 * 模块选择用芯片而不是一串复选框标签 —— 复选框排成一行时每个都是同样
 * 权重的一小块，看不出哪些被选中了；芯片把选中态直接染出来。
 */
export default function DailyPlanPanel({
  enabled,
  time,
  selectedModules,
  peopleEnabled,
  ready,
  onEnabledChange,
  onTimeChange,
  onModulesChange,
  onPeopleEnabledChange,
  onSave,
  saving,
  saved,
  error,
  lastScheduledDate,
  modules,
}: Props) {
  const disabled = !ready || saving;

  function toggleModule(type: AnalysisType) {
    const next = selectedModules.includes(type)
      ? selectedModules.filter((item) => item !== type)
      : [...selectedModules, type];
    onModulesChange(next);
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-xs">
      <form
        className="space-y-4 px-5 py-4 sm:px-6"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <label className="flex items-center gap-3">
            <Toggle
              label="每天自动检查变化"
              checked={enabled}
              disabled={disabled}
              onChange={onEnabledChange}
            />
            <span className="text-body text-fg">每天自动检查变化</span>
          </label>

          <label className="flex items-center gap-2 text-meta text-fg-muted">
            <span>开始时间</span>
            <input
              type="time"
              value={time}
              disabled={disabled}
              onChange={(event) => onTimeChange(event.target.value)}
              className="rounded-md border border-border bg-bg-elevated px-2.5 py-1.5 text-body text-fg disabled:opacity-60"
              aria-label="每日分析开始时间"
            />
          </label>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-start xl:gap-8">
          <div className="min-w-0">
            <p className="text-meta text-fg-subtle">运行模块</p>
            <div className="mt-2">
              <ModuleChips
                modules={modules}
                selected={selectedModules}
                onToggle={toggleModule}
                disabled={disabled}
                locked={peopleEnabled ? [] : ["face"]}
                label="运行模块"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-meta text-fg">
            <input
              type="checkbox"
              checked={peopleEnabled}
              disabled={disabled}
              onChange={(event) => onPeopleEnabledChange(event.target.checked)}
            />
            启用人物分析（默认关闭）
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border-faint pt-4">
          <button
            className="btn btn-outline"
            type="submit"
            disabled={disabled || (enabled && selectedModules.length === 0)}
          >
            {saving ? "保存中…" : "保存计划"}
          </button>
          <span className="text-meta text-fg-subtle">
            {lastScheduledDate
              ? `上次运行 ${lastScheduledDate}`
              : "尚未自动运行过"}
          </span>
          {saved ? <span className="text-meta text-fg-muted">已保存</span> : null}
          {enabled && selectedModules.length === 0 ? (
            <span className="text-meta text-fg-muted">
              自动运行至少选择一个已安装模块。
            </span>
          ) : null}
          {error ? (
            <p role="alert" className="text-meta text-danger">
              保存失败，请检查时间后重试。
            </p>
          ) : null}
        </div>
      </form>

      <p className="border-t border-border-faint px-5 py-3 text-meta leading-relaxed text-fg-subtle sm:px-6">
        分析仅在本机处理，按设备本地时间运行；错过计划时间后会补跑一次。
      </p>
    </div>
  );
}
