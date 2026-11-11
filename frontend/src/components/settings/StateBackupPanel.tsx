import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LibraryIcon } from "../common/Icon";
import { ApiError } from "../../api/client";
import { prefsApi } from "../../api/prefs";
import {
  backupCategories,
  backupLabels,
  stateBackupApi,
  type BackupCategory,
  type StatePreview,
  type StateRestoreResult,
} from "../../api/stateBackup";
import { useUIStore } from "../../store/uiStore";

function message(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 403) return "备份与恢复仅能在运行服务的本机使用。";
    if (error.code === "state_backup_too_large")
      return "备份请求超过导入上限，请选择不超过 32 MB 的文件。";
    if (error.code === "state_changed")
      return "预览后状态已有变化，请重新预览。";
    if (error.code === "library_not_ready")
      return "媒体库尚未就绪或已变化，请完成扫描后重新预览。";
    if (error.code === "history_limit_conflict")
      return "最近记录数量超过所选偏好的上限，请同时恢复匹配的最近访问与服务端偏好。";
    if (error.code === "invalid_state_backup")
      return "备份格式、版本或所选类别不正确，请检查备份文件。";
  }
  return "操作失败，请重试。";
}

export default function StateBackupPanel() {
  const client = useQueryClient();
  const [fileName, setFileName] = useState("");
  const [backup, setBackup] = useState<unknown>();
  const [preview, setPreview] = useState<StatePreview>();
  const [selected, setSelected] = useState<BackupCategory[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<StateRestoreResult>();
  const controller = useRef<AbortController>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  async function exportBackup() {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const data = await stateBackupApi.export(current.signal);
      if (!mounted.current) return;
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = `local-gallery-state-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.append(link);
        link.click();
        link.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
      const skipped =
        typeof data === "object" && data !== null && "unresolvedCovers" in data
          ? Number(data.unresolvedCovers)
          : 0;
      setNotice(
        skipped > 0
          ? `已导出。${skipped} 条封面无法在当前库解析，未包含在备份中；请恢复目录并扫描后再次导出。`
          : "备份已下载。恢复前请妥善保存此文件。",
      );
    } catch (error: unknown) {
      if (mounted.current) setError(message(error));
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  async function previewBackup(data: unknown) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setPending(true);
    setError("");
    setPreview(undefined);
    setResult(undefined);
    try {
      const response = await stateBackupApi.preview(data, current.signal);
      if (current.signal.aborted || !mounted.current) return;
      setPreview(response);
      setSelected(
        backupCategories.filter(
          (category) => category !== "covers" || response.ready,
        ),
      );
    } catch (error: unknown) {
      if (!current.signal.aborted && mounted.current) setError(message(error));
    } finally {
      if (!current.signal.aborted && mounted.current) setPending(false);
    }
  }

  async function restore() {
    if (
      !preview ||
      selected.length === 0 ||
      !window.confirm(
        `将覆盖恢复：${selected.map((category) => backupLabels[category]).join("、")}。服务端会先保存恢复前备份，是否继续？`,
      )
    )
      return;
    setPending(true);
    setError("");
    setResult(undefined);
    try {
      const restored = await stateBackupApi.restore(backup, selected, preview);
      if (mounted.current) {
        setResult(restored);
        setPreview(undefined);
        setNotice(
          "恢复前备份已保存在服务端 state/backups/，未选类别保持原有数据。",
        );
      }
      // 写入已确认后，刷新失败也保留完成报告。
      await client.invalidateQueries({
        predicate: (query) =>
          [
            "prefs",
            "favorites",
            "history",
            "activity",
            "activity-query",
            "library",
            "picks",
            "people",
          ].includes(String(query.queryKey[0])),
      });
      if (restored.completed.includes("preferences")) {
        try {
          const saved = await prefsApi.get();
          client.setQueryData(["prefs"], saved);
          if (["light", "dark", "system"].includes(saved.theme))
            useUIStore.getState().setTheme(saved.theme);
          useUIStore.setState({ sidebarCollapsed: saved.sidebarCollapsed });
        } catch {
          if (mounted.current)
            setError("恢复结果已确认，但偏好刷新失败，请刷新页面。");
        }
      }
    } catch (error: unknown) {
      if (mounted.current) {
        setError(message(error));
        setPreview(undefined);
      }
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  return (
    <section
      aria-labelledby="state-backup-heading"
      className="settings-section"
    >
      <div className="settings-section__heading">
        <span className="text-fg-muted">
          <LibraryIcon size={13} />
        </span>
        <h2 id="state-backup-heading" className="section-title">
          备份与恢复
        </h2>
      </div>
      <div className="settings-section__body p-5 space-y-4">
        <p className="text-body text-fg-muted">
          备份收藏、最近访问、服务端偏好、阅读/播放活动、自定义封面、照片精选与人物分组修正。不会备份人脸特征向量、媒体文件、服务配置或此浏览器的阅读器偏好。
        </p>
        <button
          className="btn btn-outline"
          onClick={() => void exportBackup()}
          disabled={pending}
        >
          导出状态备份
        </button>
        <label className="block rounded-md text-body focus-within:ring-2 focus-within:ring-brand">
          <span className="btn btn-outline">选择备份文件</span>
          <span className="block mt-2 text-meta text-fg-muted break-all">
            {fileName || "JSON 格式，最大 32 MB"}
          </span>
          <input
            aria-label="状态备份文件"
            className="sr-only"
            type="file"
            accept=".json,application/json"
            disabled={pending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              setFileName(file.name);
              setNotice("");
              setResult(undefined);
              setPreview(undefined);
              setBackup(undefined);
              if (file.size > 32 * 1024 * 1024) {
                setError("备份文件超过 32 MB，请选择较小文件。");
                return;
              }
              setPending(true);
              void file
                .text()
                .then((text) => {
                  const parsed: unknown = JSON.parse(text);
                  if (!mounted.current) return;
                  setBackup(parsed);
                  return previewBackup(parsed);
                })
                .catch(() => {
                  if (mounted.current) {
                    setError("无法读取 JSON 备份文件。");
                    setPending(false);
                  }
                });
            }}
          />
        </label>
        {backup !== undefined && !preview && !pending && (
          <button
            className="btn btn-outline"
            onClick={() => void previewBackup(backup)}
          >
            重新预览备份
          </button>
        )}
        {preview && (
          <>
            <p className="text-meta text-fg-muted">
              恢复按类别覆盖，缺失资源记录保留；封面重新校验，失效项跳过。仅适用于相同媒体根身份与相对路径，移动目录或更换媒体根后暂不支持自动迁移映射。
            </p>
            {!preview.ready && (
              <p className="text-meta text-fg-muted">
                当前库尚未扫描完成，自定义封面暂不可恢复。
              </p>
            )}
            <div className="space-y-2">
              {backupCategories.map((category) => (
                <label
                  key={category}
                  className="flex min-h-9 items-center gap-3 text-body"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(category)}
                    disabled={
                      pending || (category === "covers" && !preview.ready)
                    }
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, category]
                          : current.filter((value) => value !== category),
                      )
                    }
                  />
                  <span>
                    {backupLabels[category]} · {preview.counts[category]} 条
                    {(preview.missing[category] ?? 0) > 0
                      ? `，${preview.missing[category]} 条资源缺失`
                      : ""}
                  </span>
                </label>
              ))}
            </div>
            {preview.skippedCovers > 0 && (
              <p className="text-meta text-fg-muted">
                {preview.skippedCovers} 条封面无效，将跳过。
              </p>
            )}
            <button
              className="btn btn-primary"
              disabled={pending || selected.length === 0}
              onClick={() => void restore()}
            >
              确认覆盖恢复
            </button>
          </>
        )}
        {pending && (
          <p role="status" className="text-meta text-fg-muted">
            正在处理，请稍候…
          </p>
        )}
        {error && (
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-meta text-fg-muted">
            {notice}
          </p>
        )}
        {result && (
          <div role="status" className="text-body">
            <p>
              已完成：
              {result.completed
                .map((category) => backupLabels[category])
                .join("、") || "无"}
            </p>
            {result.failed && (
              <p className="text-danger">
                失败：{backupLabels[result.failed]}；
                {result.code === "state_changed"
                  ? "状态已变化，请重新预览。"
                  : "写入失败，请检查服务端存储后重新预览。"}
              </p>
            )}
            {result.pending.length > 0 && (
              <p>
                未执行：
                {result.pending
                  .map((category) => backupLabels[category])
                  .join("、")}
              </p>
            )}
            {result.skippedCovers > 0 && (
              <p>已跳过 {result.skippedCovers} 条无效封面。</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
