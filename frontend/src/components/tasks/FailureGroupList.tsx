import type { AIJobError } from "../../api/aiJobs";
import CopyButton from "../common/CopyButton";
import { ChevronDownIcon } from "../common/Icon";
import { groupFailures } from "../../utils/taskFormat";

/** 每组最多列出的路径条数；其余只给一条计数。 */
const VISIBLE_LIMIT = 20;

interface Props {
  errors?: AIJobError[];
}

/**
 * 失败项按原因分组。
 *
 * 同一个原因动辄几十条，逐条铺开只是一堆重复文本；先看到「哪一类坏了、
 * 坏了几张」，需要时再展开看具体路径。
 */
export default function FailureGroupList({ errors }: Props) {
  const groups = groupFailures(errors);
  if (groups.length === 0) return null;

  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <details
          key={`${group.code}-${group.message}`}
          className="group rounded-lg border border-border-faint"
          data-testid="task-failure-group"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-2.5 text-meta [&::-webkit-details-marker]:hidden">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-fg">{group.message}</span>
              <span className="shrink-0 tabular-nums text-fg-subtle">
                · {group.items.length} 项
              </span>
            </span>
            <ChevronDownIcon
              size={14}
              className="shrink-0 text-fg-subtle transition-transform group-open:rotate-180"
            />
          </summary>
          <ul className="border-t border-border-faint px-3.5 py-2">
            {group.items.slice(0, VISIBLE_LIMIT).map((item, index) => (
              <li
                key={`${item.resourceId}-${index}`}
                className="flex items-center gap-2 py-1"
              >
                <span
                  className="min-w-0 flex-1 truncate font-mono text-meta text-fg-muted"
                  title={item.path || item.resourceId}
                >
                  {item.path || "当前媒体库中不可用"}
                </span>
                <CopyButton
                  value={item.path || item.resourceId}
                  title="复制路径"
                />
              </li>
            ))}
            {group.items.length > VISIBLE_LIMIT ? (
              <li className="py-1 text-meta text-fg-subtle">
                …还有 {group.items.length - VISIBLE_LIMIT} 条
              </li>
            ) : null}
          </ul>
        </details>
      ))}
    </div>
  );
}
