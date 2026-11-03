import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { thumbUrl } from "../../api/thumbs";
import { previewUrl } from "../../api/images";
import { useFavorites } from "../../hooks/useFavorites";
import { decodeFavPath } from "../../utils/path";
import AlbumCard from "../album/AlbumCard";
import type { CardData } from "../album/AlbumGrid";
import {
  ArrowRightLineIcon,
  CheckIcon,
  CloseIcon,
  FolderIcon,
  ShuffleIcon,
} from "../common/Icon";

// 首页的两种内容呈现：
//
//   1. 「封面台 + 封面墙」ContinueReadingHero —— 一本在读的主封面 + 贴在它
//      下方的进度与操作 + 右侧整栏的其余在读网格；
//   2. 「封面货架」UnreadHero —— 横向排开的一排海报，横向可滚。
//
// 上一版首页用的是"横幅卡"：一张 1340×200 的浅灰盒子，封面只有 140×176，
// CTA 按钮被推到 1000px 之外，右侧整片空白。视觉重量落在空白上而不是内容上，
// 于是首页看起来像后台面板而不是画廊。
//
// 现在的做法：把版面让给封面。封面尺寸、标题字号、按钮距离都按
// "主角 / 次要 / 其它"三档拉开。

/**
 * 「其余在读」网格的条目上限。
 *
 * 12 是刻意选的：能同时被 2 / 3 / 4 / 6 列整除，各断点都不会出现半行
 * （半行会让网格右边缘留一截空位，读起来像没排完）。
 */
const GRID_ITEMS = 12;

/**
 * 网格条目数必须跟着列数走：条目数固定而列数变少时，行数会线性膨胀
 * （12 条在 2 列下是 6 行 ≈ 1500px 高，页面被拉成长条）。
 *
 * 裁剪规则放在 global.css 的 `.stage-grid` 里，和列数写在同一处 ——
 * 列数与条数必须成对（4 列配 8 条、5 列配 10 条、6 列配 12 条），
 * 分成两处维护就会出现"5 列只排 8 条、末行只剩 3 张"的半行。
 *
 * 各断点实际行数：手机 1 行 / 平板 2~3 行 / 桌面 2 行 / 超宽 2 行。
 */

/**
 * 「其余在读」网格的列数。
 *
 * 列数刻意写死而不是用 auto-fill：右栏宽度 = 视口 - 侧栏 - 左栏，
 * 在 1280~1800 之间被 auto-fill 切出的列宽会忽大忽小（150px ↔ 246px），
 * 写死列数后每档的封面宽度虽然也不完全单调，但变化都在 ±30% 以内，
 * 不会在同一屏里出现"忽大忽小"的墙。
 *
 * 列数本身写在 global.css 的 .stage-grid 里（那里还有一条"短屏改 5 列"
 * 的高度联动规则），Tailwind 的 grid-cols-* 工具类不再用于这个网格。
 */
const GRID_COLS = "stage-grid";

/**
 * 「未读」货架的宽度：条目少时撑开把整行铺满，条目多时保持最小宽度并横向滚动。
 *
 * 与「其余在读」用不同策略是有意的：未读是"下一本读什么"的推荐位，
 * 铺满一行更像陈列；「其余在读」是主封面的下级，必须让出层级。
 */
const SHELF_WIDTH = "flex-1 min-w-[148px] max-w-[240px]";

interface UnreadHeroProps {
  cards: CardData[];
  count: number;
  onShuffle: () => void;
  onMarkRead: (card: CardData) => void;
  /**
   * 内嵌模式：区块挂在「继续阅读」舞台的右栏里，而不是独占一整行。
   *
   * 两种模式的差别只有外层包裹：独立区块要自己的 page-shell（对齐全站
   * 网格线、带上边距），内嵌模式不能带 —— 它已经在一个 page-shell 里面，
   * 再套一层会让卡片左缘比同一栏的墙往右缩一截（两条内容线对不上）。
   */
  inline?: boolean;
}

