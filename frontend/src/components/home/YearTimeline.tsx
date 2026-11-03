// 时间线组件：主页核心导航（海报式 / 封面为主）
//
// 设计目标：
//   - 通用：漫画 / 相册 都按「时间」作为第一导航轴
//   - 视觉：每个年份 = 一张海报卡（封面整张为主，年份大字浮在左上）
//   - 比例：aspect-[4/5]（竖向）— 避开之前 ~440x120 超宽矩形裁切照片的问题
//   - 交互：
//       * 主点击 → 单 album 年份：navigate 进 album 详情
//                 多 album 年份（含"其他"）：触发年份筛选 + 滚到下方"全部图像"
//       * 右上角小漏斗 → 显式切换年份筛选（不抢主点击）
//   - 预览布局（卡内封面区）：
//       1 张 → 整张封面
//       2-4 张 → 2x2 拼接
//       5+ 张 → 2x2 + 第 4 格显示 "+N 更多" 角标
//       0 张 → 纯色背景 + 中央显示年份（不画"破损图片"图标）

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { RefObject } from 'react'
import { thumbUrl } from '../../api/thumbs'
import { useSearchStore } from '../../store/searchStore'
import type { YearGroup } from '../../utils/albumGrouping'
import {
  PlayFilledIcon,
  ImageIcon,
  FolderIcon,
} from '../common/Icon'

interface Props {
  groups: YearGroup[]
  /** "全部图像" section 的 ref；触发筛选后自动滚到那里。 */
  gridRef?: RefObject<HTMLDivElement>
}

export default function YearTimeline({ groups, gridRef }: Props) {
  if (groups.length === 0) return null

  return (
    // 注意：不要再套一层 .page-shell —— 调用方（Home.tsx）的 section 已经是
    // page-shell，嵌套会让整块凭空多出左右各 32px 内边距，与上下区块错位。
    <div data-testid="year-timeline">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(196px,1fr))] gap-3 lg:gap-4">
        {groups.map((g) => (
          <YearCard key={g.year ?? 'other'} group={g} gridRef={gridRef} />
        ))}
      </div>
    </div>
  )
}

