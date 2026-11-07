import { CloseIcon } from "./Icon";
import CopyButton from "./CopyButton";
import { useImageInfo } from "../../hooks/useImageInfo";
import { formatSize } from "../../utils/format";
import { formatDateTime } from "../../utils/date";
import { apiErrorMessage } from "../../utils/apiError";

interface Props {
  absPath: string | null;
  onClose: () => void;
}

// 画廊右侧图片信息面板。
//
// 布局：阅读器根节点是横向 flex，面板在宽屏（md+）作为独立的一栏与画布并排，
// 不叠在顶栏上；窄屏没有并排空间，改为浮动顶栏下方的整宽浮层，
// 至少不遮住返回按钮和相册名。
//
// 配色：阅读器画布恒为深色，顶栏和右侧控件都用白色系。
// 面板同样按阅读器的深色约定渲染，不用应用主题色——否则浅色主题下会
// 出现"黑底阅读器里嵌一块白板"，且白底上的深色小字与深色画布割裂。
export default function ImageInfoPanel({ absPath, onClose }: Props) {
  const { info, err, loading } = useImageInfo(absPath);

  if (!absPath) return null;

  return (
    /* 面板按内容高度收住（self-start）：一整屏高的面板里只有八行规格，
     下面大半是空的，读起来像没加载完。 */
    <aside
      data-testid="image-info-panel"
      className="
        absolute inset-x-0 bottom-0 top-[76px] z-30 flex flex-col
        border-t border-overlay-border bg-overlay-panel backdrop-blur-md
        md:static md:inset-auto md:z-auto md:w-[21rem] md:shrink-0 md:self-start
        md:border-l md:border-t-0
      "
    >
      <div className="flex items-center justify-between px-4 h-11 border-b border-white/10 shrink-0">
        <h2 className="font-display text-body font-medium text-white/85">
          图片信息
        </h2>
        <button
          onClick={onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors"
          title="关闭 (I)"
          aria-label="关闭图片信息"
        >
          <CloseIcon size={13} />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4 text-body scroll-thin">
        {loading && <div className="text-white/60 text-meta">加载中…</div>}
        {err !== null && (
          <div className="text-overlay-danger text-meta">
            错误: {apiErrorMessage(err, "无法读取图片信息")}
          </div>
        )}
        {info && (
          /* 两列的规格表：标签在左一窄列，值在右。原先标签在上、值在下，
             一屏读不到几行，剩下半屏是空的；规格表本来就该能横向扫读。 */
          <dl className="divide-y divide-white/10">
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
          </dl>
        )}
      </div>
    </aside>
  );
}

interface RowProps {
  label: string;
  value: string;
  mono?: boolean;
  copyable?: boolean;
  copyValue?: string;
}

function Row({ label, value, mono, copyable, copyValue }: RowProps) {
  return (
    <div className="flex items-start gap-3 py-2">
      <dt className="w-14 shrink-0 text-meta text-white/50 leading-5">
        {label}
      </dt>
      <dd className="flex-1 min-w-0 flex items-start gap-1.5">
        <span
          className={`break-all leading-5 ${
            mono ? "font-mono text-meta text-white/70" : "text-white/90"
          }`}
        >
          {value}
        </span>
        {copyable && copyValue && (
          <span className="shrink-0">
            <CopyButton value={copyValue} onDark />
          </span>
        )}
      </dd>
    </div>
  );
}
