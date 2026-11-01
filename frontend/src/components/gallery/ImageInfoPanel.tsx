import { CloseIcon } from '../common/Icon'
import CopyButton from '../common/CopyButton'
import { useImageInfo } from '../../hooks/useImageInfo'
import { formatSize } from '../../utils/format'
import { formatDateTime } from '../../utils/date'

interface Props {
  absPath: string | null
  onClose: () => void
}

// 画廊右侧图片信息面板。
export default function ImageInfoPanel({ absPath, onClose }: Props) {
  const { info, err, loading } = useImageInfo(absPath)

  if (!absPath) return null

  return (
    <aside className="w-72 border-l border-border-faint glass flex flex-col">
      <div className="flex items-center justify-between px-4 h-12 border-b border-border-faint">
        <h2 className="font-display text-[13px] font-medium">图片信息</h2>
        <button
          onClick={onClose}
          className="text-fg-muted hover:text-fg p-1 rounded hover:bg-bg-subtle transition-colors"
          title="关闭 (I)"
        >
          <CloseIcon size={13} />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4 text-sm space-y-3 scroll-thin">
        {loading && <div className="text-fg-muted text-xs">加载中…</div>}
        {err && <div className="text-danger text-xs">错误: {err}</div>}
        {info && (
          <>
            <Row
              label="文件名"
              value={info.name}
              copyable
              copyValue={info.name}
            />
            <Row label="尺寸" value={`${info.width} × ${info.height}`} />
            <Row label="格式" value={info.format.toUpperCase()} />
            <Row label="大小" value={formatSize(info.size)} />
            <Row label="修改时间" value={formatDateTime(info.mtime)} />
            <Row
              label="目录"
              value={info.dir}
              mono
              copyable
              copyValue={info.dir}
            />
            <Row
              label="文件 ID"
              value={info.path}
              mono
              copyable
              copyValue={info.path}
            />
            <Row
              label="校验和"
              value={info.checksum}
              mono
              copyable
              copyValue={info.checksum}
            />
          </>
        )}
      </div>
    </aside>
  )
}

interface RowProps {
  label: string
  value: string
  mono?: boolean
  copyable?: boolean
  copyValue?: string
}

function Row({ label, value, mono, copyable, copyValue }: RowProps) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.14em] text-fg-subtle mb-1 flex items-center gap-1.5">
        <span>{label}</span>
        {copyable && copyValue && <CopyButton value={copyValue} />}
      </div>
      <div className={`break-all ${mono ? 'font-mono text-[11px] text-fg-muted' : ''}`}>
        {value}
      </div>
    </div>
  )
}
