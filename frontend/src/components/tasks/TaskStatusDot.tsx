import type { AIJob } from "../../api/aiJobs";

interface Props {
  status: AIJob["status"] | "idle";
  className?: string;
}

const DOT_CLASS: Record<string, string> = {
  running: "bg-accent status-dot--running",
  completed: "bg-success",
  failed: "bg-danger",
  pending: "bg-fg-subtle",
  paused: "bg-fg-muted",
  cancelled: "bg-fg-subtle",
  idle: "bg-bg-strong",
};

/** 任务状态点：颜色之外还有形状与动效，不靠颜色单独传达状态。 */
export default function TaskStatusDot({ status, className = "" }: Props) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
        DOT_CLASS[status] ?? "bg-fg-subtle"
      } ${className}`}
    />
  );
}
