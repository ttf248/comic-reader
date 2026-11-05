import { useLocation } from 'react-router-dom'
import { useUIStore } from '../../store/uiStore'
import { isReaderPath } from '../../utils/path'
import { CloseIcon, InfoIcon, CheckIcon, AlertIcon } from './Icon'

// 全局轻量 Toast：右下角堆叠，单条可关闭，自动过期。
// 设计目标：替代散落的 alert / 静默失败，给关键操作一个反馈。
export default function ToastViewport() {
  const toasts = useUIStore((s) => s.toasts)
  const dismiss = useUIStore((s) => s.dismissToast)
  // 恒定深色的沉浸场景：沿用应用主题的浅色 toast 会变成"黑底里浮一块
  // 白板"，与场景里的其它浮层自相矛盾。
  //
  // 判断依据是「当前是不是在深色浮层里」，而不是路径前缀：照片墙的
  // 大图预览也是深色浮层，但它的路径不是 /read —— 早先按路径判断时，
  // 在预览里弹出的 toast 是一块浅色板。
  const { pathname } = useLocation()
  const immersiveOverlay = useUIStore((s) => s.immersiveOverlay)
  const dark = isReaderPath(pathname) || immersiveOverlay
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
            className={`pointer-events-auto flex items-center gap-3 backdrop-blur-xl rounded-lg px-3.5 py-2.5 shadow-lg min-w-[240px] max-w-[380px] fade-up text-body ${
              dark
                ? 'bg-overlay-panel border border-overlay-border text-overlay-fg'
                : 'bg-bg-elevated/95 border border-border'
            }`}
          >
            <Icon size={15} className={`shrink-0 ${dark ? 'text-white/60' : 'text-fg-muted'}`} />
            <div className="flex-1 leading-snug">{t.message}</div>
            <button
              onClick={() => dismiss(t.id)}
              className={`shrink-0 inline-flex h-7 w-7 items-center justify-center rounded transition-colors ${
                dark
                  ? 'text-white/50 hover:text-white hover:bg-white/10'
                  : 'text-fg-subtle hover:text-fg hover:bg-bg-subtle'
              }`}
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
