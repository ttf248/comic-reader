import { useNavigate } from "react-router-dom";
import { fsApi, fsCapabilities } from "../api/fs";
import type { CardData } from "../components/album/AlbumGrid";

interface Actions {
  open: () => void;
  openInExplorer: () => Promise<void>;
  copyPath: () => Promise<void>;
}

// 提供相册右键菜单的动作实现。
// 收藏切换由调用方通过 useFavorites().toggle 触发（避免再订阅 query）。
export function useAlbumActions(item: CardData) {
  const navigate = useNavigate();

  // 收藏标签没有文件系统资源，复制它的内部标签标识而不是 /tags 路由。
  // 其余卡片把 /albums/<encoded> 解码回不透明资源 ID。
  const decodedPath = (() => {
    if (item.variant === "smart") return `smart:${item.title}`;
    if (!item.to.startsWith("/albums/")) return item.to;
    try {
      return decodeURIComponent(item.to.replace(/^\/albums\//, ""));
    } catch {
      return item.to;
    }
  })();

  const actions: Actions = {
    open: () => navigate(item.to),
    openInExplorer: async () => {
      if (!fsCapabilities.allowOsOpen) throw new Error("allowOsOpen disabled");
      if (item.variant === "smart") throw new Error("not a real path");
      await fsApi.openInExplorer(decodedPath);
    },
    copyPath: async () => {
      await navigator.clipboard.writeText(decodedPath);
    },
  };

  return actions;
}