function YearCard({
  group,
  gridRef,
}: {
  group: YearGroup
  gridRef?: RefObject<HTMLDivElement>
}) {
  const navigate = useNavigate()
  const yearFilter = useSearchStore((s) => s.yearFilter)
  const toggleYear = useSearchStore((s) => s.toggleYearFilter)

  // 代表封面可能取不到：文件已被删除（404）或格式无法解码（415）。
  // 直接渲染 <img> 会露出浏览器的破图图标，比空白还难看 ——
  // 这里降级成"年份 + 计数"的纯色卡，信息不丢。
  const [coverFailed, setCoverFailed] = useState(false)

  const isOther = group.year === null
  const isActive = yearFilter === (group.year ?? 'other')
  const canOpenDirectly = group.albums.length === 1

  // 过滤掉空 coverPath
  const validCovers = useMemo(
    () => group.coverPreviewPaths.filter((p): p is string => !!p),
    [group.coverPreviewPaths],
  )
  const totalCovers = group.albums.length

  // 触发年份筛选 + 滚到下方"全部图像"区
  const triggerFilter = () => {
    toggleYear(group.year ?? 'other')
    requestAnimationFrame(() => {
      gridRef?.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  // 主点击：单 album → 直接打开；多 album → 触发筛选
  const onCardActivate = () => {
    if (canOpenDirectly) {
      navigate(group.albums[0].to)
    } else {
      triggerFilter()
    }
  }

  const onCardKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onCardActivate()
    }
  }

  return (
    // 外层只负责定位与裁剪尺寸；真正可点击的是 role=button 的年份卡。
    // 筛选按钮放在卡片的兄弟位置，而不是嵌套在 role=button 内部：
    // 嵌套会让按钮上的 Enter/Space 冒泡到卡片并触发主操作（打开相册），
    // 同时把按钮的 aria-label 拼进卡片的可访问名。
    // 宽幅「胶片条」构图，而不是竖向海报：
    // 2x2 马赛克在 240px 的年份格里每块只有 ~85px，全是看不清的缩略图，
    // 读起来像"一片糊"；宽幅单张代表封面 + 年份大字既清楚，又更像
    // 按时间排列的一格格胶片。
    <div className="group relative aspect-[16/9]">
      <div
        role="button"
        tabIndex={0}
        onClick={onCardActivate}
        onKeyDown={onCardKeyDown}
        aria-pressed={isActive}
        className={`absolute inset-0 rounded-xl overflow-hidden cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 border transition-shadow duration-200 ${
          isActive
            ? 'border-accent shadow-lg ring-2 ring-accent/40'
            : 'border-border hover:shadow-lg'
        }`}
      >
        {/* === 封面区 === */}
        {validCovers.length === 0 || coverFailed ? (
          // 没有可用封面（本来就没有 / 加载失败）：纯色底 + 年份，
          // 不露出浏览器的破图图标。
          <div className="absolute inset-0 bg-bg-subtle flex flex-col items-center justify-center">
            {validCovers.length === 0 && (
              <div className="text-[12.5px] text-fg-subtle font-medium">
                {isOther ? '未分类' : '年份'}
              </div>
            )}
            <div
              className={`font-display leading-none tracking-[-0.03em] tabular-nums ${
                validCovers.length === 0 ? 'mt-1 ' : ''
              }${
                isOther
                  ? 'text-2xl font-semibold text-fg-muted'
                  : 'text-4xl font-semibold text-fg-muted'
              }`}
            >
              {group.label}
            </div>
          </div>
        ) : (
          // 单张代表封面铺满整格。年份信息由左上角的年份大字与
          // 左下角的统计承担，不再需要多格拼贴。
          <img
            src={thumbUrl(validCovers[0])}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setCoverFailed(true)}
            className="absolute inset-0 w-full h-full object-cover group-hover:scale-[1.04] transition-transform duration-500"
          />
        )}

        {/* === 顶部渐变 + 年份大字（左上）===
             年份数字压在任意封面之上：封面可能是白底文档（2020 那一格）、
             也可能是雪景。除了压一层更实的顶部渐变，还给文字加一圈深色
             光晕（text-shadow），保证白字在任何封面亮度下都读得出来 ——
             只靠渐变的话，数字下缘正好落在渐变最弱处。 */}
        {validCovers.length > 0 && !coverFailed && (
          <div className="absolute top-0 left-0 right-0 p-3.5 sm:p-4 bg-gradient-to-b from-black/85 via-black/55 to-transparent pointer-events-none">
            <div
              className={`font-display leading-none tracking-[-0.03em] tabular-nums text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.85),0_2px_14px_rgba(0,0,0,0.75)] ${
                isOther
                  ? 'text-lg sm:text-xl font-semibold'
                  : 'text-[22px] sm:text-[26px] font-semibold'
              }`}
            >
              {group.label}
            </div>
          </div>
        )}

        {/* === 底部渐变 + 统计（左下）=== */}
        <div className="absolute bottom-0 left-0 right-0 p-3 sm:p-3.5 bg-gradient-to-t from-black/85 via-black/45 to-transparent">
          <div className="flex items-center gap-2.5 text-[12.5px] text-white/95 tabular-nums [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">
            <span className="inline-flex items-center gap-1">
              <ImageIcon size={10} className="text-white/70" />
              <span>{formatNum(group.imageTotal)}</span>
            </span>
            {group.videoTotal > 0 && (
              <span className="inline-flex items-center gap-1">
                <PlayFilledIcon size={8} className="text-white" />
                <span>{formatNum(group.videoTotal)}</span>
              </span>
            )}
            <span className="ml-auto inline-flex items-center gap-1 text-white/70">
              <FolderIcon size={10} />
              <span>{totalCovers}</span>
            </span>
          </div>
        </div>
      </div>

      {/* === 筛选小按钮：右上角漏斗 ===
           只切换 yearFilter（不触发主点击，不导航）。给已熟悉筛选语义的用户用。
           它是年份卡的兄弟节点：焦点停在按钮上时 Enter/Space 不会被卡片接管。 */}
      <button
        type="button"
        onClick={() => triggerFilter()}
        title={isActive ? '取消筛选' : '只筛选该年份'}
        aria-label={isActive ? '取消年份筛选' : '筛选该年份'}
        className={`absolute top-2 right-2 z-10 inline-flex items-center justify-center w-7 h-7 rounded-md backdrop-blur transition-colors ${
          isActive
            ? 'bg-accent text-accent-contrast'
            : 'bg-black/45 text-white/90 hover:bg-black/65 hover:text-white'
        }`}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M3 6h18M7 12h10M10 18h4" />
        </svg>
      </button>
    </div>
  )
}

function formatNum(n: number): string {
  return n.toLocaleString('zh-CN')
}
