import { useState } from "react";
import RenditionImage from "../common/RenditionImage";
import { FolderIcon } from "../common/Icon";
import type { CardData } from "../album/AlbumGrid";

/**
 * 封面图。
 *
 * 两个工作台的首页 hero 都要显示封面，不各写一份：
 * 图片按原比例裁切（object-cover），视频同样裁切 —— 保留完整画面会在
 * 方形的裱框里上下留出两条黑边，读起来像一只空信箱，而不是一张照片。
 * 大图用预览尺寸而不是缩略图。
 */
export default function Cover({
  card,
  large = false,
}: {
  card: CardData;
  large?: boolean;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const src = card.coverPath;
  return src && src !== failedSource ? (
    <RenditionImage
      fileId={src}
      version={card.coverVersion}
      alt=""
      displayWidth={large ? 160 : 48}
      loading={large ? "eager" : "lazy"}
      onError={() => setFailedSource(src)}
      className="w-full h-full object-cover object-[50%_30%]"
    />
  ) : (
    <span className="w-full h-full flex items-center justify-center bg-bg-subtle text-fg-muted">
      <FolderIcon size={large ? 28 : 16} />
    </span>
  );
}
