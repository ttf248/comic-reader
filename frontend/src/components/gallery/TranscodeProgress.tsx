import { useEffect, useState, useCallback } from 'react'
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
  const [etaSec, setEtaSec] = useState<number>(0)

  useEffect(() => {
    setStatus(null)
    setEtaSec(0)
    let closed = false
    let close: (() => void) | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retries = 0

    const connect = () => {
      if (closed) return
      close = subscribeTranscodeEvents(src, {
        onProgress: (s) => {
          setStatus(s)
          // 简单 ETA 估算：拿最近两次 progress 差算速率
          // V1 不做精细实现(等下个版本接 ffmpeg out_time_ms 算精确 ETA)
        },
        onDone: (s) => {
          setStatus(s)
          if (s.status === 'cached') {
            onReady?.()
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
  }, [src, onReady])

  const onCancel = useCallback(async () => {
    await cancelTranscode(src)
  }, [src])

  if (!status) {
    return (
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="bg-black/70 text-white/85 text-sm px-4 py-3 rounded-md">
          正在连接转码服务…
        </div>
      </div>
    )
  }

  const text = STATUS_TEXT[status.status] || STATUS_TEXT.unknown
  const pct = Math.round(status.progress * 100)

  // 终态（cached / failed / unavailable）:不一样的展示
  if (status.status === 'cached') {
    return null // 父组件已收到 onReady,马上会重挂 <video>,不再叠这层
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div className="max-w-md mx-4 bg-black/85 text-white/90 text-sm px-5 py-4 rounded-lg flex flex-col items-center gap-3 pointer-events-auto min-w-[320px]">
        {/* 标题 */}
        <div className="font-medium text-base">{text.title}</div>
        {/* 描述 */}
        {text.desc && <div className="text-xs text-white/60 text-center">{text.desc}</div>}

        {/* 进度条（running/queued 时显示）*/}
        {(status.status === 'running' || status.status === 'queued') && (
          <>
            <div className="w-full h-1.5 bg-white/15 rounded-full overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="text-xs text-white/70 tabular-nums">
              {status.status === 'queued' ? '等待中' : `${pct}%`}
              {etaSec > 0 && ` · 预计 ${Math.ceil(etaSec / 60)} 分钟`}
            </div>
          </>
        )}

        {/* 失败 */}
        {status.status === 'failed' && (
          <div className="text-xs text-red-300/90 text-center max-w-xs break-words">
            {status.error || '未知错误'}
          </div>
        )}

        {/* 按钮 */}
        <div className="flex items-center gap-2 mt-1">
          {status.status === 'running' || status.status === 'queued' ? (
            <button
              type="button"
              className="text-xs px-3 py-1 rounded border border-white/30 hover:bg-white/10"
              onClick={onCancel}
            >
              取消转码
            </button>
          ) : status.status === 'failed' ? (
            <button
              type="button"
              className="text-xs px-3 py-1 rounded border border-white/30 hover:bg-white/10"
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
              className="text-xs px-3 py-1 rounded text-white/60 hover:text-white/90"
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