// 首页未读入口：只展示前六本，完整列表交给 /unread 页面。
//
// 版式：横向海报货架。封面等高排开，横向铺满，窄屏可滑动 ——
// 不再是"六张等大的方块"和下面的网格连成一片墙。
export function UnreadHero({
  cards,
  count,
  onShuffle,
  onMarkRead,
  inline = false,
}: UnreadHeroProps) {
  const { favorites } = useFavorites();
  const favoriteIds = useMemo(() => new Set(favorites), [favorites]);
  const visible = cards.slice(0, 6);

  return (
    <section
      className={inline ? "mt-8" : "page-shell pt-2 pb-2"}
      data-testid="unread-hero"
    >
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <h2 className="section-title">未读</h2>
        <span className="section-meta">
          还有 <span className="tabular-nums text-fg font-medium">{count}</span>{" "}
          本没看
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={onShuffle} className="btn btn-sm btn-outline">
            <ShuffleIcon size={12} />
            随机未读
          </button>
          <Link to="/unread" className="btn btn-sm btn-ghost">
            全部
            <ArrowRightLineIcon size={12} />
          </Link>
        </div>
      </div>

      <div
        className={
          inline
            ? /* 内嵌模式：宽屏下这一段要和上面的「其余在读」墙用同一套列宽，
                 两行海报的竖线才对得上（列宽写在 .stage-grid 里，只此一处）。
                 窄屏仍是横向货架：右栏此时是堆叠在主角台下面的，货架更省高度。 */
              "shelf shelf-fade stage-grid stage-shelf"
            : "shelf shelf-fade"
        }
      >
        {visible.map((card) => (
          <div
            key={card.id}
            className={
              inline
                ? `${SHELF_WIDTH} xl:flex-none xl:w-full xl:min-w-0 xl:max-w-none`
                : SHELF_WIDTH
            }
          >
            <AlbumCard
              data={{
                ...card,
                isFavorite: favoriteIds.has(decodeFavPath(card.to)),
              }}
              /* 整个区块都是未读，卡片再挂「新」角标只是噪音 */
              showUnreadBadge={false}
              /* 视频按 16:9 排（封面本来就是横画幅，硬塞进海报比例
                 会留下大片灰条）；图片按 2:3 海报比例。 */
              coverRatio={card.coverKind === "video" ? "16/9" : "2/3"}
              overlayAction={
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onMarkRead(card);
                  }}
                  className="w-7 h-7 rounded-full bg-black/55 text-white/90 hover:bg-accent hover:text-accent-contrast flex items-center justify-center opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 transition-all"
                  title={`将「${card.title}」标记为已读`}
                  aria-label={`将${card.title}标记为已读`}
                >
                  <CheckIcon size={13} />
                </button>
              }
            />
          </div>
        ))}
      </div>
    </section>
  );
}

interface ContinueReadingHeroProps {
  cards: CardData[];
  onContinue: (card: CardData) => void;
  onRemove: (card: CardData) => void;
  onClearAll: () => void;
  /**
   * 右栏的第二段内容。
   *
   * 只有一本在读时没有"其余在读"，右栏会整栏空掉 —— 首页第一屏右侧
   * 1200px 全是空白；在读的相册多起来之后，右栏又会被"墙只有一行"
   * 掏出一块 390px 的空洞（1920 实测）。调用方（首页）把「未读」塞进来，
   * 右栏就有第二段内容："你正在读的"与"接下来读的"并排，两栏也齐平。
   */
  rightSlot?: ReactNode;
}

