import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { albumsApi } from "../../api/albums";
import type { ContentKind } from "../../api/library";
import { useUIStore } from "../../store/uiStore";
import { RefreshIcon } from "./Icon";

interface Props {
  albumId: string;
  /** 当前生效的用途。 */
  kind: ContentKind;
  /** 取消覆盖后会回落到的用途。 */
  defaultKind: ContentKind;
  /** 当前用途是否来自用户的手动覆盖。 */
  overridden: boolean;
  /** 切换成功后回调，调用方负责切换视图。 */
  onChanged: (kind: ContentKind) => void;
  /** 深色底（阅读器）上使用。 */
  onDark?: boolean;
}

/**
 * 相册用途切换器：照片墙 / 漫画阅读器。
 *
 * 用途是相册级设置，切换后立即持久化到服务端；相册摘要会带上新的用途，
 * 首页、搜索与最近列表里的跳转目标随之改变。
 */
export default function ContentKindSwitch({
  albumId,
  kind,
  defaultKind,
  overridden,
  onChanged,
  onDark = false,
}: Props) {
  const queryClient = useQueryClient();
  const pushToast = useUIStore((s) => s.pushToast);
  const [pending, setPending] = useState<ContentKind | null>(null);

  const mutation = useMutation({
    mutationFn: (next: ContentKind) => albumsApi.setContentKind(albumId, next),
    onSuccess: (_data, next) => {
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      void queryClient.invalidateQueries({ queryKey: ["prefs"] });
      onChanged(next);
    },
    onError: () => {
      setPending(null);
      pushToast({ kind: "error", message: "切换相册类型失败" });
    },
  });

  const reset = useMutation({
    mutationFn: () => albumsApi.clearContentKind(albumId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      pushToast({
        kind: "success",
        message: `已恢复为${
          defaultKind === "comic" ? "漫画" : "照片"
        }相册`,
      });
    },
    onError: () => {
      pushToast({ kind: "error", message: "恢复默认类型失败" });
    },
  });

  const buttonClass = (active: boolean) =>
    [
      "px-2.5 h-7 text-[12.5px] transition-colors rounded",
      active
        ? onDark
          ? "bg-white/20 text-white"
          : "bg-bg-subtle text-fg"
        : onDark
          ? "text-white/60 hover:text-white"
          : "text-fg-muted hover:text-fg",
    ].join(" ");

  return (
    <div className="flex items-center gap-1.5">
      <div
        role="group"
        aria-label="相册类型"
        className={`inline-flex items-center gap-0.5 rounded-md border p-0.5 ${
          onDark ? "border-white/15" : "border-border-faint"
        }`}
      >
        <button
          type="button"
          onClick={() => {
            if (kind === "photo" || pending) return;
            setPending("photo");
            mutation.mutate("photo");
          }}
          className={buttonClass(kind === "photo")}
          aria-pressed={kind === "photo"}
          title="按照片墙浏览"
        >
          照片
        </button>
        <button
          type="button"
          onClick={() => {
            if (kind === "comic" || pending) return;
            setPending("comic");
            mutation.mutate("comic");
          }}
          className={buttonClass(kind === "comic")}
          aria-pressed={kind === "comic"}
          title="按漫画阅读器浏览"
        >
          漫画
        </button>
      </div>
      {overridden && (
        <button
          type="button"
          onClick={() => reset.mutate()}
          disabled={reset.isPending}
          className={`inline-flex h-7 w-7 items-center justify-center rounded transition-colors disabled:opacity-50 ${
            onDark
              ? "text-white/60 hover:text-white hover:bg-white/10"
              : "text-fg-muted hover:text-fg hover:bg-bg-subtle"
          }`}
          title={`恢复默认（${
            defaultKind === "comic" ? "漫画" : "照片"
          }相册）`}
          aria-label="恢复默认相册类型"
        >
          <RefreshIcon size={13} />
        </button>
      )}
    </div>
  );
}
