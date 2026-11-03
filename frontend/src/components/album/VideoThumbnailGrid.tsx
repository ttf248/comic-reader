import { useMemo } from "react";
import VirtualMediaGrid from "./VirtualMediaGrid";
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
    <VirtualMediaGrid
      data={slots}
      computeItemKey={(index, item) => item ?? `video-placeholder-${index}`}
      rangeChanged={rangeChanged}
      itemContent={(index, video) => {
        if (!video) return <VideoPlaceholder />;
        const info = infos[video];
        const name = info?.name ?? `视频 ${index + 1}`;
        const duration = info?.duration;
        return (
          // 视频用 16:9 画幅，不再塞进 3:4 —— 竖着框住宽银幕会留下
          // 上下两条空白，看起来像"图缺了一块"。
          <div className="group relative w-full aspect-video bg-bg-media rounded overflow-hidden">
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
              <div className="absolute bottom-1.5 right-1.5 text-[12.5px] bg-bg-elevated/90 backdrop-blur px-1.5 py-0.5 rounded text-fg tabular-nums">
                {index + 1}
              </div>
              {/* 文件名压在缩略图下沿：底色必须是不透明段而不是渐变起点。
                  旧版 from-black/60（渐变从 60% 黑开始往上淡）实测只有
                  2.59:1 —— 白字压在亮视频画面上完全读不出来。
                  现在 85% 黑 + 80% 处才开始淡出，实测 14.3:1。
                  注意：Tailwind 只认 5% 的整数倍色标（from-80% 有效，
                  from-78% 会被静默丢弃、整条规则不生成）。 */}
              <div className="absolute bottom-0 inset-x-0 px-1.5 pt-1.5 pb-1 bg-gradient-to-t from-black/85 from-80% to-transparent">
                <div className="text-[12.5px] text-white/90 truncate flex items-center gap-1.5">
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
      className="w-full aspect-video rounded bg-bg-media animate-pulse"
      aria-hidden="true"
    />
  );
}
