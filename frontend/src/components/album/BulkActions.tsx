import { useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { favoritesApi, type Prefs } from "../../api/prefs";
import { activityApi } from "../../api/activity";
import { libraryApi } from "../../api/library";
import { ApiError } from "../../api/client";
import {
  useSelectionStore,
  type SelectionItem,
} from "../../store/selectionStore";
import { useUIStore } from "../../store/uiStore";
import { useAppMode } from "../../hooks/useAppMode";

interface Props {
  loaded: SelectionItem[];
}
export default function BulkActions({ loaded }: Props) {
  const client = useQueryClient();
  const errorToast = useRef<string>();
  const { mode } = useAppMode();
  const active = useSelectionStore((s) => s.active);
  const selected = useSelectionStore((s) => s.items);
  const busy = useSelectionStore((s) => s.busy);
  const count = Object.keys(selected).length;
  const readable = Object.values(selected).filter(
    (item) =>
      item.albumId && item.contentKind === "comic" && item.imageCount > 0,
  );
  const toast = useUIStore((s) => s.pushToast);

  async function execute(action: "add" | "remove" | "read" | "unread") {
    const state = useSelectionStore.getState();
    if (state.busy) return;
    if (errorToast.current)
      useUIStore.getState().dismissToast(errorToast.current);
    errorToast.current = undefined;
    const snapshot = Object.values(state.items);
    if (!snapshot.length) return;
    useSelectionStore.setState({ busy: true });
    try {
      if (action === "add" || action === "remove") {
        const saved = await favoritesApi.batch(
          snapshot.map((item) => item.id),
          action,
        );
        client.setQueryData(["favorites"], { favorites: saved.favorites });
        client.setQueryData<Prefs>(["prefs"], (previous) =>
          previous ? { ...previous, favorites: saved.favorites } : previous,
        );
        void client.invalidateQueries({ queryKey: ["favorites"] });
      } else {
        const candidates = snapshot.filter(
          (item) =>
            item.albumId && item.contentKind === "comic" && item.imageCount > 0,
        );
        const nodes = await libraryApi.queryNodes(
          candidates.map((item) => item.albumId!),
        );
        if (
          nodes.missing.length ||
          nodes.items.length !== candidates.length ||
          nodes.items.some(
            (node) =>
              node.kind !== "album" ||
              node.contentKind !== "comic" ||
              !(node.imageCount! > 0),
          )
        )
          throw new Error("所选相册已变化，请刷新列表后重试");
        if (action === "read")
          await activityApi.setBatch(
            nodes.items.map((node) => ({
              albumId: node.id,
              mediaKind: "image",
              pageIndex: node.imageCount! - 1,
              pageCount: node.imageCount!,
            })),
          );
        else await activityApi.removeImages(nodes.items.map((node) => node.id));
        await client.invalidateQueries({
          predicate: (query) =>
            ["activity", "activity-query", "library"].includes(
              String(query.queryKey[0]),
            ),
        });
      }
      useSelectionStore.getState().finish(state.scope);
      toast({ kind: "success", message: "批量操作已完成" });
    } catch (error: unknown) {
      useSelectionStore.setState({ busy: false });
      errorToast.current = toast({
        kind: "error",
        message:
          error instanceof ApiError && error.code === "favorite_limit"
            ? "收藏最多保留 500 项，请先整理已有收藏。"
            : error instanceof ApiError
              ? "批量操作失败，请重试。"
              : error instanceof Error
                ? error.message
                : "批量操作失败，请重试。",
      });
    }
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-2 py-3 ${active ? "sticky top-0 z-20 bg-bg/95 backdrop-blur" : ""}`}
      aria-label="批量操作"
    >
      {!active ? (
        <button
          className="btn btn-sm btn-outline"
          disabled={busy}
          onClick={() => useSelectionStore.getState().start()}
        >
          选择
        </button>
      ) : (
        <>
          <span role="status" className="text-body text-fg-muted">
            已选 {count} 项
            {mode === "comic" ? ` · ${readable.length} 卷可标记` : ""}
          </span>
          <button
            className="btn btn-sm btn-outline"
            disabled={busy}
            onClick={() => {
              if (!useSelectionStore.getState().selectLoaded(loaded))
                toast({
                  kind: "info",
                  message: "最多选择 1,000 项，请减少选择范围。",
                });
            }}
          >
            选择已加载项
          </button>
          <button
            className="btn btn-sm btn-outline"
            disabled={busy || count === 0}
            onClick={() => void execute("add")}
          >
            批量收藏
          </button>
          <button
            className="btn btn-sm btn-outline"
            disabled={busy || count === 0}
            onClick={() => void execute("remove")}
          >
            批量取消收藏
          </button>
          {mode === "comic" && (
            <>
              <button
                className="btn btn-sm btn-outline"
                disabled={busy || readable.length === 0}
                onClick={() => void execute("read")}
              >
                标记已读
              </button>
              <button
                className="btn btn-sm btn-outline"
                disabled={busy || readable.length === 0}
                onClick={() => void execute("unread")}
              >
                重置未读
              </button>
            </>
          )}
          <button
            className="btn btn-sm btn-ghost"
            disabled={busy}
            onClick={() => useSelectionStore.getState().clear()}
          >
            退出选择
          </button>
          {busy && (
            <span role="status" className="text-meta text-fg-muted">
              正在提交…
            </span>
          )}
        </>
      )}
    </div>
  );
}
