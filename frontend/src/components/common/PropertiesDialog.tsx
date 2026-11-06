import { useEffect, useId, useRef } from "react";
import { useImageInfo } from "../../hooks/useImageInfo";
import { useLibraryNodes } from "../../hooks/useLibrary";
import { formatSize } from "../../utils/format";
import { formatDateTime } from "../../utils/date";
import { collectionUnit, mediaUnit } from "../../utils/workbench";
import { CloseIcon } from "./Icon";
import CopyButton from "./CopyButton";

export type PropertiesTarget =
  { kind: "node"; id: string } | { kind: "image"; id: string };

interface Props {
  target: PropertiesTarget | null;
  onClose: () => void;
}

export default function PropertiesDialog({ target, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const targetKey = target ? `${target.kind}:${target.id}` : "";
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!targetKey || !dialog) return;
    const previous = document.activeElement;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        previous !== document.body
      ) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [targetKey]);

  if (!target) return null;
  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 m-auto w-[480px] max-w-[92vw] max-h-[85dvh] overflow-y-auto rounded-xl border border-border bg-bg-elevated p-0 text-fg shadow-lg backdrop:bg-overlay-scrim backdrop:backdrop-blur-[2px]"
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
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        ).filter(
          (button) =>
            button.tabIndex >= 0 && button.getClientRects().length > 0,
        );
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (document.activeElement === (event.shiftKey ? first : last)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <header className="sticky top-0 z-10 flex items-center justify-between px-5 h-12 border-b border-border-faint bg-bg-elevated">
        <h2 id={titleId} className="font-display text-label font-semibold">
          属性
        </h2>
        <button
          type="button"
          autoFocus
          onClick={onClose}
          aria-label="关闭"
          className="text-fg-muted hover:text-fg p-1 rounded hover:bg-bg-subtle transition-colors"
        >
          <CloseIcon size={14} />
        </button>
      </header>
      <div className="p-5 text-body space-y-3">
        {target.kind === "node" ? (
          <NodeProperties key={targetKey} nodeId={target.id} />
        ) : (
          <ImageProperties key={targetKey} fileId={target.id} />
        )}
      </div>
    </dialog>
  );
}

function NodeProperties({ nodeId }: { nodeId: string }) {
  const query = useLibraryNodes([nodeId]);
  const node = query.data?.items.find((item) => item.id === nodeId);
  return (
    <>
      {query.isLoading && (
        <p role="status" className="text-fg-muted text-meta">
          加载中…
        </p>
      )}
      {query.isError && (
        <LoadError
          message="无法读取目录属性"
          retry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      )}
      {!query.isLoading && !query.isError && !node && (
        <p>此目录已不在媒体库中</p>
      )}
      {node && (
        <>
          <dl className="divide-y divide-border-faint">
            <Field
              label="名称"
              value={
                node.virtual && node.location ? node.location : node.name
              }
              copyable
            />
            <Field
              label="类型"
              value={
                node.kind === "collection"
                  ? // 漫画侧的集合叫「作品」—— 与集合页的眉标同一个词。
                    node.contentKind === "comic"
                    ? "作品"
                    : "集合"
                  : node.virtual
                    ? // 「本目录媒体」是服务端的技术叫法，界面上读不出
                      // 这是什么；别处一律叫「散图」。
                      "散图"
                    : "相册"
              }
            />
            <Field
              label="来源"
              value={node.sourceName || "—"}
              copyable={!!node.sourceName}
            />
            {node.kind === "album" ? (
              <>
                {/* 图片计数单位跟着内容属性走：照片「张」，漫画「页」。 */}
                <Field
                  label="图片"
                  value={`${node.imageCount ?? 0} ${mediaUnit(node.contentKind)}`}
                />
                <Field label="视频" value={`${node.videoCount ?? 0} 个`} />
              </>
            ) : (
              <>
                <Field
                  label="相册数量"
                  value={`${node.albumCount ?? 0} ${collectionUnit(node.contentKind)}`}
                />
                <Field label="直属项目" value={`${node.childCount ?? 0} 项`} />
              </>
            )}
            <Field
              label="媒体总数"
              value={`${node.mediaCount ?? (node.imageCount ?? 0) + (node.videoCount ?? 0)} 项`}
            />
            <Field label="大小" value={formatSize(node.folderSize ?? 0)} />
            <Field label="修改时间" value={formatDateTime(node.modTime)} />
            {!!node.tags?.length && (
              <Field label="标签" value={node.tags.join(" · ")} />
            )}
          </dl>
          <p className="text-meta text-fg-subtle">根据最近一次扫描记录展示。</p>
        </>
      )}
    </>
  );
}

function ImageProperties({ fileId }: { fileId: string }) {
  const { info, err, loading, refetch } = useImageInfo(fileId);
  return (
    <>
      {loading && (
        <p role="status" className="text-fg-muted text-meta">
          加载中…
        </p>
      )}
      {err && (
        <LoadError
          message="无法读取图片属性"
          retry={refetch}
          retrying={loading}
        />
      )}
      {info && (
        <dl className="divide-y divide-border-faint">
          <Field label="文件名" value={info.name} copyable />
          <Field label="格式" value={info.format.toUpperCase()} />
          <Field label="尺寸" value={`${info.width} × ${info.height} px`} />
          <Field label="大小" value={formatSize(info.size)} />
          <Field label="修改时间" value={formatDateTime(info.mtime)} />
          <Field label="目录" value={info.dir} mono copyable />
          <Field label="校验和" value={info.checksum} mono copyable />
          <Field label="文件 ID" value={info.path} mono copyable />
        </dl>
      )}
    </>
  );
}

function LoadError({
  message,
  retry,
  retrying,
}: {
  message: string;
  retry: () => void;
  retrying: boolean;
}) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-meta"
    >
      <p>{message}</p>
      <button
        type="button"
        onClick={(event) => {
          // 重试会暂时移除错误提示，将焦点留在仍可操作的关闭按钮上。
          event.currentTarget
            .closest("dialog")
            ?.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')
            ?.focus({ preventScroll: true });
          retry();
        }}
        disabled={retrying}
        className="shrink-0 text-accent hover:underline disabled:opacity-50"
      >
        {retrying ? "正在重试…" : "重试加载"}
      </button>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  copyable,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copyable?: boolean;
}) {
  return (
    /* 两列的规格表：标签在左一窄列，值在右。
       原先标签在上、值在下，八个字段把弹窗撑到近 600px 高，
       下面大半是空的；规格表本来就该横向扫读。 */
    <div className="flex items-start gap-4 py-1.5">
      <dt className="w-20 shrink-0 text-meta font-medium text-fg-muted leading-6">
        {label}
      </dt>
      <dd className="flex-1 min-w-0 flex items-start gap-1.5">
        <span
          className={`break-all leading-6 ${
            mono ? "font-mono text-meta text-fg-muted" : "text-body"
          }`}
        >
          {value}
        </span>
        {copyable && (
          <span className="shrink-0 mt-1">
            <CopyButton value={value} title={`复制${label}`} />
          </span>
        )}
      </dd>
    </div>
  );
}
