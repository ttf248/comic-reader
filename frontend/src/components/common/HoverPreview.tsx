import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { thumbUrl } from '../../api/thumbs'
import { timeAgo } from '../../utils/date'
import { workbenchCopy } from '../../utils/workbench'
import VideoCoverImage from './VideoCoverImage'
import {
  FolderIcon,
  ReaderIcon,
  ImageIcon,
  CalendarIcon,
  PlayFilledIcon,
} from './Icon'
import type { CardData } from '../album/AlbumCard'

interface Props {
  data: CardData
  /** 触发预览的卡片 DOMRect（getBoundingClientRect）。 */
  anchorRect: DOMRect
  /** 上次看过的时间（ISO）；无则不显示。 */
  lastSeenAt?: string | null
  /** 鼠标进入预览：父组件应取消正在等待的关闭 timer。 */
  onPointerEnter?: () => void
  /** 鼠标离开预览：父组件应安排关闭 timer。 */
  onPointerLeave?: () => void
}

// 悬停预览：在卡片右侧（或左侧）弹出一个更大、更详细的卡片。
// 设计：
//   - 4:5 比例封面（比网格卡片大 ~2x）
//   - 标题 + 副标题 + 张数 + 上次看过（照片说「浏览」，漫画说「阅读」）
//   - 智能集合：附 4 张缩略图 strip
//   - 默认靠右，溢出视口则靠左
//   - 垂直方向：尽量对齐卡片中心；上下溢出则夹紧
//     （夹紧按"封面 + 信息区"的整体高度算，只按封面算会把信息区裁到视口外）
//   - 通过 portal 渲染到 body，避免 transform / overflow 裁剪
const COVER_W = 240
const COVER_H = 300
const GAP = 14
const MARGIN = 12 // 视口边距

export default function HoverPreview({ data, anchorRect, lastSeenAt, onPointerEnter, onPointerLeave }: Props) {
  // 客户端尺寸（避免 SSR 不一致；本项目无 SSR，加 useState 仅为防御性）
  const [vp, setVp] = useState({ w: 0, h: 0 })
  // 预览整体高度：封面固定 300，信息区随内容（标题行数、有无进度条）变化，
  // 垂直夹紧必须用实测高度，否则靠近视口下缘时信息区会被裁掉。
  const boxRef = useRef<HTMLDivElement>(null)
  const [boxHeight, setBoxHeight] = useState(COVER_H)

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const h = el.offsetHeight
    setBoxHeight((prev) => (Math.abs(prev - h) < 1 ? prev : h))
  })

  useEffect(() => {
    const update = () => setVp({ w: window.innerWidth, h: window.innerHeight })
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [])

  if (vp.w === 0 || vp.h === 0) return null

  // 水平：默认在右侧；右侧放不下则放左侧
  const wantRight = anchorRect.right + GAP + COVER_W + MARGIN <= vp.w
  const left = wantRight
    ? anchorRect.right + GAP
    : Math.max(MARGIN, anchorRect.left - GAP - COVER_W)

  // 垂直：先居中，再夹紧到视口
  const idealTop = anchorRect.top + anchorRect.height / 2 - COVER_H / 2
  const top = Math.max(
    MARGIN,
    Math.min(idealTop, vp.h - boxHeight - MARGIN),
  )

  const isCollection = data.variant === 'collection'

  // 措辞与单位跟着这张卡自己的属性走，而不是跟着当前工作台：
  // 悬停预览出现在两侧共用的卡片上，卡片属于照片还是漫画服务端恒给得出。
  const kind = data.contentKind ?? 'photo'
  const copy = workbenchCopy(kind)
  // 阅读进度只属于漫画：照片相册没有进度可言，预览里也不该出现进度条。
  const isComic = kind === 'comic'

  return createPortal(
    <div
      ref={boxRef}
      role="dialog"
      aria-label={`预览 ${data.title}`}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      style={{
        position: 'fixed',
        top,
        left,
        width: COVER_W,
        zIndex: 100,
      }}
      className="select-none"
    >
      <div className="bg-bg-elevated border border-border rounded-xl shadow-lg overflow-hidden scale-fade">
        {/* 封面 */}
        <div className="relative bg-bg-subtle" style={{ width: COVER_W, height: COVER_H }}>
          {data.coverPath ? (
            data.coverKind === 'video' ? (
              <VideoCoverImage
                videoPath={data.coverPath}
                alt={data.title}
                loading="eager"
                showExtractingHint={false}
              />
            ) : (
              <img
                src={thumbUrl(data.coverPath)}
                alt={data.title}
                className="w-full h-full object-cover"
              />
            )
          ) : (
            <div className="w-full h-full flex items-center justify-center text-fg-subtle">
              <FolderIcon size={36} />
            </div>
          )}
          {/* 顶部暗角：让标题更易读 */}
          <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/35 to-transparent pointer-events-none" />
          {/* 视频角标：▶ + 数量 */}
          {data.coverKind === 'video' && (
            <div className="absolute top-3 left-3 inline-flex items-center gap-1 bg-bg-elevated/90 backdrop-blur text-fg text-[11.5px] font-medium px-2 py-0.5 rounded-md shadow-sm">
              <PlayFilledIcon size={10} className="text-accent" />
              <span>视频</span>
            </div>
          )}
          {/* 底部渐变：放张数 / 标签 */}
          <div className="absolute inset-x-0 bottom-0 px-3 py-2.5 bg-gradient-to-t from-black/60 to-transparent">
            <div className="flex items-center gap-1.5 text-white/90 text-[11.5px] tabular-nums">
              <ImageIcon size={11} />
              <span>
                {data.count} {isCollection ? copy.collectionUnit : copy.mediaUnit}
              </span>
            </div>
          </div>
        </div>

        {/* 信息 */}
        <div className="p-3.5 space-y-2.5">
          <div>
            <div className="text-[14px] font-medium text-fg leading-snug line-clamp-2">
              {data.title}
            </div>
            {data.subtitle && (
              <div className="text-[12.5px] text-fg-muted mt-1 truncate">{data.subtitle}</div>
            )}
          </div>

          {/* 上次看过：仅在 album 类型有意义。
              动词跟着这一侧走——照片说「浏览」，漫画说「阅读」。 */}
          {data.variant === 'album' && (
            <div className="flex items-center gap-1.5 text-[12.5px] text-fg-muted">
              <CalendarIcon size={11} className="text-fg-subtle shrink-0" />
              <span className="truncate">
                {lastSeenAt
                  ? `上次${copy.lastSeenVerb} ${timeAgo(lastSeenAt)}`
                  : copy.neverSeenLabel}
              </span>
            </div>
          )}

          {/* 进度条：仅漫画相册且有进度时显示。照片相册没有进度可言。 */}
          {isComic && data.variant === 'album' && data.progress && data.progress.total > 0 && (
            <div>
              <div className="flex items-center justify-between text-[11.5px] text-fg-subtle mb-1">
                <span className="inline-flex items-center gap-1">
                  <ReaderIcon size={10} />
                  <span>阅读进度</span>
                </span>
                <span className="tabular-nums">
                  {Math.min(
                    100,
                    Math.round(
                      (data.progress.index / Math.max(1, data.progress.total - 1)) * 100,
                    ),
                  )}
                  %
                </span>
              </div>
              <div className="h-1 bg-bg-subtle rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent"
                  style={{
                    width: `${Math.min(
                      100,
                      Math.round(
                        (data.progress.index / Math.max(1, data.progress.total - 1)) * 100,
                      ),
                    )}%`,
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
