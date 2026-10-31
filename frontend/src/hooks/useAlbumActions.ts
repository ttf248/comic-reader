import { useNavigate } from "react-router-dom";
import { fsApi, fsCapabilities } from "../api/fs";
import type { CardData } from "../components/album/AlbumCard";
import { copyText } from "../utils/clipboard";
import { decodeFavPath } from "../utils/path";

interface Actions {
  open: () => void;
  openInExplorer: () => Promise<void>;
  copyLink: () => Promise<void>;
}

// 提供相册右键菜单的动作实现。
// 收藏切换由调用方通过 useFavorites().toggle 触发（避免再订阅 query）。
export function useAlbumActions(item: CardData) {
  const navigate = useNavigate();

  const resourceId = decodeFavPath(item.to);

  const actions: Actions = {
    open: () => navigate(item.to),
    openInExplorer: async () => {
      if (!fsCapabilities.allowOsOpen) throw new Error("allowOsOpen disabled");
      if (item.variant === "smart") throw new Error("not a real path");
      await fsApi.openInExplorer(resourceId);
    },
    copyLink: async () => {
      // 保留路由编码，复制当前站点可直接打开的地址。
      const link = new URL(item.to, window.location.origin).href;
      if (!(await copyText(link))) throw new Error("clipboard copy failed");
    },
  };

  return actions;
}
