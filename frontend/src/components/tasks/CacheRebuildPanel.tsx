import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshIcon } from "../common/Icon";
import { ApiError } from "../../api/client";
import { cacheApi, type CacheRebuildScope } from "../../api/cache";
import { useCacheRebuild } from "../../hooks/useCacheRebuild";
import { useUIStore } from "../../store/uiStore";

/**
 * 预览图重建的档位宽度。
 *
 * 1280 够沉浸式查看器在 2 倍屏上用；再往上按需生成即可 —— 全库预生成
 * 一份 2560 宽的预览图要几 GB 磁盘，而多数照片本来就没有那么宽。
 */
const PREVIEW_WIDTH = 1280;

const SCOPE_LABEL: Record<CacheRebuildScope, string> = {
  thumbs: "缩略图",
  previews: "预览图",
};

function message(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === "invalid_rebuild_scope") return "重建范围不正确。";
    if (error.code === "missing_rebuild_scope")
      return "请至少选择一类要重建的缓存。";
    if (error.code === "library_not_ready")
      return "媒体库尚未就绪，请先完成扫描。";
  }
  return "操作失败，请重试。";
}

/**
 * 缓存重建面板。
 *
 * 清空缓存后渲染图要重新生成，而渲染图是懒生成的：不清重建，第一次打开
 * 每一页都要在请求里同步重算，整页图片卡住。这里把重建提到后台任务，
 * 有进度、能取消，也不占住浏览路径。
 */
export default function CacheRebuildPanel() {
  const client = useQueryClient();
  const pushToast = useUIStore((s) => s.pushToast);
  const rebuild = useCacheRebuild();
  // 默认两类都重建：渲染图与预览图都是懒生成的，清空后不重建就得
  // 靠浏览路径现算。预览图那一档很占磁盘，界面上写清楚了代价。
  const [scopes, setScopes] = useState<CacheRebuildScope[]>([
    "thumbs",
    "previews",
  ]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  const toggle = (scope: CacheRebuildScope) => {
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((item) => item !== scope)
        : [...current, scope],
    );
  };

  async function startRebuild(clearFirst: boolean) {
    if (scopes.length === 0) {
      setError("请至少选择一类要重建的缓存。");
      return;
    }
    setStarting(true);
    setError("");
    try {
      if (clearFirst) {
        await cacheApi.clearCache(scopes.length === 1 ? scopes[0] : "all");
        client.invalidateQueries({ queryKey: ["cache-stats"] });
      }
      const started = await cacheApi.startRebuild(
        scopes,
        scopes.includes("previews") ? PREVIEW_WIDTH : undefined,
      );
      rebuild.start(started.jobId);
      pushToast({
        kind: "info",
        message: started.reused ? "重建已在进行中，接入现有任务" : "重建已开始",
      });
    } catch (err) {
      setError(message(err));
    } finally {
      setStarting(false);
    }
  }

  async function cancelRebuild() {
    if (!rebuild.jobId) return;
    try {
      await cacheApi.cancelRebuild(rebuild.jobId);
      pushToast({ kind: "info", message: "已请求取消重建" });
    } catch (err) {
      setError(message(err));
    }
  }

  const progress = rebuild.progress;
  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : 0;

  return (
    <section
      aria-labelledby="cache-rebuild-heading"
      className="settings-section"
    >
      <div className="settings-section__heading">
        <span className="settings-section__icon text-fg-muted">
          <RefreshIcon size={13} />
        </span>
        <h2 id="cache-rebuild-heading" className="section-title">
          缓存重建
        </h2>
        <span className="section-rule" />
      </div>
      <div className="settings-section__body p-5 space-y-4">
        <p className="text-body text-fg-muted">
          渲染图是懒生成的：清空之后要重新生成，否则第一次打开每一页都要现算，
          整页图片会卡住。重建在后台跑，有进度也能中途取消。
        </p>

        <fieldset className="space-y-2">
          <legend className="text-meta text-fg-muted">要重建的缓存</legend>
          <div className="flex flex-wrap gap-4">
            {(["thumbs", "previews"] as CacheRebuildScope[]).map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-body">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  disabled={rebuild.isRunning || starting}
                  onChange={() => toggle(scope)}
                />
                {SCOPE_LABEL[scope]}
              </label>
            ))}
          </div>
          <p className="text-meta text-fg-muted">
            预览图按 1280 宽生成，本机一万三千多项约合 3.3GB
            磁盘，只有确实需要大图时才值得。 冷重建按本机实测：缩略图约每秒 20
            张，预览图约每秒 10 张 —— 满库要十分钟到二十多分钟，
            缓存还在的话会快得多。 过程中照常浏览不受影响。
          </p>
        </fieldset>

        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-primary"
            onClick={() => void startRebuild(false)}
            disabled={rebuild.isRunning || starting || scopes.length === 0}
          >
            {rebuild.isRunning ? "重建中…" : "重建缓存"}
          </button>
          <button
            className="btn btn-outline"
            onClick={() => void startRebuild(true)}
            disabled={rebuild.isRunning || starting || scopes.length === 0}
          >
            清空并重建
          </button>
          {rebuild.isRunning && (
            <button
              className="btn btn-ghost"
              onClick={() => void cancelRebuild()}
            >
              取消
            </button>
          )}
        </div>

        {rebuild.isRunning && progress && (
          <div className="space-y-2" data-testid="cache-rebuild-progress">
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-bg-subtle"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="缓存重建进度"
            >
              <div
                className="h-full rounded-full bg-brand transition-[width]"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="text-meta text-fg-muted tabular-nums">
              {progress.scopes.map((scope) => SCOPE_LABEL[scope]).join(" + ")}
              {" · "}
              {progress.done} / {progress.total}
              {progress.failed > 0 ? ` · ${progress.failed} 项失败` : ""}
              {" · "}
              {Math.round(progress.elapsedMs / 1000)} 秒
            </p>
          </div>
        )}

        {rebuild.isComplete && (
          <p
            className="text-meta text-success"
            data-testid="cache-rebuild-done"
          >
            重建完成
            {progress?.failed ? ` · ${progress.failed} 项失败` : ""}
          </p>
        )}
        {rebuild.isCancelled && (
          <p className="text-meta text-fg-muted">重建已取消</p>
        )}
        {rebuild.isError && (
          <p className="text-meta text-danger">
            重建失败：{progress?.error ?? "未知错误"}
          </p>
        )}
        {error && <p className="text-meta text-danger">{error}</p>}
      </div>
    </section>
  );
}
