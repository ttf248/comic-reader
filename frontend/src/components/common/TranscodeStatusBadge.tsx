import { useEffect, useState } from "react";
import {
  getTranscodeStatus,
  type TranscodeStatus,
  type TranscodeStatusValue,
} from "../../api/videos";

interface Props {
  /** 视频文件资源 ID */
  videoPath: string;
  /** 卡片尺寸: sm = album card(小), lg = hover preview(大) */
  size?: "sm" | "lg";
  /** 轮询间隔(毫秒);默认 3s。Phase 3 改成 SSE 后会去掉这个 */
  pollIntervalMs?: number;
}

const SIZE_CLASS = {
  sm: { box: "h-4 px-1 text-[9px] gap-0.5", icon: 8 },
  lg: { box: "h-5 px-1.5 text-[10px] gap-1", icon: 10 },
} as const;

// 状态 → 用户可见的简短文本 + 颜色
// running / queued → 蓝色 (处理中)
// cached → 绿色 (完成,直接隐藏就行;这里主要是兜底)
// failed → 红色
const STATUS_STYLE: Record<
  TranscodeStatusValue,
  { text: string; cls: string } | null
> = {
  unknown: null,
  skipped: null,
  unavailable: null,
  not_needed: null,
  cached: null, // 缓存命中时直接不显示
  queued: { text: "排队", cls: "bg-blue-500/85 text-white" },
  running: { text: "转码中", cls: "bg-blue-500/85 text-white" },
  failed: { text: "转码失败", cls: "bg-red-500/85 text-white" },
  // pending：需要转码但还没开始（按需触发，播放时才启动）。
  // 这不是故障，不显示角标。
  pending: null,
};

/**
 * 视频卡片上的转码状态小角标。
 *
 * 仅在服务端 ffmpeg 可用且视频需要转码时显示:
 *   - 蓝色 "转码中"  / "排队"
 *   - 红色 "转码失败"
 *   - 绿色 "已缓存" (V1 简化为不显示,既然已经缓存就不打扰用户)
 *
 * V1 用轮询 (3s 一次) 查 /status;Phase 3 换 SSE 后再去掉 pollIntervalMs。
 */
export default function TranscodeStatusBadge({
  videoPath,
  size = "sm",
  pollIntervalMs = 3000,
}: Props) {
  const [status, setStatus] = useState<TranscodeStatus | null>(null);

  useEffect(() => {
    if (!videoPath) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const s = await getTranscodeStatus(videoPath);
        if (!cancelled) setStatus(s);
      } catch {
        // status 端点失败 → 当作没服务,隐藏
        if (!cancelled) setStatus(null);
      }
      if (!cancelled) {
        timer = setTimeout(tick, pollIntervalMs);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [videoPath, pollIntervalMs]);

  if (!status) return null;
  const style = STATUS_STYLE[status.status];
  if (!style) return null;

  const sz = SIZE_CLASS[size];
  const pct = Math.round(status.progress * 100);

  return (
    <div
      className={`inline-flex items-center rounded-md font-medium ${sz.box} ${style.cls}`}
      title={status.error || style.text}
    >
      <span>{style.text}</span>
      {status.status === "running" && pct > 0 && (
        <span className="tabular-nums opacity-80">{pct}%</span>
      )}
    </div>
  );
}
