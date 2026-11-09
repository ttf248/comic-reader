import { useState } from "react";
import { thumbSrcSet, thumbUrl } from "../../api/thumbs";
import { pickRenditionWidth, renditionCandidates } from "../../utils/rendition";
import { ImageIcon } from "./Icon";

interface Props {
  /** 文件资源 ID（f_xxx）。 */
  fileId: string;
  alt: string;
  /** 图片的尺寸类名；占位图沿用同样的类名，保证切换时不跳动。 */
  className?: string;
  loading?: "lazy" | "eager";
  /** 占位图里的图标尺寸。 */
  iconSize?: number;
  /** 媒体内容版本号；带上之后服务端可回 immutable，浏览器长期缓存。 */
  version?: string;
  /**
   * 槽位的显示宽度（CSS 像素）。
   *
   * 有了它才能算出该取哪一档：显示 48px 的小图不必下载 640 宽的渲染图，
   * 显示 550px 的照片墙瓦片也不会拿到不够宽的一档而发虚。
   */
  displayWidth?: number;
}

/**
 * 缩略图图片：加载失败时显示占位图，而不是浏览器的破图图标。
 *
 * 失败原因是真实存在的：HEIC/HEIF（服务端无 ffmpeg 时）、损坏的文件、
 * 扫描后被删掉的源文件等。这时浏览器默认会画一个破图图标 + alt 文本，
 * 在相册网格里非常刺眼，占位图更贴近"这里有一张打不开的图"的语义。
 */
export default function ThumbImage({
  fileId,
  alt,
  className = "",
  loading = "lazy",
  iconSize = 22,
  version,
  displayWidth,
}: Props) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={`flex items-center justify-center bg-bg-subtle text-fg-subtle ${className}`}
        role="img"
        aria-label={alt}
        title="缩略图不可用"
      >
        <ImageIcon size={iconSize} />
      </div>
    );
  }

  // 宽度未知时退回缺省档：宁可多拿一点，也不要拿不够宽的。
  const width = pickRenditionWidth(displayWidth ?? 320);

  return (
    <img
      src={thumbUrl(fileId, version, width)}
      srcSet={
        displayWidth
          ? thumbSrcSet(fileId, version, renditionCandidates())
          : undefined
      }
      sizes={displayWidth ? `${displayWidth}px` : undefined}
      alt={alt}
      loading={loading}
      decoding="async"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
