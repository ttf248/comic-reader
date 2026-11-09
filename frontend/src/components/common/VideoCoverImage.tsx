import { useVideoCover } from "../../hooks/useVideoCover";
import { pickRenditionWidth } from "../../utils/rendition";
import { FolderIcon, PlayFilledIcon } from "./Icon";

interface Props {
  /** 视频文件资源 ID（也是 thumbUrl 要请求的标识） */
  videoPath: string;
  /** 视频文件的内容版本号；带上之后封面可被浏览器长期缓存。 */
  version?: string;
  /**
   * 槽位的显示宽度（CSS 像素）。
   *
   * 封面按这个宽度取档：小格子不必下载大封面，照片墙的瓦片也不会
   * 拿到不够宽的一档而发虚。
   */
  displayWidth?: number;
  /** 是否要 lazy（与 <img loading> 语义一致） */
  loading?: "lazy" | "eager";
  alt?: string;
  /** 加载失败时点按回调（用于 retry 按钮），不传则不显示 */
  onRetry?: () => void;
  /** 是否显示 "正在生成预览" 文字（默认 true） */
  showExtractingHint?: boolean;
  /** 是否显示可点击的重试操作；卡片链接内应关闭，避免嵌套交互元素。 */
  showRetryAction?: boolean;
  /**
   * 画面怎么放进画幅。
   *
   * "contain" 保留完整画面（上下留边读成宽银幕）；"cover" 铺满画幅，
   * 裁掉两侧。竖版书封里前者会留下一大片黑边，像个空信箱。
   */
  fit?: "contain" | "cover";
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
  version,
  displayWidth,
  loading = "lazy",
  alt = "",
  onRetry,
  showExtractingHint = true,
  showRetryAction = true,
  fit = "contain",
}: Props) {
  const { status, url, retry, enabled } = useVideoCover(videoPath, {
    version,
    width: pickRenditionWidth(displayWidth ?? 320),
  });

  if (!enabled) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-bg-media text-white/45">
        <FolderIcon size={28} />
      </div>
    );
  }

  // 抽帧中/检查中 → 占位。
  // 不用转圈：转圈既不告诉用户还要等多久，又在几十张卡片的网格里制造
  // 一片闪烁的噪点。静态图标 + 文案就够了 —— 封面位置本来就是固定的，
  // 预览出现时直接铺上去，不会跳动。
  //
  // 底色用深色画布（--bg-media 令牌，工具类名是 bg-bg-media）：视频封面是
  // 16:9，塞进 4:5 的卡片必然
  // 上下留边。留边如果落在浅灰底上会被读成"图片缺了一块"，落在深色画布上
  // 才是宽银幕的常规观感。
  if (status === "loading" || status === "missing" || status === "extracting") {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-bg-media gap-2.5">
        <span className="w-11 h-11 rounded-full border border-white/25 bg-white/10 flex items-center justify-center">
          <PlayFilledIcon size={18} className="text-white/85" />
        </span>
        {showExtractingHint && (
          <span className="text-meta text-white/60 tabular-nums">
            {status === "extracting" ? "正在生成封面…" : "正在加载…"}
          </span>
        )}
      </div>
    );
  }

  // 抽帧失败 → 占位 + 可选重试
  if (status === "error") {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-bg-media gap-2">
        <span className="w-11 h-11 rounded-full border border-white/20 bg-white/8 flex items-center justify-center">
          <FolderIcon size={20} className="text-white/70" />
        </span>
        <span className="text-meta text-white/60">封面生成失败</span>
        {showRetryAction ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (onRetry) onRetry();
              else retry();
            }}
            className="relative z-10 text-meta text-white/85 hover:underline"
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
      className={`w-full h-full scale-fade ${
        fit === "cover" ? "object-cover" : "object-contain"
      }`}
    />
  );
}
