import {
  Fragment,
  forwardRef,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Virtuoso, VirtuosoGrid, type ListProps } from "react-virtuoso";
import AlbumCard, { type CardData, type CoverRatio } from "./AlbumCard";
import AlbumContextMenu from "./AlbumContextMenu";
import PropertiesDialog from "../common/PropertiesDialog";
import { useFavorites } from "../../hooks/useFavorites";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { favoriteResourceId } from "../../utils/path";
import { useUIStore, type ViewMode } from "../../store/uiStore";

export type { CardData } from "./AlbumCard";

interface Props {
  items: CardData[];
  empty?: ReactNode;
  variant?: ViewMode;
  /** 把「上次 X · 看到 Y/Z」显示在每张卡上（仅 Recents 列表传 true） */
  showLastSeen?: boolean;
  /** 是否显示「新」角标（整页都是未读的列表关掉） */
  showUnreadBadge?: boolean;
  /**
   * 封面画幅。不同页面的语义不同，画幅也不同：
   * - 收藏页 = 精选陈列 → 2:3 海报比例，网格更疏；
   * - 未读 / 最近 / 全部图像 = 清单与浏览 → 4:5，网格更密。
   */
  coverRatio?: CoverRatio;
  /** 网格列宽下限。越大越疏朗。 */
  cardMinWidth?: 164 | 224;
}

// 宽屏（≥1280px）列表改双列：单列时标题与右侧数字之间会空出几百到上千像素，
// 眼睛要横跨整屏才能对上数字，信息密度只有网格视图的一半。
//
// 阈值按**内容宽度**定的，不是随手取的整数：内容宽 = 视口 − 侧栏 208 −
// 左右留白 80。1280px 视口 → 内容 1072 → 双列每列 516 → 标题列还有
// 350px，标题不会被截断；再窄（1024 → 内容 816 → 每列 388 → 标题列
// 222px）就会截断，所以阈值留在 1280。
const ULTRA_WIDE_QUERY = "(min-width: 1280px)";

const VirtualList = forwardRef<HTMLDivElement, ListProps>(function VirtualList(
  { children, style },
  ref,
) {
  // 列表视图铺满内容宽度：信息列右对齐后逐行对齐，便于扫读；
  // 之前限制 max-w-4xl 会让右半屏空着，一屏能看的条目比网格视图还少。
  // 宽屏（≥1280px）改双列，单列时标题与右侧数字之间会空出几百像素。
  // 左右留白由调用方的 page-shell 统一提供，这里不再重复加 padding。
  return (
    <div ref={ref} style={style} className="py-1">
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
  showUnreadBadge = true,
  coverRatio = "4/5",
  cardMinWidth = 164,
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
  // 列表视图在超宽屏切成双列。
  const ultraWide = useMediaQuery(ULTRA_WIDE_QUERY);

  const { favorites } = useFavorites();

  /* Tailwind 的 JIT 只认源码里的字面量类名，写成模板字符串
     (`grid-cols-[...minmax(${cardMinWidth}px...)]`) 不会被生成 ——
     所以两个宽度各写一个字面量类名，在这里二选一。 */
  const gridColsClass =
    cardMinWidth === 224
      ? "grid-cols-[repeat(auto-fill,minmax(224px,1fr))]"
      : "grid-cols-[repeat(auto-fill,minmax(164px,1fr))]";

  // 列表按列数分组：一列时每组一张卡，两列时每组两张并排。
  // 分组后交给 Virtuoso 渲染，行高一致（列表行固定高度），
  // 虚拟滚动的行高计算才不会出错。
  const listRows = useMemo(() => {
    if (mode !== "list") return [];
    const columns = ultraWide ? 2 : 1;
    if (columns === 1) return items.map((item) => [item]);
    const rows: CardData[][] = [];
    for (let i = 0; i < items.length; i += columns) {
      rows.push(items.slice(i, i + columns));
    }
    return rows;
  }, [items, mode, ultraWide]);

  if (items.length === 0) return <>{empty}</>;

  const renderCard = (it: CardData) => {
    const isFav = favorites.includes(favoriteResourceId(it));
    return (
      <AlbumCard
        data={{ ...it, isFavorite: isFav }}
        variant={mode}
        showLastSeen={showLastSeen}
        showUnreadBadge={showUnreadBadge}
        coverRatio={coverRatio}
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
          data={listRows}
          components={virtualListComponents}
          computeItemKey={(_index, row) => row[0]?.id ?? _index}
          increaseViewportBy={{ top: 720, bottom: 1080 }}
          itemContent={(_index, row) => (
            <div
              className={`grid gap-x-10 ${ultraWide ? "grid-cols-2" : "grid-cols-1"}`}
            >
              {row.map((card) => (
                <Fragment key={card.id}>{renderCard(card)}</Fragment>
              ))}
            </div>
          )}
        />
      ) : (
        <VirtuosoGrid
          customScrollParent={scrollParent}
          useWindowScroll={!scrollParent}
          data={items}
          computeItemKey={(_index, item) => item.id}
          increaseViewportBy={{ top: 720, bottom: 1080 }}
          /* 列数由容器宽度决定（auto-fill + minmax），不用固定的
             grid-cols-6：固定列数在宽屏上只填 6 列、右侧留一整块空白，
             而条目数不足 6 时最后一列又空着。
             minmax 的下限按页面语义给：收藏（精选陈列）用 224px 疏朗网格，
             未读 / 最近 / 全部图像（清单与浏览）用 164px 密集网格。 */
          listClassName={`pt-2 pb-10 grid gap-x-5 gap-y-8 ${gridColsClass}`}
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