// 首页继续阅读入口：点击卡片直接进入上次阅读位置。
//
// 版式：「封面台 + 封面墙」。
//   ┌──────────┐   其余在读
//   │  主封面   │   ┌──┐┌──┐┌──┐┌──┐┌──┐┌──┐
//   │  2:3     │   └──┘└──┘└──┘└──┘└──┘└──┘
//   └──────────┘   ┌──┐┌──┐┌──┐┌──┐┌──┐┌──┐
//   AIGC活动选图    └──┘└──┘└──┘└──┘└──┘└──┘
//   看到 5 / 262
//   ▓▓░░░░░░░░░
//   [继续阅读 →] [标记为已读]
//
// 关键约束：
//   - 主封面高度 ≥ 其余在读海报 1.6 倍（"主角 / 次要"必须一眼可分）；
//   - 主按钮与封面紧挨着（同在左栏），旧版相距 ~1000px；
//   - 右栏整栏都是图像，不留"信息栏只占 520px、右侧空 620px"的空洞；
//   - 右栏不能空：只有一本在读时改放「未读」，否则整行右侧会空掉 1200px；
//   - 进度同时用"数字 + 条"两处表达，不只靠一条 3px 细线。
export function ContinueReadingHero({
  cards,
  onContinue,
  onRemove,
  onClearAll,
  rightSlot,
}: ContinueReadingHeroProps) {
  const featured = cards[0];
  // 其余在读最多铺 12 条（见 GRID_ITEMS）。剩下的本子不再往首页堆：
  // 侧栏的「继续阅读」已经列了最近 6 本 + "还有 N 本没看完"，两处都铺满
  // 只会让首页变成索引页，看不到任何一张图的细节。
  const rest = cards.slice(1, 1 + GRID_ITEMS);
  // 右栏有没有内容：其余在读，或者调用方塞进来的替补（首页塞未读）。
  const hasRight = rest.length > 0 || !!rightSlot;

  return (
    <section className="page-shell pt-2 pb-10" data-testid="continue-hero">
      <div className="flex items-center gap-3 flex-wrap mb-5">
        <h2 className="section-title">继续阅读</h2>
        <span className="section-meta">
          <span className="tabular-nums text-fg font-medium">{cards.length}</span>{" "}
          本还没看完
        </span>
        <button
          onClick={onClearAll}
          className="btn btn-sm btn-ghost ml-auto"
          title="把当前所有继续阅读相册标记为已读(不影响收藏 / 最近)"
        >
          <CloseIcon size={11} />
          清空
        </button>
      </div>

      <div className="flex flex-col gap-8 xl:flex-row xl:gap-9">
        {featured && (
          /* 窄屏 / 平板：封面 + 墙签并排，进度与操作落在它们下方；
             宽屏（xl+）：封面独占一列（320px），标题与进度贴在其下。
             平板档用 flex-wrap 让"标题 + 进度"整块换行到封面右侧，
             否则标题右边会拖出一大片空白。
             没有右栏时（整页只有一本在读）改为"封面 + 信息"并排，
             让这一块本身有宽度，而不是在右边空出整屏。 */
          <div
            className={
              hasRight
                ? "shrink-0 xl:w-[320px] 2xl:w-[352px]"
                : "shrink-0 xl:w-[760px] 2xl:w-[800px]"
            }
          >
            <div
              className={`flex flex-wrap gap-4 items-end ${
                hasRight
                  ? "xl:flex-col xl:items-stretch xl:gap-3"
                  : "xl:flex-row xl:items-start xl:gap-8"
              }`}
            >
              <div
                className={`shrink-0 ${
                  hasRight
                    ? "w-[150px] md:w-[var(--stage-cover-w)]"
                    : "w-[150px] md:w-[var(--stage-cover-w)]"
                }`}
              >
                <StagePoster
                  card={featured}
                  onClick={() => onContinue(featured)}
                />
              </div>
              {/* 墙签：标题贴在封面下方，像展厅里的作品说明。
                  宽度跟随封面（不是整栏）：短屏收窄封面时，标题与进度条
                  仍与封面左右对齐。
                  窄屏（<768）改成与封面并排：另起一行时封面右侧会空出
                  一大片（390 下是 150px 封面 + 246px 空白），而且主操作
                  被推到整屏下方。并排后封面、标题、进度与主操作都留在
                  首屏里。 */}
              <div
                className={
                  hasRight
                    ? "w-auto flex-1 min-w-0 md:max-w-[440px] xl:flex-none xl:max-w-none xl:w-[var(--stage-cover-w)]"
                    : "w-auto flex-1 min-w-0 md:max-w-[440px] xl:flex-1 xl:max-w-none"
                }
              >
                <h3
                  className={`hero-title line-clamp-2 ${hasRight ? "xl:mt-3" : ""}`}
                >
                  {featured.title}
                </h3>
                <div className={`mt-3 ${hasRight ? "xl:mt-5" : "xl:mt-4"}`}>
                  <StageInfo
                    card={featured}
                    onContinue={() => onContinue(featured)}
                    onRemove={() => onRemove(featured)}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 右栏：整栏都是图像，填掉旧版信息栏右侧那块空洞。
            替补内容（未读区）也必须裹在 flex-1 min-w-0 里：它是 flex 行的
            直接子元素，不加约束会按自身宽度（.page-shell 的 width:100%）
            撑开，把整行顶出容器 —— 1920 下实测主内容横向溢出 203px。

            右栏现在是**两段**：上面的「其余在读」墙 + 下面的「未读」货架。
            只放墙的话，右栏的高度由条目数决定：真实场景里在读的相册往往
            只有几本，1920 下墙就只剩一行（实测右栏高 300px，左栏 699px），
            墙底到下一个区块之间空出 390px —— 页面看着像没排完。把「未读」
            搬进右栏，右栏就有了第二段内容，两栏高度自然拉平。 */}
        {(rightSlot || rest.length > 0) && (
          <div className="flex-1 min-w-0">
            {rest.length > 0 && (
              <>
                <div className="section-meta mb-4">其余在读</div>
                <div className={`grid ${GRID_COLS} gap-x-3.5 gap-y-7`}>
                  {rest.map((card) => (
                    <MiniPoster
                      key={card.id}
                      card={card}
                      onClick={() => onContinue(card)}
                      onRemove={() => onRemove(card)}
                    />
                  ))}
                </div>
              </>
            )}
            {rightSlot}
          </div>
        )}
      </div>
    </section>
  );
}

// 舞台主封面：2:3 海报比例，明显大于货架海报。
//
// 图片封面走 /api/previews（按宽度等比缩放），避免把 320px 的缩略图
// 放大成 450px 高的主视觉；视频封面没有预览接口，用缩略图 + 深色底，
// 让"画幅不同"看起来是有意的，而不是缺图。
//
// 可访问性约束（回归测试锁定）：
// - 真正可点击的是 role=button 的内容区；「标记为已读」按钮是它的兄弟
//   节点，嵌套会让 Enter/Space 冒泡触发跳转，也会污染卡片的可访问名。
function StagePoster({
  card,
  onClick,
}: {
  card: CardData;
  onClick: () => void;
}) {
  const progress = card.progress;
  const total = progress?.total ?? 0;
  const index = progress?.index ?? 0;
  const percent =
    total > 1
      ? Math.min(100, Math.round((index / Math.max(1, total - 1)) * 100))
      : 0;

  const isVideo = card.coverKind === "video";
  const src = card.coverPath
    ? isVideo
      ? thumbUrl(card.coverPath)
      : previewUrl(card.coverPath, 640)
    : "";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      aria-label={`继续阅读「${card.title}」`}
      className="group relative block w-full aspect-[2/3] rounded-xl overflow-hidden bg-bg-subtle shadow-md cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      {src ? (
        <img
          src={src}
          alt=""
          loading="eager"
          decoding="async"
          className={`w-full h-full group-hover:scale-[1.03] transition-transform duration-500 ${
            isVideo ? "object-contain" : "object-cover object-[50%_30%]"
          }`}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-fg-subtle">
          <FolderIcon size={26} />
        </div>
      )}

      {/* 进度压在封面底边：既是进度，也是这块封面的收尾 */}
      <div className="absolute left-0 right-0 bottom-0 h-[3px] bg-black/45">
        <div
          className="h-full bg-white/95 transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

