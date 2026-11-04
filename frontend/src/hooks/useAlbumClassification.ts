import { useMutation, useQueryClient } from "@tanstack/react-query";
import { albumsApi } from "../api/albums";
import { useUIStore } from "../store/uiStore";
import { libraryQueryKeys } from "./useLibrary";
import type { ContentKind } from "../api/library";

/**
 * 相册归类：把一本相册移到另一种打开方式，或恢复它的默认归类。
 *
 * 这是**写操作**而不是视图开关——服务端会同时清掉另一种用途留下的进度，
 * 所以它必须是一次明确的、放在菜单里的动作，不能藏在页头常驻控件里。
 */
export function useAlbumClassification(albumId: string) {
  const queryClient = useQueryClient();
  const pushToast = useUIStore((s) => s.pushToast);

  const moveTo = useMutation({
    mutationFn: (kind: ContentKind) =>
      albumsApi.setContentKind(albumId, kind),
    onSuccess: (_data, kind) => {
      // 用途变了，相册摘要、列表归属与计数全都变了：整棵库缓存一起失效。
      void queryClient.invalidateQueries({ queryKey: libraryQueryKeys.root });
      pushToast({
        kind: "success",
        message: `已移到${kind === "comic" ? "漫画库" : "照片库"}`,
        ttl: 1600,
      });
    },
    onError: () => pushToast({ kind: "error", message: "归类失败，请重试" }),
  });

  const resetToDefault = useMutation({
    mutationFn: () => albumsApi.clearContentKind(albumId),
    onSuccess: (state) => {
      void queryClient.invalidateQueries({ queryKey: libraryQueryKeys.root });
      pushToast({
        kind: "success",
        message: `已恢复为${state.contentKind === "comic" ? "漫画" : "照片"}相册`,
        ttl: 1600,
      });
    },
    onError: () =>
      pushToast({ kind: "error", message: "恢复默认类型失败，请重试" }),
  });

  return { moveTo, resetToDefault };
}
