import type { CardData } from "./AlbumCard";
import ContextMenu, { type AnyMenuItem } from "./ContextMenu";
import { useAlbumActions } from "../../hooks/useAlbumActions";
import { useFavorites } from "../../hooks/useFavorites";
import {
  useMarkAlbumRead,
  useResetAlbumRead,
} from "../../hooks/useImageActivity";
import { fsCapabilities } from "../../api/fs";
import { decodeFavPath } from "../../utils/path";
import { isCompleted } from "../../utils/progress";
import { useUIStore } from "../../store/uiStore";
import {
  ArrowRightLineIcon,
  StarIcon,
  ArrowUpRightIcon,
  CopyIcon,
  InfoIcon,
  CheckIcon,
  RewindIcon,
} from "../common/Icon";

interface Props {
  item: CardData;
  x: number;
  y: number;
  onClose: () => void;
  onShowProperties: (id: string) => void;
}

// 所有卡片的操作入口；仅展开时订阅操作依赖，网格和列表不再叠加两份菜单。
export default function AlbumContextMenu({
  item,
  x,
  y,
  onClose,
  onShowProperties,
}: Props) {
  const actions = useAlbumActions(item);
  const { favorites, toggle } = useFavorites();
  const markRead = useMarkAlbumRead();
  const resetRead = useResetAlbumRead();
  const pushToast = useUIStore((state) => state.pushToast);
  const isAlbum = item.variant === "album";
  const resourceId =
    item.variant === "smart" ? `smart:${item.title}` : decodeFavPath(item.to);
  const imageCount = item.imageCount ?? item.progress?.total ?? item.count;
  const completed = isCompleted(item.progress);
  const items: AnyMenuItem[] = [
    { id: "open", label: "打开", icon: <ArrowRightLineIcon size={12} /> },
    {
      id: "favorite",
      label: favorites.includes(resourceId) ? "取消收藏" : "收藏",
      icon: <StarIcon size={12} />,
    },
  ];
  if (isAlbum && imageCount > 0) {
    items.push(
      { id: "separator", separator: true },
      {
        id: "mark-read",
        label: "标记为已读",
        icon: <CheckIcon size={12} />,
        disabled: completed,
      },
      {
        id: "unmark-read",
        label: "取消已读",
        icon: <RewindIcon size={12} />,
        disabled: !completed,
      },
    );
  }
  items.push(
    { id: "separator", separator: true },
    {
      id: "explorer",
      label: "在资源管理器中打开",
      icon: <ArrowUpRightIcon size={12} />,
      disabled: !fsCapabilities.allowOsOpen || item.variant === "smart",
    },
    { id: "copy", label: "复制路径", icon: <CopyIcon size={12} /> },
    { id: "separator", separator: true },
    {
      id: "properties",
      label: "属性",
      icon: <InfoIcon size={12} />,
      disabled: item.variant === "smart",
    },
  );

  return (
    <ContextMenu
      x={x}
      y={y}
      items={items}
      onClose={onClose}
      onSelect={(id) => {
        switch (id) {
          case "open":
            actions.open();
            break;
          case "favorite":
            void toggle(resourceId).catch(() => {});
            break;
          case "explorer":
            void actions.openInExplorer().catch(() => {});
            break;
          case "copy":
            void actions.copyPath().catch(() => {});
            break;
          case "properties":
            onShowProperties(resourceId);
            break;
          case "mark-read":
            // 菜单随即卸载；使用 Promise 继续反馈写入结果，缓存由 mutation 同步。
            void markRead
              .mutateAsync({ albumId: resourceId, total: imageCount })
              .then(() =>
                pushToast({
                  kind: "success",
                  message: "已标记为已读",
                  ttl: 1200,
                }),
              )
              .catch(() => pushToast({ kind: "error", message: "标记失败" }));
            break;
          case "unmark-read":
            void resetRead
              .mutateAsync(resourceId)
              .then(() =>
                pushToast({
                  kind: "success",
                  message: "已重置为未读",
                  ttl: 1200,
                }),
              )
              .catch(() => pushToast({ kind: "error", message: "重置失败" }));
            break;
        }
        onClose();
      }}
    />
  );
}
