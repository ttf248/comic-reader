import { forwardRef, useCallback, useState, type ReactNode } from "react";
import { Virtuoso, VirtuosoGrid, type ListProps } from "react-virtuoso";
import AlbumCard, { type CardData } from "./AlbumCard";
import AlbumContextMenu from "./AlbumContextMenu";
import PropertiesDialog from "../common/PropertiesDialog";
import { useFavorites } from "../../hooks/useFavorites";
import { decodeFavPath } from "../../utils/path";
import { useUIStore, type ViewMode } from "../../store/uiStore";

export type { CardData } from "./AlbumCard";

interface Props {
  items: CardData[];
  empty?: ReactNode;
  variant?: ViewMode;
  /** 把「上次 X · 看到 Y/Z」显示在每张卡上（仅 Recents 列表传 true） */
  showLastSeen?: boolean;
}

const VirtualList = forwardRef<HTMLDivElement, ListProps>(function VirtualList(
  { children, style },
  ref,
) {
  // 列表视图铺满内容宽度：信息列右对齐后逐行对齐，便于扫读；
  // 之前限制 max-w-4xl 会让右半屏空着，一屏能看的条目比网格视图还少。
  return (
    <div ref={ref} style={style} className="px-6 lg:px-10 py-2">
      {children}
    </div>
  );
});

const virtualListComponents = { List: VirtualList };

// 网格 / 列表容器。
// 跟随最近的滚动区域虚拟化：筛选结果可以很大，但只挂载视口附近的卡片。
// 列表视图下，悬停时显示右侧 chevron。
// 右键菜单统一：打开 / 收藏 / 阅读标记 / 资源管理器 / 复制链接 / 属性。
export default function AlbumGrid({
  items,
  empty,
  variant = "grid",
  showLastSeen,
}: Props) {
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    item: CardData;
  } | null>(null);
  const [propertiesId, setPropertiesId] = useState<string | null>(null);
  const [scrollParent, setScrollParent] = useState<HTMLElement>();
  const bindScrollParent = useCallback((container: HTMLDivElement | null) => {
    if (!container) return;
    let parent = container.parentElement;
    while (parent && parent !== document.body) {
      // 占位高度还未生成时也要绑定；集合页优先使用自己的内层滚动区。
      if (/(auto|scroll|overlay)/.test(getComputedStyle(parent).overflowY)) {
        setScrollParent(parent);
        return;
      }
      parent = parent.parentElement;
    }
    setScrollParent(undefined);
  }, []);
  const viewMode = useUIStore((s) => s.viewMode);
  const mode = variant ?? viewMode;

  const { favorites } = useFavorites();

  if (items.length === 0) return <>{empty}</>;

  const renderCard = (it: CardData) => {
    const favPath =
      it.variant === "smart" ? `smart:${it.title}` : decodeFavPath(it.to);
    const isFav = favorites.includes(favPath);
    return (
      <AlbumCard
        data={{ ...it, isFavorite: isFav }}
        variant={mode}
        showLastSeen={showLastSeen}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, item: it });
        }}
      />
    );
  };

  return (
    <div ref={bindScrollParent}>
      {mode === "list" ? (
        <Virtuoso
          customScrollParent={scrollParent}
          useWindowScroll={!scrollParent}
          data={items}
          components={virtualListComponents}
          computeItemKey={(_index, item) => item.id}
          increaseViewportBy={{ top: 720, bottom: 1080 }}
          itemContent={(_index, item) => renderCard(item)}
        />
      ) : (
        <VirtuosoGrid
          customScrollParent={scrollParent}
          useWindowScroll={!scrollParent}
          data={items}
          computeItemKey={(_index, item) => item.id}
          increaseViewportBy={{ top: 720, bottom: 1080 }}
          listClassName="px-6 lg:px-10 pt-2 pb-10 grid gap-x-5 gap-y-7 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6"
          itemClassName="min-w-0"
          itemContent={(_index, item) => renderCard(item)}
        />
      )}
      {menu && (
        <AlbumContextMenu
          item={menu.item}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onShowProperties={setPropertiesId}
        />
      )}
      <PropertiesDialog
        target={propertiesId ? { kind: "node", id: propertiesId } : null}
        onClose={() => setPropertiesId(null)}
      />
    </div>
  );
}
