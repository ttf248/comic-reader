import type { CardData } from "./AlbumCard";
import ContextMenu, { type AnyMenuItem } from "./ContextMenu";
import { useAlbumActions } from "../../hooks/useAlbumActions";
import { useFavorites } from "../../hooks/useFavorites";
import {
  useMarkAlbumRead,
  useResetAlbumRead,
} from "../../hooks/useImageActivity";
import { fileManagerErrorMessage } from "../../utils/fileManager";
import { favoriteResourceId } from "../../utils/path";
import { isCompleted } from "../../utils/progress";
import { comicCopy } from "../../utils/workbench";
import { useUIStore } from "../../store/uiStore";
import {
  ArrowRightLineIcon,
  StarIcon,
  ArrowUpRightIcon,
  CopyIcon,
  InfoIcon,
  CheckIcon,
  RewindIcon,
  TrashIcon,
} from "../common/Icon";

interface Props {
  item: CardData;
  x: number;
  y: number;
  onClose: () => void;
  onShowProperties: (id: string) => void;
  onRemoveHistory?: (albumId: string) => void;
}

// 所有卡片的操作入口；仅展开时订阅操作依赖，网格和列表不再叠加两份菜单。
export default function AlbumContextMenu({
  item,
  x,
  y,
  onClose,
  onShowProperties,
  onRemoveHistory,
}: Props) {
  const actions = useAlbumActions(item);
  const { favorites, toggle } = useFavorites();
  const markRead = useMarkAlbumRead();
  const resetRead = useResetAlbumRead();
  const pushToast = useUIStore((state) => state.pushToast);
  const isAlbum = item.variant === "album";
  const resourceId = favoriteResourceId(item);
  const imageCount = item.imageCount ?? item.progress?.total ?? item.count;
  const completed = isCompleted(item.progress);
  // 阅读进度只属于漫画工作台：照片相册没有「读完」这回事，
  // 菜单里也就不会出现标记与取消标记。
  const isComic = item.contentKind === "comic";
  const copy = comicCopy();
  const items: AnyMenuItem[] = [
    { id: "open", label: "打开", icon: <ArrowRightLineIcon size={12} /> },
    {
      id: "favorite",
      label: favorites.includes(resourceId) ? "取消收藏" : "收藏",
      icon: <StarIcon size={12} />,
    },
  ];
  if (isAlbum && isComic && imageCount > 0) {
    items.push(
      { id: "separator", separator: true },
      {
        id: "mark-read",
        label: copy.markFinishedLabel,
        icon: <CheckIcon size={12} />,
        disabled: completed,
      },
      {
        id: "unmark-read",
        label: `取消${copy.finishedLabel}`,
        icon: <RewindIcon size={12} />,
        disabled: !completed,
      },
    );
  }
  if (isAlbum && onRemoveHistory) {
    items.push(
      { id: "separator", separator: true },
      {
        id: "remove-history",
        label: isComic ? "删除最近阅读记录" : "删除最近浏览记录",
        icon: <TrashIcon size={12} />,
      },
    );
  }
  items.push(
    { id: "separator", separator: true },
    {
      id: "explorer",
      label: "在文件管理器中打开",
      icon: <ArrowUpRightIcon size={12} />,
      disabled: !actions.canOpenInExplorer,
    },
    { id: "copy", label: "复制链接", icon: <CopyIcon size={12} /> },
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
            // 写入失败要出声：收藏列表不会自己更新，失败时用户看不到任何反馈。
            void toggle(resourceId)
              .then(() =>
                pushToast({
                  kind: "success",
                  message: favorites.includes(resourceId)
                    ? "已取消收藏"
                    : "已加入收藏",
                  ttl: 1200,
                }),
              )
              .catch(() =>
                pushToast({ kind: "error", message: "收藏失败，请稍后重试" }),
              );
            break;
          case "explorer":
            void actions
              .openInExplorer()
              .then(() =>
                pushToast({
                  kind: "success",
                  message: "已请求打开目录",
                  ttl: 1200,
                }),
              )
              .catch((error: unknown) =>
                pushToast({
                  kind: "error",
                  message: fileManagerErrorMessage(error),
                }),
              );
            break;
          case "copy":
            // 菜单关闭后仍反馈结果，权限受限时由共享复制函数尝试选区回退。
            void actions
              .copyLink()
              .then(() =>
                pushToast({
                  kind: "success",
                  message: "已复制链接",
                  ttl: 1200,
                }),
              )
              .catch(() =>
                pushToast({
                  kind: "error",
                  message: "复制失败，请检查浏览器权限",
                }),
              );
            break;
          case "properties":
            onShowProperties(resourceId);
            break;
          case "mark-read":
            // 菜单随即卸载；使用 Promise 继续反馈写入结果，缓存由 mutation 同步。
            void markRead
              .mutateAsync({
                albumId: resourceId,
                total: imageCount,
              })
              .then(() =>
                pushToast({
                  kind: "success",
                  message: `已${copy.finishVerb}`,
                  ttl: 1200,
                }),
              )
              .catch(() => pushToast({ kind: "error", message: "标记失败" }));
            break;
          case "unmark-read":
            void resetRead
              .mutateAsync({ albumId: resourceId })
              .then(() =>
                pushToast({
                  kind: "success",
                  message: `已重置为${copy.unreadTitle}`,
                  ttl: 1200,
                }),
              )
              .catch(() => pushToast({ kind: "error", message: "重置失败" }));
            break;
          case "remove-history":
            onRemoveHistory?.(resourceId);
            break;
        }
        onClose();
      }}
    />
  );
}
