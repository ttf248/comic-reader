import { useGalleryStore, type FitMode } from '../../store/galleryStore'
import {
  FitIcon,
  FitWidthIcon,
  FitHeightIcon,
  OriginalSizeIcon,
  ArrowRightLineIcon,
  ArrowLeftLineIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  PlusIcon,
  MinusIcon,
  RotateIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from '../common/Icon'

interface Props {
  visible: boolean
  onPrev: () => void
  onNext: () => void
  onPrevAlbum?: () => void
  onNextAlbum?: () => void
}

const FIT_OPTIONS: { value: FitMode; label: string; icon: typeof FitIcon }[] = [
  { value: 'fit', label: '适应', icon: FitIcon },
  { value: 'width', label: '按宽', icon: FitWidthIcon },
  { value: 'height', label: '按高', icon: FitHeightIcon },
  { value: 'original', label: '原始', icon: OriginalSizeIcon },
]

// 画廊右侧浮层控件：模式 / 适配 / 缩放 / 旋转 / 阅读方向
//
// 设计：玻璃面板 + 鼠标 idle 时整组淡出（保留顶部常驻条）；
// 在 hover 时显出。按钮顺序自上而下：模式 / 适配 / 缩放 / 旋转 / 方向。
export default function GalleryControls({
  visible,
  onPrev,
  onNext,
  onPrevAlbum,
  onNextAlbum,
}: Props) {
  const mode = useGalleryStore((s) => s.mode)
  const fit = useGalleryStore((s) => s.fit)
  const zoom = useGalleryStore((s) => s.zoom)
  const rotation = useGalleryStore((s) => s.rotation)
  const direction = useGalleryStore((s) => s.direction)
  const setFit = useGalleryStore((s) => s.setFit)
  const setDirection = useGalleryStore((s) => s.setDirection)
  const zoomIn = useGalleryStore((s) => s.zoomIn)
  const zoomOut = useGalleryStore((s) => s.zoomOut)
  const zoomReset = useGalleryStore((s) => s.zoomReset)
  const rotate = useGalleryStore((s) => s.rotate)

  // 暗色画布上显示更柔和的浮层
  return (
    <>
      {/* 左侧：上一本 / 下一本（小屏藏在 header 菜单里；桌面下显示） */}
      {(onPrevAlbum || onNextAlbum) && (
        <div
          className={`absolute left-2 sm:left-3 top-1/2 -translate-y-1/2 z-10 hidden md:flex flex-col gap-1 transition-opacity duration-300 ${
            visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          {onPrevAlbum && (
            <SideIconButton onClick={onPrevAlbum} title="上一本 (P)">
              <ArrowUpIcon size={16} />
            </SideIconButton>
          )}
          {onNextAlbum && (
            <SideIconButton onClick={onNextAlbum} title="下一本 (N)">
              <ArrowDownIcon size={16} />
            </SideIconButton>
          )}
        </div>
      )}

      {/* 右侧：阅读模式 + 适配 + 缩放 + 旋转
          窄屏隐藏：这列控件会盖住图片右缘并挡住"点击右侧翻下一张"的热区，
          小屏改用顶栏的「阅读设置」弹层（GalleryDisplayMenu）。 */}
      <div
        className={`absolute right-2 sm:right-3 top-1/2 -translate-y-1/2 z-10 hidden md:flex flex-col items-stretch gap-2 transition-opacity duration-300 ${
          visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <ControlGroup label="翻页">
          <SideIconButton
            onClick={onPrev}
            title="上一张 (←)"
            hideOnMobile
          >
            <ChevronLeftIcon size={16} />
          </SideIconButton>
          <SideIconButton
            onClick={onNext}
            title="下一张 (→)"
            hideOnMobile
          >
            <ChevronRightIcon size={16} />
          </SideIconButton>
        </ControlGroup>

        <ControlGroup label="适配">
          {FIT_OPTIONS.map((o) => (
            <SideIconButton
              key={o.value}
              onClick={() => setFit(o.value)}
              title={`${o.label} (F 循环)`}
              active={fit === o.value}
            >
              <o.icon size={16} />
            </SideIconButton>
          ))}
        </ControlGroup>

        <ControlGroup label="缩放">
          <SideIconButton onClick={zoomOut} title="缩小 (-)">
            <MinusIcon size={16} />
          </SideIconButton>
          <button
            onClick={zoomReset}
            title="重置 (0)"
            className="h-11 px-1.5 rounded text-[12.5px] tabular-nums text-white/85 hover:bg-white/10 hover:text-white transition-colors"
          >
            {Math.round(zoom * 100)}%
          </button>
          <SideIconButton onClick={zoomIn} title="放大 (+)">
            <PlusIcon size={16} />
          </SideIconButton>
        </ControlGroup>

        <ControlGroup label="旋转">
          <SideIconButton onClick={() => rotate(90)} title="旋转 90° (R)">
            <span className="inline-flex items-center gap-0.5 text-[12px]">
              <RotateIcon size={14} />
              <span className="tabular-nums">{rotation}°</span>
            </span>
          </SideIconButton>
        </ControlGroup>

        {mode === 'double' && (
          <ControlGroup label="方向">
            <SideIconButton
              onClick={() => setDirection(direction === 'ltr' ? 'rtl' : 'ltr')}
              title={`阅读方向：${direction === 'ltr' ? '左→右' : '右→左'} (L)`}
            >
              {direction === 'ltr' ? <ArrowRightLineIcon size={16} /> : <ArrowLeftLineIcon size={16} />}
            </SideIconButton>
          </ControlGroup>
        )}
      </div>
    </>
  )
}

// 控件组：上方标签 + 下方按钮列。专为深色画布设计：深色玻璃面板。
const DARK_GLASS =
  'bg-neutral-900/70 backdrop-blur-md ring-1 ring-white/10 shadow-xl'

function ControlGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center">
      <div className={`flex flex-col items-stretch rounded-lg p-1 gap-0.5 ${DARK_GLASS}`}>{children}</div>
      <span className="mt-1 text-[12px] text-white/50">{label}</span>
    </div>
  )
}

function SideIconButton({
  children,
  onClick,
  disabled,
  title,
  active,
  hideOnMobile,
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  title?: string
  active?: boolean
  hideOnMobile?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`inline-flex items-center justify-center h-11 min-w-11 px-2 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        hideOnMobile ? 'hidden sm:inline-flex' : ''
      } ${
        active
          ? 'bg-white/15 text-white'
          : 'text-white/80 hover:text-white hover:bg-white/10'
      }`}
    >
      {children}
    </button>
  )
}