// 舞台信息栏：进度读数 + 进度条 + 主操作。
//
// 位置在主封面正下方（不是横跨整个右栏）：旧版把信息栏推到右栏最左侧、
// 主按钮推到横幅最右端（与封面相距约 1000px），用户要横跨整屏才能把
// 按钮和封面联系起来。现在按钮离封面不到 100px。
function StageInfo({
  card,
  onContinue,
  onRemove,
}: {
  card: CardData;
  onContinue: () => void;
  onRemove: () => void;
}) {
  const progress = card.progress;
  const total = progress?.total ?? 0;
  const index = progress?.index ?? 0;
  const percent =
    total > 1
      ? Math.min(100, Math.round((index / Math.max(1, total - 1)) * 100))
      : 0;

  return (
    <div>
      <div className="flex items-baseline gap-x-3 gap-y-1 flex-wrap">
        <span className="text-[15px] text-fg font-medium tabular-nums">
          看到 {index + 1} / {total}
        </span>
        {percent > 0 && (
          <span className="text-[13px] text-fg-subtle tabular-nums">
            已读 {percent}%
          </span>
        )}
      </div>

      <div
        className="mt-3 h-1.5 w-full rounded-full bg-bg-strong overflow-hidden"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`「${card.title}」阅读进度`}
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="mt-4 flex items-center gap-2.5 flex-wrap">
        <button type="button" onClick={onContinue} className="btn btn-primary">
          继续阅读
          <ArrowRightLineIcon size={12} />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemove();
          }}
          className="btn btn-sm btn-ghost border border-border-faint"
          title={`将「${card.title}」标记为已读`}
          aria-label={`将${card.title}标记为已读`}
        >
          <CheckIcon size={12} />
          标记为已读
        </button>
      </div>
    </div>
  );
}

