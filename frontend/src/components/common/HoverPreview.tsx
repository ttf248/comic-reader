import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { timeAgo } from '../../utils/date'
import { progressPercent } from '../../utils/progress'
import { albumCountUnit, workbenchCopy } from '../../utils/workbench'
import { decodeFavPath } from '../../utils/path'
import { useAlbumMedia } from '../../hooks/useLibrary'
import {
  ReaderIcon,
  ImageIcon,
  CalendarIcon,
  PlayFilledIcon,
} from './Icon'
import CardCover from '../album/CardCover'
import ThumbImage from './ThumbImage'
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
//   - 封面画幅跟着这一侧走：照片是方的（展陈墙），漫画是竖的（书脊）——
//     预览里的画幅跟网格卡对不上，等于同一本相册有两个形状
//   - 标题 + 副标题 + 张数 + 上次看过（照片说「浏览」，漫画说「阅读」）
//   - 默认靠右，溢出视口则靠左
//   - 垂直方向：尽量对齐卡片中心；上下溢出则夹紧
//     （夹紧按"封面 + 信息区"的整体高度算，只按封面算会把信息区裁到视口外）
//   - 通过 portal 渲染到 body，避免 transform / overflow 裁剪
const COVER_W = 240
/** 漫画：4:5 竖版封面，与网格卡的画幅一致。 */
const COVER_H_COMIC = 300
/** 照片：1:1 方形封面。 */
const COVER_H_PHOTO = 240
const GAP = 14
const MARGIN = 12 // 视口边距

