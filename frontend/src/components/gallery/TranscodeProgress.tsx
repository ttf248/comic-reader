import { useEffect, useState, useCallback, useRef } from 'react'
import {
  subscribeTranscodeEvents,
  cancelTranscode,
  type TranscodeStatus,
  type TranscodeStatusValue,
} from '../../api/videos'

interface Props {
  /** 视频绝对路径 */
  src: string
  /** 转码完成（cached）时触发 —— 父组件用这个重挂载 <video> */
  onReady?: () => void
  /** 用户主动关闭面板 */
  onDismiss?: () => void
}

// 文案映射：状态 → 给人看的标题 + 描述
const STATUS_TEXT: Record<TranscodeStatusValue, { title: string; desc?: string }> = {
  unknown: { title: '正在准备…' },
  skipped: { title: '无需转码' },
  unavailable: { title: '服务端转码不可用', desc: 'ffmpeg 未配置或不可执行' },
  not_needed: { title: '视频已可直接播放' },
  cached: { title: '转码完成', desc: '即将开始播放…' },
  queued: { title: '正在排队…', desc: '前面还有别的视频在转码' },
  running: { title: '正在转码', desc: '服务端正在把视频转成浏览器能播的格式' },
  failed: { title: '转码失败' },
  pending: { title: '正在准备转码…', desc: '开始播放后会自动转码' },
}

/**
 * 转码进度面板 — 盖在 <video> 上面，给用户「正在转码 X% 预计还要 Y 分钟」
 * 的反馈。
 *
 * 订阅 /api/videos/transcode/events 的 SSE 流;当 status 变 cached 时
 * 调 onReady() 让父组件重新挂载 <video>（这样浏览器会重新发请求，
 * 这次后端会发转码后的文件）。
 *
 * 失败时显示错误 + 「重试」按钮（重新触发 transcode —— Resolve 在
 * cache miss 时会自动重转）。
 */
export default function TranscodeProgress({ src, onReady, onDismiss }: Props) {
  const [status, setStatus] = useState<TranscodeStatus | null>(null)
  // 用户主动取消：服务端把任务标记成 failed，但那是用户自己的选择，
  // 不能显示成「转码失败」。这里单独记住取消动作，给出「已取消」的文案。
  const [cancelled, setCancelled] = useState(false)
  // 父组件每次渲染都会新建 onReady（内联箭头函数）。若把它放进依赖数组，
  // 订阅会在每次父组件重渲染时重建：面板状态被清空、进度连接反复重连。
  // 这里用 ref 持有最新回调，effect 只依赖 src。
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

  useEffect(() => {
    setStatus(null)
    setCancelled(false)
    let closed = false
    let close: (() => void) | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retries = 0

    const connect = () => {
      if (closed) return
      close = subscribeTranscodeEvents(src, {
        onProgress: (s) => {
          // 剩余时间由服务端按「已耗时 × 剩余比例」估算(etaSec);
          // 进度刚开始时服务端给 0,此时不显示预计时间。
          setStatus(s)
        },
        onDone: (s) => {
          setStatus(s)
          if (s.status === 'cached') {
            onReadyRef.current?.()
            return
          }
          // pending：视频需要转码但任务还没起来（转码由媒体请求触发）。
          // 服务端此时没有可订阅的任务，连接会立刻关闭——稍后重连一次，
          // 等任务真正开始后就能收到进度。
          if (s.status === 'pending' && retries < 10) {
            retries += 1
            retryTimer = setTimeout(connect, 800)
          }
        },
      })
    }

    connect()
    return () => {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      close?.()
    }
  }, [src])

  const onCancel = useCallback(async () => {
    await cancelTranscode(src)
    setCancelled(true)
  }, [src])

  if (cancelled) {
    return (
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="max-w-md mx-4 bg-black/85 text-white/90 text-body px-5 py-4 rounded-lg flex flex-col items-center gap-3 pointer-events-auto min-w-[320px]">
          <div className="font-medium text-label">已取消转码</div>
          <div className="text-meta text-white/60 text-center">
            已停止服务端的转码任务；重新转码会从头开始。
          </div>
          <div className="flex items-center gap-2 mt-1">
            <button
              type="button"
              className="text-meta px-3 py-1 rounded border border-white/30 hover:bg-white/10"
              onClick={() => {
                setCancelled(false)
                // 重挂 <video> 会重新请求媒体，服务端随之重新排队转码。
                onReady?.()
              }}
            >
              重新转码
            </button>
            {onDismiss && (
              <button
                type="button"
                className="text-meta px-3 py-1 rounded text-white/60 hover:text-white/90"
                onClick={onDismiss}
              >
                关闭
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="bg-black/70 text-white/85 text-body px-4 py-3 rounded-md">
          正在连接转码服务…
        </div>
      </div>
    )
  }

  const text = STATUS_TEXT[status.status] || STATUS_TEXT.unknown
  const pct = Math.round(status.progress * 100)
  const etaSec = status.etaSec ?? 0

  // 终态（cached / failed / unavailable）:不一样的展示
  if (status.status === 'cached') {
    return null // 父组件已收到 onReady,马上会重挂 <video>,不再叠这层
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div className="max-w-md mx-4 bg-black/85 text-white/90 text-body px-5 py-4 rounded-lg flex flex-col items-center gap-3 pointer-events-auto min-w-[320px]">
        {/* 标题 */}
        <div className="font-medium text-label">{text.title}</div>
        {/* 描述 */}
        {text.desc && <div className="text-meta text-white/60 text-center">{text.desc}</div>}

        {/* 进度条（running/queued 时显示）*/}
        {(status.status === 'running' || status.status === 'queued') && (
          <>
            <div className="w-full h-1.5 bg-white/15 rounded-full overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="text-meta text-white/70 tabular-nums">
              {status.status === 'queued' ? '等待中' : `${pct}%`}
              {etaSec > 0 && ` · 预计 ${Math.ceil(etaSec / 60)} 分钟`}
            </div>
          </>
        )}

        {/* 失败 */}
        {status.status === 'failed' && (
          <div className="text-meta text-overlay-danger text-center max-w-xs break-words">
            {status.error || '未知错误'}
          </div>
        )}

        {/* 按钮 */}
        <div className="flex items-center gap-2 mt-1">
          {status.status === 'running' || status.status === 'queued' ? (
            <button
              type="button"
              className="text-meta px-3 py-1 rounded border border-white/30 hover:bg-white/10"
              onClick={onCancel}
            >
              取消转码
            </button>
          ) : status.status === 'failed' ? (
            <button
              type="button"
              className="text-meta px-3 py-1 rounded border border-white/30 hover:bg-white/10"
              onClick={() => {
                // 重新触发：重挂载 <video> 就会重新走 Resolve
                onReady?.()
              }}
            >
              重试
            </button>
          ) : null}
          {onDismiss && (
            <button
              type="button"
              className="text-meta px-3 py-1 rounded text-white/60 hover:text-white/90"
              onClick={onDismiss}
            >
              关闭
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
