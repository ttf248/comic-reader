import { useUIStore } from '../../store/uiStore'
import { CloseIcon, InfoIcon, CheckIcon, AlertIcon } from './Icon'

// 全局轻量 Toast：右下角堆叠，单条可关闭，自动过期。
// 设计目标：替代散落的 alert / 静默失败，给关键操作一个反馈。
export default function ToastViewport() {
  const toasts = useUIStore((s) => s.toasts)
  const dismiss = useUIStore((s) => s.dismissToast)
  if (!toasts.length) return null
  return (
    <div
      className="fixed bottom-12 right-5 z-[60] flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const Icon = t.kind === 'success' ? CheckIcon : t.kind === 'error' ? AlertIcon : InfoIcon
        return (
          <div
            key={t.id}
            className="pointer-events-auto flex items-center gap-3 bg-bg-elevated/95 backdrop-blur-xl border border-border rounded-lg px-3.5 py-2.5 shadow-lg min-w-[240px] max-w-[380px] fade-up text-[13px]"
          >
            <Icon size={15} className="shrink-0 text-fg-muted" />
            <div className="flex-1 leading-snug">{t.message}</div>
            <button
              onClick={() => dismiss(t.id)}
              className="text-fg-subtle hover:text-fg shrink-0 p-0.5 rounded hover:bg-bg-subtle"
              aria-label="关闭"
            >
              <CloseIcon size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