export default function HoverPreview({ data, anchorRect, lastSeenAt, onPointerEnter, onPointerLeave }: Props) {
  // 客户端尺寸（避免 SSR 不一致；本项目无 SSR，加 useState 仅为防御性）
  const [vp, setVp] = useState({ w: 0, h: 0 })
  // 预览整体高度：封面高度固定，信息区随内容（标题行数、有无进度条）变化，
  // 垂直夹紧必须用实测高度，否则靠近视口下缘时信息区会被裁掉。
  const boxRef = useRef<HTMLDivElement>(null)
  const [boxHeight, setBoxHeight] = useState(COVER_H_COMIC)

  // 措辞与单位跟着这张卡自己的属性走，而不是跟着当前工作台：
  // 悬停预览出现在两侧共用的卡片上，卡片属于照片还是漫画服务端恒给得出。
  const kind = data.contentKind ?? 'photo'
  // 阅读进度只属于漫画：照片相册没有进度可言，预览里也不该出现进度条。
  const isComic = kind === 'comic'
  // 百分比口径与卡片、列表、首屏一致，避免同一本书在几处显示不同的进度。
  const progressPct = progressPercent(data.progress)
  const coverH = isComic ? COVER_H_COMIC : COVER_H_PHOTO

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

  const isCollection = data.variant === 'collection'
  const copy = workbenchCopy(kind)

  // 照片相册的悬停预览给「里面有什么」：直接铺这一本的前几张实拍。
  // 只放大封面等于把卡片上的那张图再放一遍 —— 照片库里真正的问题
  // 是「这本里有什么」，答案得来自照片本身。
  // 集合卡不参与：集合的封面本来就是多张拼贴。
  //
  // 这两个 hook 必须在下面的提前 return 之前：hook 的调用顺序在两次
  // 渲染之间必须一致，早退分支跳过它们就会触发 React 的
  // 「渲染的 hook 比上一次多」错误。
  const albumId = !isComic && !isCollection ? decodeFavPath(data.to) : ''
  const mediaQuery = useAlbumMedia(albumId)
  const previewItems = useMemo(() => {
    const items = mediaQuery.data?.pages[0]?.items ?? []
    return items.filter((item) => item.kind === 'image').slice(0, 4)
  }, [mediaQuery.data])

  if (vp.w === 0 || vp.h === 0) return null

  // 水平：默认在右侧；右侧放不下则放左侧
  const wantRight = anchorRect.right + GAP + COVER_W + MARGIN <= vp.w
  const left = wantRight
    ? anchorRect.right + GAP
    : Math.max(MARGIN, anchorRect.left - GAP - COVER_W)

  // 垂直：先居中，再夹紧到视口
  const idealTop = anchorRect.top + anchorRect.height / 2 - coverH / 2
  const top = Math.max(
    MARGIN,
    Math.min(idealTop, vp.h - boxHeight - MARGIN),
  )

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
      {/* 圆角用 --radius-tile（16px）：这是一个浮起的卡片，不是面板。 */}
      <div className="bg-bg-elevated border border-border rounded-lg shadow-lg overflow-hidden scale-fade">
        {/* 封面：与网格卡走同一个渲染入口，卡片是拼贴的卡片在预览里
            也是拼贴 —— 同一本相册不能在两处是两个样子。 */}
        <div
          className={`relative bg-bg-subtle ${
            /* 漫画侧也是一本书（装订边 + 竖版），与网格卡同一套语言。 */
            isComic ? "album-thumb--book" : ""
          }`}
          style={{ width: COVER_W, height: coverH }}
        >
          {previewItems.length > 0 ? (
            /* 实拍拼贴：这一本的前几张照片。2×2 正好铺满方形的预览框，
               与照片墙的观感一致 —— 悬停一下就知道这本书里拍的是什么。 */
            <div className="grid grid-cols-2 grid-rows-2 h-full w-full gap-0.5">
              {previewItems.map((item) => (
                <ThumbImage
                  key={item.id}
                  fileId={item.id}
                  alt=""
                  loading="eager"
                  iconSize={14}
                  className="h-full w-full object-cover"
                />
              ))}
            </div>
          ) : (
            <CardCover data={data} loading="eager" fit="cover" />
          )}
          {/* 顶部暗角：让标题更易读 */}
          <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/35 to-transparent pointer-events-none" />
          {/* 视频角标：▶ + 数量 */}
          {data.coverKind === 'video' && (
            <div className="absolute top-3 left-3 inline-flex items-center gap-1 bg-bg-elevated/90 backdrop-blur text-fg text-meta font-medium px-2 py-0.5 rounded-md shadow-sm">
              <PlayFilledIcon size={10} className="text-accent" />
              <span>视频</span>
            </div>
          )}
          {/* 底部渐变：放张数 / 标签 */}
          <div className="absolute inset-x-0 bottom-0 px-3 py-2.5 bg-gradient-to-t from-black/60 to-transparent">
            <div className="flex items-center gap-1.5 text-white/90 text-meta tabular-nums">
              <ImageIcon size={11} />
              <span>
                {data.count} {isCollection ? albumCountUnit(kind) : copy.mediaUnit}
              </span>
            </div>
          </div>
        </div>

        {/* 信息 */}
        <div className="p-3.5 space-y-2.5">
          <div>
            <div className="text-label font-medium text-fg leading-snug line-clamp-2">
              {data.title}
            </div>
            {data.subtitle && (
              <div className="text-meta text-fg-muted mt-1 truncate">{data.subtitle}</div>
            )}
          </div>

          {/* 上次看过：仅在 album 类型有意义。
              动词跟着这一侧走——照片说「浏览」，漫画说「阅读」。 */}
          {data.variant === 'album' && (
            <div className="flex items-center gap-1.5 text-meta text-fg-muted">
              <CalendarIcon size={11} className="text-fg-subtle shrink-0" />
              <span className="truncate">
                {lastSeenAt
                  ? `上次${copy.lastSeenVerb} ${timeAgo(lastSeenAt)}`
                  : copy.neverSeenLabel}
              </span>
            </div>
          )}

          {/* 进度条：仅漫画相册且真的翻过几页时显示。照片相册没有进度可言。
              0% 时不画 —— 一条空轨道读起来是分隔线，不是进度条；「还没翻开」
              已经由上面的未读标记承担。填充色用品牌色，与列表行、首屏续读
              同一套。 */}
          {isComic && data.variant === 'album' && progressPct !== null && progressPct > 0 && (
            <div>
              <div className="flex items-center justify-between text-meta text-fg-subtle mb-1">
                <span className="inline-flex items-center gap-1">
                  <ReaderIcon size={10} />
                  <span>阅读进度</span>
                </span>
                <span className="tabular-nums">{progressPct}%</span>
              </div>
              <div className="h-1 bg-bg-subtle rounded-full overflow-hidden">
                <div className="h-full bg-brand" style={{ width: `${progressPct}%` }} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
