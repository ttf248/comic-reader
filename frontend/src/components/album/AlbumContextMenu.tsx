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
import { copyForAlbum } from "../../utils/workbench";
import { useAlbumClassification } from "../../hooks/useAlbumClassification";
import { useUIStore } from "../../store/uiStore";
import {
  ArrowRightLineIcon,
  StarIcon,
  ArrowUpRightIcon,
  CopyIcon,
  InfoIcon,
  CheckIcon,
  RewindIcon,
  ImageIcon,
  RefreshIcon,
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
  const resourceId = favoriteResourceId(item);
  const imageCount = item.imageCount ?? item.progress?.total ?? item.count;
  const completed = isCompleted(item.progress);
  // 措辞跟相册自身的用途走：照片是「已看完」，漫画是「已读完」。
  const kind = item.contentKind ?? "photo";
  const copy = copyForAlbum(kind);
  // 归类动作：把相册移到另一种打开方式，或恢复默认归类。
  const classification = useAlbumClassification(resourceId);
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
  // 归类：把相册移到另一种打开方式。它会清掉另一种用途留下的进度，
  // 所以放在菜单里当一次明确的动作，而不是页头常驻的开关。
  if (isAlbum) {
    items.push({ id: "separator", separator: true });
    if (item.contentKind === "comic") {
      items.push({
        id: "classify-photo",
        label: "移到照片库",
        icon: <ImageIcon size={12} />,
      });
    } else {
      items.push({
        id: "classify-comic",
        label: "移到漫画库",
        icon: <ImageIcon size={12} />,
      });
    }
    if (item.contentKindOverridden) {
      items.push({
        id: "classify-reset",
        label: "恢复默认类型",
        icon: <RefreshIcon size={12} />,
      });
    }
  }
  items.push(
    { id: "separator", separator: true },
    {
      id: "explorer",
      label: "在资源管理器中打开",
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
                contentKind: kind,
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
              .mutateAsync({
                albumId: resourceId,
                contentKind: item.contentKind,
              })
              .then(() =>
                pushToast({
                  kind: "success",
                  message: `已重置为${copy.unreadTitle}`,
                  ttl: 1200,
                }),
              )
              .catch(() => pushToast({ kind: "error", message: "重置失败" }));
            break;
          case "classify-photo":
            void classification.moveTo.mutateAsync("photo");
            break;
          case "classify-comic":
            void classification.moveTo.mutateAsync("comic");
            break;
          case "classify-reset":
            void classification.resetToDefault.mutateAsync();
            break;
        }
        onClose();
      }}
    />
  );
}
