import type { ReactNode } from "react";

interface Props {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  /**
   * 紧凑模式：下方还有内容（推荐位、说明列表）时用。
   * 默认的 52vh 最小高度是为"整页只有这一块"准备的；下面还接着内容时
   * 再撑 52vh，会把下面的东西推到首屏之外。
   */
  dense?: boolean;
}

// 居中空态：图标 + 标题 + 描述 + 可选操作。
export default function EmptyState({
  title,
  description,
  action,
  icon,
  dense = false,
}: Props) {
  return (
    <div
      className={`page-shell empty-state flex flex-col items-center justify-center py-14 text-center fade-up ${
        dense ? "min-h-[30vh] pb-8" : "min-h-[52vh]"
      }`}
    >
      {icon && (
        <div className="empty-state__icon flex items-center justify-center mb-6">
          {icon}
        </div>
      )}
      <h2 className="font-display text-page-sm font-semibold text-fg">
        {title}
      </h2>
      {description && (
        <div className="text-body text-fg-muted mt-2 max-w-md leading-relaxed">
          {description}
        </div>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
