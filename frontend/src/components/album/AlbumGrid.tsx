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
import { useAppMode } from "../../hooks/useAppMode";
import { favoriteResourceId } from "../../utils/path";
import { coverRatioForMode } from "../../utils/workbench";
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
   * 当前调用方选择的封面画幅。
   *
   * 不传时按工作台取默认值：照片侧方形（展陈墙），漫画侧竖版（书脊）。
   * 调用方显式传值时以此为准（如收藏页的密集陈列）。
   */
  coverRatio?: CoverRatio;
  /** 网格列宽下限。越大越疏朗。 */
  cardMinWidth?: 164 | 224;
}

// 当前列表在宽屏改为多列；断点与列数是可调整的布局基线。
// 重设计时同步分组方式、条目测量与对应 E2E 的列数断言。
const ULTRA_WIDE_QUERY = "(min-width: 1280px)";

// 当前三列断点，配合现有侧栏和留白计算。
const VERY_WIDE_QUERY = "(min-width: 1600px)";

const VirtualList = forwardRef<HTMLDivElement, ListProps>(function VirtualList(
  { children, style },
  ref,
) {
  // 当前列表复用调用方的页面留白，避免重复内边距。
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
  coverRatio,
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
  const veryWide = useMediaQuery(VERY_WIDE_QUERY);

  const { favorites } = useFavorites();

  // 封面画幅按工作台取默认：照片是方的，漫画是竖的。
  const { mode: workbench } = useAppMode();
  const ratio = coverRatio ?? coverRatioForMode(workbench);

  // 当前提供标准、宽松与书架三套网格，断点由语义样式统一维护。
  // 漫画侧用书架那一套：封面竖版本身就窄，按展陈墙的列宽铺开，
  // 每张卡会撑成巨幅海报，一屏只看得到四本。
  const gridColsClass =
    cardMinWidth === 224
      ? "library-grid library-grid--spacious"
      : workbench === "comic"
        ? "library-grid library-grid--comic"
        : "library-grid";

  // 列表按列数分组：一列时每组一张卡，两列时每组两张并排。
  // 分组后交给 Virtuoso 渲染，行高一致（列表行固定高度），
  // 虚拟滚动的行高计算才不会出错。
  const listRows = useMemo(() => {
    if (mode !== "list") return [];
    const columns = veryWide ? 3 : ultraWide ? 2 : 1;
    if (columns === 1) return items.map((item) => [item]);
    const rows: CardData[][] = [];
    for (let i = 0; i < items.length; i += columns) {
      rows.push(items.slice(i, i + columns));
    }
    return rows;
  }, [items, mode, ultraWide, veryWide]);

  if (items.length === 0) return <>{empty}</>;

  const renderCard = (it: CardData) => {
    const isFav = favorites.includes(favoriteResourceId(it));
    return (
      <AlbumCard
        data={{ ...it, isFavorite: isFav }}
        variant={mode}
        showLastSeen={showLastSeen}
        showUnreadBadge={showUnreadBadge}
        coverRatio={ratio}
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
              className={`grid gap-x-10 ${
                veryWide
                  ? "grid-cols-3"
                  : ultraWide
                    ? "grid-cols-2"
                    : "grid-cols-1"
              }`}
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
