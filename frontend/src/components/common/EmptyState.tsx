import type { ReactNode } from 'react'

interface Props {
  title: string
  description?: ReactNode
  action?: ReactNode
  icon?: ReactNode
}

// 居中空态：图标 + 标题 + 描述 + 可选操作。
// 设计：上呼吸感大、字号克制、不画边框。
export default function EmptyState({ title, description, action, icon }: Props) {
  return (
    // page-shell：空态要和正文用同一条左基线与同一套左右留白。
    // 之前它直接挂在页面根节点上，水平居中的是"整个主区"而不是"内容列"，
    // 在有侧栏时整块空态会偏左（收藏页最明显）。
    <div className="page-shell flex flex-col items-center justify-center min-h-[52vh] py-14 text-center fade-up">
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
