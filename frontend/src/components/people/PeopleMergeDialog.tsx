import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { aiJobsApi, type PersonGroup } from "../../api/aiJobs";

interface Props {
  personId: string;
  onClose: () => void;
  onMerge: (targetId: string) => void;
  isMerging: boolean;
}

export default function PeopleMergeDialog({
  personId,
  onClose,
  onMerge,
  isMerging,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [targetId, setTargetId] = useState("");
  const result = useQuery({
    queryKey: ["people-search", debouncedQuery],
    queryFn: () => aiJobsApi.searchPeople(debouncedQuery),
  });

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = document.activeElement;
    dialog.showModal();
    inputRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  const candidates = (result.data?.people ?? []).filter(
    (person) => person.id !== personId,
  );
  const selected = candidates.find((person) => person.id === targetId);

  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 m-auto w-[min(680px,94vw)] max-h-[86dvh] overflow-hidden rounded-2xl border border-border bg-bg-elevated p-0 text-fg shadow-xl backdrop:bg-overlay-scrim backdrop:backdrop-blur-[2px]"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex max-h-[86dvh] flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-border-faint px-5 py-4">
          <div>
            <p className="page-eyebrow">人物整理</p>
            <h2 id={titleId} className="mt-1 font-display text-label text-fg">
              合并到另一个人物
            </h2>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            onClick={onClose}
          >
            取消
          </button>
        </header>
        <div className="space-y-3 px-5 py-4">
          <label
            className="block text-meta text-fg-muted"
            htmlFor="people-merge-search"
          >
            搜索人物名称或编号后六位
          </label>
          <input
            ref={inputRef}
            id="people-merge-search"
            className="w-full rounded-lg border border-border bg-bg px-3 py-2.5 text-body text-fg outline-none focus:border-border-strong"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setTargetId("");
            }}
            placeholder="例如：家人、7f873d"
            autoComplete="off"
          />
          <div className="flex items-center justify-between text-meta text-fg-subtle">
            <span>
              {result.isPending
                ? "正在查找…"
                : result.data
                  ? query.trim()
                    ? `匹配 ${result.data.totalGroups.toLocaleString()} 组`
                    : `按照片数排序 · 显示前 ${candidates.length} 组`
                  : ""}
            </span>
            {selected ? <span>已选择：{selected.name}</span> : null}
          </div>
          {result.isError ? (
            <p role="alert" className="text-meta text-danger">
              人物查找失败，请稍后重试。
            </p>
          ) : null}
        </div>
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto border-y border-border-faint px-3 py-2">
          {candidates.map((person: PersonGroup) => (
            <li key={person.id}>
              <button
                type="button"
                aria-pressed={targetId === person.id}
                onClick={() => setTargetId(person.id)}
                className={`flex w-full items-center justify-between gap-4 rounded-lg px-3 py-3 text-left transition-colors ${
                  targetId === person.id
                    ? "bg-bg-subtle text-fg"
                    : "text-fg-muted hover:bg-bg-subtle hover:text-fg"
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-fg">
                    {person.name}
                  </span>
                  <span className="mt-0.5 block text-meta text-fg-subtle">
                    {person.photoCount.toLocaleString()} 张照片 ·{" "}
                    {person.faceCount.toLocaleString()} 张脸
                  </span>
                </span>
                <span className="shrink-0 text-meta text-fg-subtle">
                  {targetId === person.id ? "已选择" : "选择"}
                </span>
              </button>
            </li>
          ))}
          {!result.isPending && !result.isError && candidates.length === 0 ? (
            <li className="px-3 py-8 text-center text-meta text-fg-muted">
              {query.trim() ? "没有匹配的人物" : "暂时没有可合并的人物"}
            </li>
          ) : null}
        </ul>
        <footer className="flex items-center justify-between gap-3 px-5 py-4">
          <p className="max-w-[55%] text-meta text-fg-subtle">
            合并后会把当前组的人脸移动到目标组。
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!targetId || isMerging}
            onClick={() => onMerge(targetId)}
          >
            {isMerging ? "合并中…" : "确认合并"}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
