import type { AIJobModule } from "../../api/aiJobs";
import Toggle from "../common/Toggle";
import ModuleList from "./ModuleList";

interface Props {
  enabled: boolean;
  time: string;
  /** 服务器设置还没到之前不允许编辑。 */
  ready: boolean;
  onEnabledChange: (value: boolean) => void;
  onTimeChange: (value: string) => void;
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
  ready,
  onEnabledChange,
  onTimeChange,
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

        <button className="btn btn-outline" type="submit" disabled={disabled}>
          {saving ? "保存中…" : "保存计划"}
        </button>

        <span className="text-meta text-fg-subtle">
          {lastScheduledDate
            ? `上次运行 ${lastScheduledDate}`
            : "尚未自动运行过"}
        </span>

        {saved ? <span className="text-meta text-fg-muted">已保存</span> : null}
        {error ? (
          <p role="alert" className="text-meta text-danger">
            保存失败，请检查时间后重试。
          </p>
        ) : null}
      </form>

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-border-faint px-5 py-3.5 sm:px-6">
        <p className="text-meta leading-relaxed text-fg-subtle">
          按服务所在设备的本地时间运行；错过计划时间后，下次启动会补跑一次。
        </p>
        <ModuleList modules={modules} />
      </div>
    </div>
  );
}
