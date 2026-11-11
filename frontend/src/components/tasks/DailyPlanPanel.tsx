import type { AIJobModule, AnalysisType } from "../../api/aiJobs";
import Toggle from "../common/Toggle";
import ModuleList from "./ModuleList";

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

/** 每日增量计划：一条紧凑的设置条，不做成独立表单。 */
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
  return (
    <div className="rounded-lg border border-border bg-bg-elevated shadow-xs">
      <form
        className="flex flex-wrap items-center gap-x-6 gap-y-4 px-5 py-4 sm:px-6"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <div className="flex items-center gap-3">
          <Toggle
            label="每天自动检查变化"
            checked={enabled}
            disabled={disabled}
            onChange={onEnabledChange}
          />
          <span className="text-body text-fg">每天自动检查变化</span>
        </div>

        <label className="flex items-center gap-3 text-meta text-fg-muted">
          <span>开始时间</span>
          <input
            type="time"
            value={time}
            disabled={disabled}
            onChange={(event) => onTimeChange(event.target.value)}
            className="rounded-md border border-border bg-bg-elevated px-3 py-2 text-body text-fg disabled:opacity-60"
            aria-label="每日分析开始时间"
          />
        </label>

        <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2 text-meta text-fg-muted">
          <legend className="sr-only">每日分析模块</legend>
          <span aria-hidden="true">运行模块</span>
          {modules
            .filter((module) => module.installed)
            .map((module) => (
              <label
                key={module.type}
                className="inline-flex items-center gap-2 text-fg"
              >
                <input
                  type="checkbox"
                  checked={selectedModules.includes(module.type)}
                  disabled={
                    disabled || (module.type === "face" && !peopleEnabled)
                  }
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [...selectedModules, module.type]
                      : selectedModules.filter((type) => type !== module.type);
                    onModulesChange(next);
                  }}
                />
                {module.name}
              </label>
            ))}
        </fieldset>

        <label className="flex items-center gap-2 text-meta text-fg">
          <input
            type="checkbox"
            checked={peopleEnabled}
            disabled={disabled}
            onChange={(event) => onPeopleEnabledChange(event.target.checked)}
          />
          启用人物分析（默认关闭）
        </label>

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
      </form>

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-border-faint px-5 py-3.5 sm:px-6">
        <p className="text-meta leading-relaxed text-fg-subtle">
          分析仅在本机处理。人物分析需显式启用；关闭后将从每日计划移除。按设备本地时间运行，错过计划时间后会补跑一次。
        </p>
        <ModuleList modules={modules} />
      </div>
    </div>
  );
}
