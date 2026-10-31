import { useVideoCover } from "../../hooks/useVideoCover";
import { FolderIcon } from "./Icon";

interface Props {
  /** 视频文件资源 ID（也是 thumbUrl 要请求的标识） */
  videoPath: string;
  /** 是否要 lazy（与 <img loading> 语义一致） */
  loading?: "lazy" | "eager";
  alt?: string;
  /** 加载失败时点按回调（用于 retry 按钮），不传则不显示 */
  onRetry?: () => void;
  /** 是否显示 "正在生成预览" 文字（默认 true） */
  showExtractingHint?: boolean;
  /** 是否显示可点击的重试操作；卡片链接内应关闭，避免嵌套交互元素。 */
  showRetryAction?: boolean;
}

/**
 * 视频封面 <img>：自动处理"未抽帧 → 浏览器抽帧 → 上传 → 重新加载"流程。
 *
 * 父组件仅需传 videoPath；其余状态由内部 useVideoCover 管理。
 * 视觉上替代 AlbumCard 中"视频 cover"分支的 <img>，与图片 <img>
 * 保持同样的 100% 覆盖与 group-hover 缩放。
 */
export default function VideoCoverImage({
  videoPath,
  loading = "lazy",
  alt = "",
  onRetry,
  showExtractingHint = true,
  showRetryAction = true,
}: Props) {
  const { status, url, retry, enabled } = useVideoCover(videoPath);

  if (!enabled) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-bg-subtle text-fg-subtle">
        <FolderIcon size={28} />
      </div>
    );
  }

  // 抽帧中/检查中 → 占位
  if (status === "loading" || status === "missing" || status === "extracting") {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-bg-subtle text-fg-subtle gap-2">
        <div className="w-5 h-5 border-2 border-fg-subtle/40 border-t-accent rounded-full animate-spin" />
        {showExtractingHint && (
          <span className="text-[10px] tabular-nums">
            {status === "extracting" ? "正在生成预览…" : "正在加载…"}
          </span>
        )}
      </div>
    );
  }

  // 抽帧失败 → 占位 + 可选重试
  if (status === "error") {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-bg-subtle text-fg-subtle gap-1.5">
        <FolderIcon size={22} />
        <span className="text-[10px]">封面生成失败</span>
        {showRetryAction ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (onRetry) onRetry();
              else retry();
            }}
            className="relative z-10 text-[10px] text-accent hover:underline"
          >
            重试
          </button>
        ) : null}
      </div>
    );
  }

  // ready → <img>
  return (
    <img
      src={url}
      alt={alt}
      loading={loading}
      decoding="async"
      className="w-full h-full object-cover scale-fade"
    />
  );
}
