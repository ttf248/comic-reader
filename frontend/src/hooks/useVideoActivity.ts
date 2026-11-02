import { useCallback, useEffect, useRef, useState } from "react";
import { activityApi, isActivityNotFound } from "../api/activity";

// 视频阅读位置的生命周期。
//
// 视频进度与图片进度是两套模型：图片记页码（pageIndex/pageCount），视频记
// 毫秒位置（positionMs/durationMs），所以这里独立成一个 hook，不与图片的
// 页码持久化混在一起。
//
// 阶段（phase）是一个小状态机，决定"现在能不能写后端"：
//   pending  → 恢复查询进行中。只记本次会话的位置，不落盘，
//              否则自动播放产生的 timeupdate 会把用户已有的恢复点覆盖掉。
//   writable → 恢复完成（包括"服务端本来就没有记录"），允许落盘。
//   blocked  → 恢复失败，禁止落盘，等用户手动重试。
//
// 写入策略：播放过程中最多每 10 秒落盘一次；切换文件或卸载时用 keepalive
// 补写最后一个位置。

type VideoActivityPhase = "pending" | "writable" | "blocked";

interface VideoActivitySession {
  key: string;
  albumId: string;
  itemId: string;
  positionMs: number;
  durationMs: number;
  phase: VideoActivityPhase;
  dirty: boolean;
}

/** 两次落盘之间的最小间隔（毫秒）。 */
const WRITE_INTERVAL_MS = 10_000;

function flushSession(session: VideoActivitySession | null) {
  if (
    !session ||
    session.phase !== "writable" ||
    !session.dirty ||
    session.durationMs <= 0
  ) {
    return;
  }
  session.dirty = false;
  activityApi.keepalive({
    albumId: session.albumId,
    mediaKind: "video",
    itemId: session.itemId,
    positionMs: session.positionMs,
    durationMs: session.durationMs,
  });
}

export interface VideoActivityOptions {
  /** 是否处于视频模式。图片模式下整段逻辑不生效。 */
  isVideo: boolean;
  /** 相册资源 ID。 */
  albumId: string;
  /** 当前视频的资源 ID；视频模式下有值。 */
  itemId: string | undefined;
  /** 视频列表是否已加载完成。 */
  ready: boolean;
  /** 会话键：相册 + 文件。换片必须换键，否则会写到上一段视频上。 */
  activityKey: string;
  /** 恢复查询成功（含"没有记录"）。 */
  onRestored: () => void;
  /** 恢复查询失败。 */
  onRestoreFailed: () => void;
  /** 位置落盘成功。 */
  onSaved: () => void;
  /** 位置落盘失败。 */
  onSaveFailed: () => void;
}

export interface VideoActivity {
  /** 恢复位置（秒）。key 与当前会话一致时才有效。 */
  resume: { key: string; seconds?: number };
  /** 视频元数据就绪时上报时长。 */
  onMetaLoaded: (durationSec: number) => void;
  /** 播放进度更新。 */
  onProgress: (currentTimeSec: number) => void;
  /** 播放结束：把位置写满并立即落盘，返回是否真的发了请求。 */
  markCompleted: () => boolean;
  /** 重试保存当前位置；成功返回 true。 */
  retrySave: () => Promise<boolean>;
}

/**
 * 视频阅读位置：恢复 → 节流写入 → 补写。
 *
 * 组件只关心"从第几秒开始播"和"把进度交给我"，其余状态机都在这里。
 */
