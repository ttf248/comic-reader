import { useMemo } from "react";
import { VirtuosoGrid } from "react-virtuoso";
import type { VideoInfo } from "../../api/videos";
import VideoCoverImage from "../common/VideoCoverImage";
import { PlayFilledIcon } from "../common/Icon";
import { formatDuration } from "../../utils/format";
import { useMediaGridPagination } from "../../hooks/useMediaGridPagination";

interface Props {
  videos: string[];
  total: number;
  infos: Record<string, VideoInfo>;
  hasNextPage: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onOpen: (index: number) => void;
}

/** 视频相册缩略图网格；与图片网格保持相同的分页和虚拟化策略。 */
export default function VideoThumbnailGrid({
  videos,
  total,
  infos,
  hasNextPage,
  isLoadingMore,
  onLoadMore,
  onOpen,
}: Props) {
  const rangeChanged = useMediaGridPagination({
    loadedCount: videos.length,
    hasNextPage,
    isLoadingMore,
    onLoadMore,
  });
  const slots = useMemo(
    () =>
      Array.from(
        { length: Math.max(total, videos.length) },
        (_, index) => videos[index] ?? null,
      ),
    [total, videos],
  );

  return (
    <VirtuosoGrid
      style={{ height: "100%" }}
      data={slots}
      overscan={720}
      listClassName="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2 px-6 lg:px-10 pb-10 max-w-[1400px] mx-auto"
      itemClassName="min-w-0"
      computeItemKey={(index, item) => item ?? `video-placeholder-${index}`}
      rangeChanged={rangeChanged}
      itemContent={(index, video) => {
        if (!video) return <VideoPlaceholder />;
        const info = infos[video];
        const name = info?.name ?? `视频 ${index + 1}`;
        const duration = info?.duration;
        return (
          <div className="group relative w-full aspect-[3/4] bg-bg-subtle rounded overflow-hidden">
            <VideoCoverImage videoPath={video} alt={name} loading="lazy" />
            <button
              type="button"
              onClick={() => onOpen(index)}
              className="absolute inset-0 rounded transition-all hover:ring-1 hover:ring-inset hover:ring-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
              title={name}
              aria-label={`播放${name}`}
            >
              <div className="absolute top-1.5 right-1.5 bg-bg-elevated/90 backdrop-blur rounded-md p-1 shadow-sm group-hover:scale-110 transition-transform">
                <PlayFilledIcon size={10} className="text-accent" />
              </div>
              <div className="absolute bottom-1.5 right-1.5 text-[10px] bg-bg-elevated/85 backdrop-blur px-1.5 py-0.5 rounded text-fg-muted tabular-nums">
                {index + 1}
              </div>
              <div className="absolute bottom-0 inset-x-0 px-1.5 py-1 bg-gradient-to-t from-black/60 to-transparent">
                <div className="text-[10px] text-white/90 truncate flex items-center gap-1.5">
                  <span className="truncate">{name}</span>
                  {duration && duration > 0 && (
                    <span className="shrink-0 text-white/70 tabular-nums">
                      {formatDuration(duration)}
                    </span>
                  )}
                </div>
              </div>
            </button>
          </div>
        );
      }}
    />
  );
}

function VideoPlaceholder() {
  return (
    <div
      className="w-full aspect-[3/4] rounded bg-bg-subtle animate-pulse"
      aria-hidden="true"
    />
  );
}
