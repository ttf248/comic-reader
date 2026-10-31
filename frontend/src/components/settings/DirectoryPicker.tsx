import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import { fsApi, type DirectoryPage } from "../../api/fs";
import { CloseIcon, FolderOpenIcon } from "../common/Icon";

interface Props {
  initialDirectory: string;
  onPick: (directory: string) => void;
  onClose: () => void;
}

export default function DirectoryPicker({
  initialDirectory,
  onPick,
  onClose,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const titleId = useId();
  const [address, setAddress] = useState(initialDirectory);
  const [page, setPage] = useState<DirectoryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [request, setRequest] = useState({
    directory: initialDirectory,
    after: "",
  });

  const browse = useCallback(async (directory: string, after = "") => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    setRequest({ directory, after });
    if (!after) {
      setPage(null);
      setAddress(directory);
    }
    try {
      const result = await fsApi.directories(
        directory,
        after,
        controller.signal,
      );
      if (controller.signal.aborted || requestRef.current !== controller)
        return;
      setPage((previous) =>
        after && previous?.directory === result.directory
          ? { ...result, items: [...previous.items, ...result.items] }
          : result,
      );
      setAddress(result.directory);
    } catch (e: unknown) {
      if (controller.signal.aborted || requestRef.current !== controller)
        return;
      setError(directoryError(e));
    } finally {
      if (!controller.signal.aborted && requestRef.current === controller)
        setLoading(false);
    }
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = document.activeElement;
    dialog.showModal();
    addressRef.current?.focus();
    void browse(initialDirectory);
    return () => {
      requestRef.current?.abort();
      if (dialog.open) dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [initialDirectory, browse]);

  const buttonClass =
    "h-8 px-3 rounded-md border border-border-faint text-xs text-fg-muted hover:text-fg hover:bg-bg-subtle disabled:opacity-40";
  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 m-auto w-[640px] max-w-[94vw] max-h-[85dvh] overflow-hidden rounded-xl border border-border bg-bg-elevated p-0 text-fg shadow-lg backdrop:bg-black/40 backdrop:backdrop-blur-[2px]"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled)",
          ),
        ).filter(
          (control) =>
            control.tabIndex >= 0 && control.getClientRects().length > 0,
        );
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (document.activeElement === (event.shiftKey ? first : last)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div className="flex h-[min(560px,85dvh)] flex-col">
        <header className="flex items-center justify-between px-5 h-12 shrink-0 border-b border-border-faint">
          <h2 id={titleId} className="text-sm font-medium">
            选择目录
          </h2>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="p-1 text-fg-muted hover:text-fg"
          >
            <CloseIcon size={14} />
          </button>
        </header>
        <div className="px-5 pt-4 space-y-3 shrink-0">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void browse(address);
            }}
          >
            <input
              ref={addressRef}
              autoFocus
              aria-label="目录路径"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              className="min-w-0 flex-1 h-8 px-2.5 rounded-md border border-border-faint bg-bg-subtle font-mono text-sm focus:outline-none focus:border-accent"
            />
            <button type="submit" className={buttonClass}>
              前往
            </button>
          </form>
          <nav aria-label="目录位置" className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              onClick={() => void browse("")}
            >
              主目录
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={!page?.parent || loading}
              onClick={() => page?.parent && void browse(page.parent)}
            >
              上一级
            </button>
            {page?.roots.map((root) => (
              <button
                type="button"
                key={root}
                className={buttonClass}
                onClick={() => void browse(root)}
              >
                {root}
              </button>
            ))}
          </nav>
          <p className="text-xs text-fg-subtle">
            打开文件夹浏览，确认后使用当前目录。
          </p>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto m-5 border border-border-faint rounded-md"
          aria-busy={loading}
        >
          {error && (
            <div role="alert" className="p-4 space-y-2">
              <p className="text-sm text-danger">{error}</p>
              <button
                type="button"
                className={buttonClass}
                onClick={() => void browse(request.directory, request.after)}
              >
                重试
              </button>
            </div>
          )}
          {page && (
            <ul aria-label="子目录" className="divide-y divide-border-faint">
              {page.items.map((item) => (
                <li key={item.path}>
                  <button
                    type="button"
                    onClick={() => void browse(item.path)}
                    className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-bg-subtle focus:bg-bg-subtle"
                  >
                    <FolderOpenIcon size={14} />
                    <span className="break-all">{item.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {loading && (
            <p role="status" className="p-4 text-xs text-fg-muted">
              读取目录中…
            </p>
          )}
          {!loading && !error && page?.items.length === 0 && (
            <p className="p-4 text-xs text-fg-muted">
              没有子目录，可以使用当前目录。
            </p>
          )}
          {page?.nextAfter && !loading && !error && (
            <button
              type="button"
              className="w-full p-3 text-xs text-accent hover:bg-bg-subtle"
              onClick={() => void browse(page.directory, page.nextAfter)}
            >
              加载更多目录
            </button>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 px-5 pb-4 shrink-0">
          <button type="button" className={buttonClass} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            disabled={loading || !page || address !== page.directory}
            onClick={() => page && onPick(page.directory)}
            className="h-8 px-3 rounded-md bg-accent text-accent-contrast text-xs disabled:opacity-40"
          >
            使用此目录
          </button>
        </footer>
      </div>
    </dialog>
  );
}

function directoryError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "local_access_required")
      return "请在运行服务的电脑上选择目录";
    if (error.code === "directory_not_found")
      return "目录不存在或暂时离线，请修改路径后重试";
    if (error.code === "directory_access_denied")
      return "没有读取此目录的权限，请选择其他目录";
    if (error.code === "invalid_directory_request")
      return "请输入有效的目录路径";
  }
  return "无法读取目录，请重试或手动填写路径";
}