export function useVideoActivity({
  isVideo,
  albumId,
  itemId,
  ready,
  activityKey,
  onRestored,
  onRestoreFailed,
  onSaved,
  onSaveFailed,
}: VideoActivityOptions): VideoActivity {
  const [resume, setResume] = useState<{ key: string; seconds?: number }>({
    key: "",
  });
  const sessionRef = useRef<VideoActivitySession | null>(null);
  const lastWriteAtRef = useRef(0);

  // 回调放进 ref：调用方通常传内联箭头函数，每次渲染都是新引用。
  // 若把它们写进 effect 的依赖，恢复查询会被反复重启。
  const handlersRef = useRef({
    onRestored,
    onRestoreFailed,
    onSaved,
    onSaveFailed,
  });
  handlersRef.current = { onRestored, onRestoreFailed, onSaved, onSaveFailed };

  // 恢复查询：换片 / 换相册时重新建立会话，并查一次已有的播放位置。
  useEffect(() => {
    setResume({ key: "" });
    lastWriteAtRef.current = 0;
    if (!isVideo || !albumId || !itemId || !ready) {
      sessionRef.current = null;
      return;
    }
    const session: VideoActivitySession = {
      key: activityKey,
      albumId,
      itemId,
      positionMs: 0,
      durationMs: 0,
      phase: "pending",
      dirty: false,
    };
    sessionRef.current = session;
    let cancelled = false;
    activityApi
      .getVideo(albumId, itemId)
      .then((activity) => {
        if (cancelled || sessionRef.current !== session) return;
        const positionMs =
          activity.status === "completed" ? 0 : activity.positionMs;
        const durationMs = session.durationMs || activity.durationMs;
        session.positionMs = Math.min(positionMs, durationMs);
        session.durationMs = durationMs;
        session.phase = "writable";
        session.dirty = false;
        handlersRef.current.onRestored();
        lastWriteAtRef.current = Date.now();
        setResume({
          key: activityKey,
          seconds:
            session.positionMs > 0 ? session.positionMs / 1000 : undefined,
        });
      })
      .catch((error: unknown) => {
        if (cancelled || sessionRef.current !== session) return;
        if (isActivityNotFound(error)) {
          // 服务端没有这条记录：可以从头播，也允许写入。
          session.phase = "writable";
          session.dirty = false;
          handlersRef.current.onRestored();
          lastWriteAtRef.current = Date.now();
          setResume({ key: activityKey });
          return;
        }
        session.phase = "blocked";
        session.dirty = false;
        handlersRef.current.onRestoreFailed();
      });
    return () => {
      cancelled = true;
      if (sessionRef.current === session) flushSession(session);
    };
  }, [isVideo, albumId, itemId, ready, activityKey]);

  // 卸载 / 关闭页签时补写最后一个位置。keepalive 走 sendBeacon，页面正在
  // 卸载时也能送达。
  useEffect(() => {
    if (!isVideo) return;
    const flush = () => flushSession(sessionRef.current);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [isVideo]);

  const onMetaLoaded = useCallback(
    (durationSec: number) => {
      const session = sessionRef.current;
      if (!session || session.key !== activityKey) return;
      const durationMs = Math.max(1, Math.round(durationSec * 1000));
      session.durationMs = durationMs;
      session.positionMs = Math.min(session.positionMs, durationMs);
    },
    [activityKey],
  );

  const onProgress = useCallback(
    (currentTimeSec: number) => {
      const session = sessionRef.current;
      if (!session || session.key !== activityKey || session.durationMs <= 0) {
        return;
      }
      session.positionMs = Math.max(
        0,
        Math.min(session.durationMs, Math.round(currentTimeSec * 1000)),
      );
      // 查询完成前只记本次会话位置，不能用自动播放产生的 timeupdate
      // 覆盖服务端已有恢复点。
      if (session.phase !== "writable") return;
      session.dirty = true;
      const now = Date.now();
      if (now - lastWriteAtRef.current < WRITE_INTERVAL_MS) return;
      lastWriteAtRef.current = now;
      const savedPositionMs = session.positionMs;
      activityApi
        .setVideo(
          session.albumId,
          session.itemId,
          savedPositionMs,
          session.durationMs,
        )
        .then(() => {
          handlersRef.current.onSaved();
          if (
            sessionRef.current === session &&
            session.positionMs === savedPositionMs
          ) {
            session.dirty = false;
          }
        })
        .catch(() => handlersRef.current.onSaveFailed());
    },
    [activityKey],
  );

  const markCompleted = useCallback(() => {
    const session = sessionRef.current;
    if (
      !session ||
      session.key !== activityKey ||
      session.phase !== "writable" ||
      session.durationMs <= 0
    ) {
      return false;
    }
    session.positionMs = session.durationMs;
    session.dirty = true;
    const savedPositionMs = session.positionMs;
    activityApi
      .setVideo(
        session.albumId,
        session.itemId,
        savedPositionMs,
        session.durationMs,
      )
      .then(() => {
        handlersRef.current.onSaved();
        if (
          sessionRef.current === session &&
          session.positionMs === savedPositionMs
        ) {
          session.dirty = false;
        }
      })
      .catch(() => handlersRef.current.onSaveFailed());
    return true;
  }, [activityKey]);

  const retrySave = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || session.phase !== "writable" || session.durationMs <= 0) {
      return false;
    }
    const savedPosition = session.positionMs;
    try {
      await activityApi.setVideo(
        session.albumId,
        session.itemId,
        savedPosition,
        session.durationMs,
      );
      if (session.positionMs === savedPosition) session.dirty = false;
      handlersRef.current.onSaved();
      return true;
    } catch {
      handlersRef.current.onSaveFailed();
      return false;
    }
  }, []);

  return { resume, onMetaLoaded, onProgress, markCompleted, retrySave };
}