// 网格里的次级海报：与主封面同族的卡片，但更小。
//
// 结构与旧版一致（role=button 包住内容，X 按钮是兄弟节点），
// 这样既保留键盘 / 可访问名行为，也让封面成为这一行的视觉主体。
function MiniPoster({
  card,
  onClick,
  onRemove,
}: {
  card: CardData;
  onClick: () => void;
  onRemove: () => void;
}) {
  const progress = card.progress;
  const progressPercent =
    progress && progress.total > 1
      ? Math.min(
          100,
          Math.round((progress.index / Math.max(1, progress.total - 1)) * 100),
        )
      : null;

  return (
    <div className="group relative rounded-lg overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onClick();
          }
        }}
        className="block w-full text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="relative aspect-[2/3] bg-bg-subtle overflow-hidden rounded-lg">
          {card.coverPath ? (
            <img
              src={thumbUrl(card.coverPath)}
              alt=""
              loading="lazy"
              decoding="async"
              className="w-full h-full object-cover object-[50%_30%] group-hover:scale-[1.04] transition-transform duration-500"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-fg-subtle">
              <FolderIcon size={20} />
            </div>
          )}
          {/* 进度角标只在真正读过几页时出现：刚打开过的相册（index=0）
              挂一层暗化蒙版 + 「看到 1 / N」只是噪音。 */}
          {progressPercent !== null && progress && progress.index > 0 && (
            <div className="absolute bottom-0 left-0 right-0 px-2.5 py-2 bg-gradient-to-t from-black/75 to-transparent">
              <div className="text-white/95 text-[11.5px] font-medium tabular-nums">
                看到 {progress.index + 1} / {progress.total}
              </div>
              <div className="mt-1.5 h-0.5 bg-white/25 rounded-full overflow-hidden">
                <div
                  className="h-full bg-white rounded-full"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}
        </div>
        <div className="pt-2.5">
          <div className="text-[14px] font-medium text-fg line-clamp-2 leading-snug group-hover:text-accent transition-colors">
            {card.title}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onRemove();
        }}
        className="absolute top-2 right-2 z-10 w-7 h-7 rounded-full bg-black/55 text-white/90 hover:bg-danger hover:text-white flex items-center justify-center opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 transition-all"
        title={`将「${card.title}」标记为已读`}
        aria-label={`将${card.title}标记为已读`}
      >
        <CloseIcon size={13} />
      </button>
    </div>
  );
}
