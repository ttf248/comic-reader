import type {
  AIJobEstimate,
  AIJobEstimateModule,
  AnalysisMode,
  AnalysisType,
} from "../../api/aiJobs";
import {
  formatCount,
  formatEstimateDuration,
  moduleReasonLabel,
  taskModeLabel,
} from "../../utils/taskFormat";
import { RefreshIcon } from "../common/Icon";

interface Props {
  estimate?: AIJobEstimate;
  loading: boolean;
  error: boolean;
  /** 当前选中的模块。 */
  module: AnalysisType;
  /** 当前选中的处理方式；表格里对应的那一行高亮。 */
  mode: AnalysisMode;
  onRefresh: () => void;
}

/**
 * 本次规模：启动之前先把「要处理多少张」和「大概要多久」摆出来。
 *
 * 增量与全量并排成两行而不是只给当前模式 —— 用户在两种口径之间做取舍时，
 * 需要同时看到代价。切模式不重新请求：一次核算把四个模块的两种口径都
 * 带来了。
 */
export default function TaskEstimatePanel({
  estimate,
  loading,
  error,
  module,
  mode,
  onRefresh,
}: Props) {
  if (loading) {
    return (
      <div>
        <p className="text-meta text-fg-subtle">正在核算本次规模…</p>
        <div className="mt-2 h-8 w-full animate-pulse rounded-lg bg-bg-subtle" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p role="status" className="text-meta text-warning">
          本次规模核算失败，仍可直接开始分析。
        </p>
        <button
          type="button"
          className="btn btn-sm btn-outline"
          onClick={onRefresh}
        >
          <RefreshIcon size={14} />
          重新核算
        </button>
      </div>
    );
  }

  if (!estimate) return null;

  if (!estimate.libraryReady) {
    return (
      <p className="text-meta text-fg-subtle">
        媒体库尚未就绪，完成扫描后再看本次规模。
      </p>
    );
  }

  const entry = estimate.modules.find((item) => item.type === module);
  if (!entry) return null;

  if (!entry.available) {
    return (
      <p className="text-meta text-fg-subtle">
        {entry.name}当前不可用：
        {moduleReasonLabel(entry.reason ?? "")}，无法核算本次规模。
      </p>
    );
  }

  const rows: { mode: AnalysisMode; value: ReturnType<typeof modeValue> }[] = [
    { mode: "incremental", value: modeValue(entry, "incremental") },
    { mode: "full", value: modeValue(entry, "full") },
  ];
  const active = rows.find((row) => row.mode === mode);

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-meta text-fg-subtle">本次规模</p>
        <p className="text-meta text-fg-muted">
          {entry.name}
          {entry.version ? ` · ${entry.version}` : ""} · 整库{" "}
          {formatCount(estimate.totalImages)} 张
        </p>
      </div>

      {/* 表格按内容收紧：三个列头各自挨着它的数字，摊满整幅会读成三处孤立的数据。 */}
      <div className="mt-2 w-fit max-w-full overflow-hidden rounded-lg border border-border-faint">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-border-faint bg-bg-subtle/50">
              <th
                scope="col"
                className="px-3.5 py-2 text-meta font-medium text-fg-subtle"
              >
                模式
              </th>
              <th
                scope="col"
                className="px-3.5 py-2 text-meta font-medium text-fg-subtle"
              >
                本次张数
              </th>
              <th
                scope="col"
                className="px-3.5 py-2 text-meta font-medium text-fg-subtle"
              >
                预计耗时
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const selected = row.mode === mode;
              return (
                <tr
                  key={row.mode}
                  className={
                    selected
                      ? "bg-brand-soft/50"
                      : "border-t border-border-faint"
                  }
                >
                  <th
                    scope="row"
                    className="px-3.5 py-2 text-label font-normal text-fg"
                  >
                    <span className="flex items-center gap-2">
                      {selected ? (
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                        />
                      ) : (
                        <span aria-hidden="true" className="w-1.5 shrink-0" />
                      )}
                      {taskModeLabel(row.mode)}
                    </span>
                  </th>
                  <td className="px-3.5 py-2 font-mono text-label tabular-nums text-fg">
                    {formatCount(row.value.count)} 张
                  </td>
                  <td className="px-3.5 py-2 font-mono text-label tabular-nums text-fg">
                    {formatEstimateDuration(row.value.estimatedDurationMs)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-meta text-fg-subtle">
        {active && active.value.sampleCount > 0
          ? `按最近 ${active.value.sampleCount} 次${entry.name}历史任务的速度估算，共 ${formatCount(active.value.sampleImages)} 张`
          : "这个模块还没有跑过，耗时算不出来"}
        {"；以启动时的实际清单为准。"}
      </p>
    </div>
  );
}

/** 取出某个模块在一种模式下的核算结果；缺数据时给一份空的。 */
function modeValue(
  entry: AIJobEstimateModule,
  mode: "incremental" | "full",
): {
  count: number;
  estimatedDurationMs: number | null;
  sampleCount: number;
  sampleImages: number;
} {
  const value = mode === "incremental" ? entry.incremental : entry.full;
  return (
    value ?? {
      count: 0,
      estimatedDurationMs: null,
      sampleCount: 0,
      sampleImages: 0,
    }
  );
}
