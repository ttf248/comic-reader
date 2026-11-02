import { useState } from "react";
import { thumbUrl } from "../../api/thumbs";
import VideoCoverImage from "../common/VideoCoverImage";
import { FolderIcon } from "../common/Icon";
import type { CardData } from "./AlbumCard";

interface Props {
  data: Pick<
    CardData,
    "coverKind" | "coverPath" | "covers" | "title" | "variant"
  >;
  loading?: "lazy" | "eager";
  /**
   * 紧凑模式：列表视图的缩略图很小，放不下「正在加载…」这类提示文字，
   * 只保留转圈指示。
   */
  compact?: boolean;
}

/**
 * 卡片封面的唯一渲染入口。
 *
 * 相册强调一个明确的主封面；集合与智能视图展示最多四张去重后的代表图。
 * `covers` 为空时继续使用 `coverPath`，让旧扫描结果也能得到完整封面。
 */
export default function CardCover({ data, loading = "lazy", compact }: Props) {
  const paths = getCoverPaths(data);

  if (paths.length === 0) return <CoverPlaceholder />;

  if (data.variant === "album") {
    if (data.coverKind === "video") {
      return (
        // 视频画幅固定 16:9，容器可能是 4:5 —— 深色画布让上下留边
        // 读成"宽银幕"而不是"缺图"。
        <div className="w-full h-full bg-bg-media">
          <VideoCoverImage
            key={paths[0]}
            videoPath={paths[0]}
            loading={loading}
            alt={data.title}
            showRetryAction={false}
            showExtractingHint={!compact}
          />
        </div>
      );
    }

    return (
      <CoverImage
        key={paths[0]}
        path={paths[0]}
        alt={data.title}
        loading={loading}
        /* 相册封面统一偏上取景：漫画封面的标题与人物头部在���方，
           居中裁切会把它们切掉；横向照片本身是横向裁切，不受影响。 */
        position="50% 25%"
      />
    );
  }

  return (
    <div
      className={mosaicClass(paths.length)}
      data-cover-layout={
        paths.length === 1 ? "single" : `mosaic-${paths.length}`
      }
      data-testid="card-cover-mosaic"
    >
      {paths.map((path, index) => (
        <div
          key={path}
          className={`${mosaicCellClass(paths.length, index)} min-w-0 min-h-0 overflow-hidden bg-bg-subtle`}
        >
          <CoverImage path={path} alt="" loading={loading} />
        </div>
      ))}
    </div>
  );
}

function getCoverPaths(
  data: Pick<CardData, "coverPath" | "covers" | "variant">,
): string[] {
  if (data.variant === "album") return data.coverPath ? [data.coverPath] : [];

  const unique = Array.from(
    new Set((data.covers ?? []).map((path) => path.trim()).filter(Boolean)),
  ).slice(0, 4);

  if (unique.length > 0) return unique;
  return data.coverPath ? [data.coverPath] : [];
}

function mosaicClass(count: number): string {
  if (count === 1) return "w-full h-full";
  return "grid grid-cols-2 grid-rows-2 w-full h-full gap-px bg-border";
}

function mosaicCellClass(count: number, index: number): string {
  if (count === 2) return "row-span-2";
  if (count === 3 && index === 0) return "row-span-2";
  return "";
}

function CoverImage({
  path,
  alt,
  loading,
  position = "50% 50%",
}: {
  path: string;
  alt: string;
  loading: "lazy" | "eager";
  position?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) return <CoverPlaceholder />;

  return (
    <img
      src={thumbUrl(path)}
      alt={alt}
      loading={loading}
      decoding="async"
      onError={() => setFailed(true)}
      style={{ objectPosition: position }}
      className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
    />
  );
}

function CoverPlaceholder() {
  return (
    <div className="w-full h-full flex items-center justify-center bg-bg-subtle text-fg-subtle">
      <FolderIcon size={28} />
    </div>
  );
}
