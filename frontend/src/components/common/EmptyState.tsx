import type { ReactNode } from 'react'

interface Props {
  title: string
  description?: ReactNode
  action?: ReactNode
  icon?: ReactNode
  /**
   * 紧凑模式：下方还有内容（推荐位、说明列表）时用。
   * 默认的 52vh 最小高度是为"整页只有这一块"准备的；下面还接着内容时
   * 再撑 52vh，会把下面的东西推到首屏之外。
   */
  dense?: boolean
}

// 居中空态：图标 + 标题 + 描述 + 可选操作。
// 设计：上呼吸感大、字号克制、不画边框。
export default function EmptyState({
  title,
  description,
  action,
  icon,
  dense = false,
}: Props) {
  return (
    // page-shell：空态要和正文用同一条左基线与同一套左右留白。
    // 之前它直接挂在页面根节点上，水平居中的是"整个主区"而不是"内容列"，
    // 在有侧栏时整块空态会偏左（收藏页最明显）。
    <div
      className={`page-shell flex flex-col items-center justify-center py-14 text-center fade-up ${
        dense ? "min-h-[30vh] pb-8" : "min-h-[52vh]"
      }`}
    >
      {icon && (
        <div className="w-12 h-12 rounded-xl bg-bg-subtle flex items-center justify-center text-fg-muted mb-5">
          {icon}
        </div>
      )}
      <h2 className="font-display text-[18px] font-semibold text-fg">{title}</h2>
      {description && (
        <div className="text-[13.5px] text-fg-muted mt-2 max-w-md leading-relaxed">
          {description}
        </div>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}
