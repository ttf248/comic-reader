import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CloseIcon } from "./Icon";
import CopyButton from "./CopyButton";
import { useImageInfo } from "../../hooks/useImageInfo";
import { formatSize } from "../../utils/format";
import { formatDateTime } from "../../utils/date";
import { apiErrorMessage } from "../../utils/apiError";
import { useQuery } from "@tanstack/react-query";
import { aiJobsApi } from "../../api/aiJobs";
import { previewUrl } from "../../api/images";
import { albumRoute } from "../../utils/path";

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
  const [selectedFace, setSelectedFace] = useState<number | null>(null);
  const previousAbsPath = useRef(absPath);
  const { info, err, loading } = useImageInfo(absPath);
  const metadataQuery = useQuery({
    queryKey: ["image-exif", absPath],
    queryFn: () => aiJobsApi.metadata(absPath ?? ""),
    enabled: Boolean(absPath),
    refetchInterval: (query) =>
      query.state.data?.status === "pending" ? 5_000 : false,
  });
  const analysisQuery = useQuery({
    queryKey: ["image-ai-analysis", absPath],
    queryFn: () => aiJobsApi.analysis(absPath ?? ""),
    enabled: Boolean(absPath),
    refetchInterval: (query) =>
      query.state.data?.ocr.status === "pending" ||
      query.state.data?.face.status === "pending"
        ? 5_000
        : false,
  });
  const faceSearchQuery = useQuery({
    queryKey: ["face-similarity", absPath, selectedFace],
    queryFn: () => aiJobsApi.faceSearch(absPath ?? "", selectedFace ?? 0),
    enabled: Boolean(absPath) && selectedFace !== null,
  });

  useEffect(() => {
    if (previousAbsPath.current === absPath) return;
    previousAbsPath.current = absPath;
    setSelectedFace(null);
  }, [absPath]);

  if (!absPath) return null;

  return (
    /* 宽屏时面板是画面右侧独立的一栏，从顶栏下方一直到底：
       它是这一屏的规格栏，不是浮在画面上的小卡片。 */
    <aside
      data-testid="image-info-panel"
      className="
        absolute inset-x-0 bottom-0 top-[76px] z-30 flex flex-col
        border-t border-overlay-border bg-overlay-panel backdrop-blur-md
        md:static md:inset-auto md:z-auto md:w-[21rem] md:shrink-0
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
            <div className="my-2 border-t border-white/10 pt-2 text-meta font-medium text-white/70">
              EXIF 与 GPS
            </div>
            {metadataQuery.data?.status === "pending" ? (
              <Row label="分析状态" value="等待元数据分析任务" />
            ) : metadataQuery.data?.status === "no_exif" ? (
              <Row label="分析状态" value="没有可用 EXIF 信息" />
            ) : metadataQuery.data?.status === "unsupported" ? (
              <Row label="分析状态" value="该图片格式暂无 EXIF 支持" />
            ) : metadataQuery.data?.status === "failed" ? (
              <Row label="分析状态" value="解析失败，可在任务中心重试" />
            ) : metadataQuery.data?.metadata ? (
              <>
                {metadataQuery.data.metadata.dateTimeOriginal && (
                  <Row
                    label="拍摄时间"
                    value={metadataQuery.data.metadata.dateTimeOriginal}
                  />
                )}
                {(metadataQuery.data.metadata.cameraMake ||
                  metadataQuery.data.metadata.cameraModel) && (
                  <Row
                    label="相机"
                    value={[
                      metadataQuery.data.metadata.cameraMake,
                      metadataQuery.data.metadata.cameraModel,
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  />
                )}
                {metadataQuery.data.metadata.orientation !== undefined && (
                  <Row
                    label="方向"
                    value={String(metadataQuery.data.metadata.orientation)}
                  />
                )}
                {metadataQuery.data.metadata.gps && (
                  <>
                    <Row
                      label="GPS 坐标"
                      value={`${metadataQuery.data.metadata.gps.latitude.toFixed(6)}, ${metadataQuery.data.metadata.gps.longitude.toFixed(6)}`}
                    />
                    {metadataQuery.data.metadata.gps.altitudeMeters !==
                      undefined && (
                      <Row
                        label="海拔"
                        value={`${metadataQuery.data.metadata.gps.altitudeMeters.toFixed(1)} 米`}
                      />
                    )}
                  </>
                )}
              </>
            ) : metadataQuery.isError ? (
              <Row label="分析状态" value="元数据暂不可用" />
            ) : (
              <Row label="分析状态" value="尚未分析" />
            )}
            <AnalysisHeading>文字识别</AnalysisHeading>
            <ImageAnalysisStatus
              status={analysisQuery.data?.ocr.status}
              error={analysisQuery.data?.ocr.error?.message}
              loading={analysisQuery.isLoading}
              pendingLabel="尚未识别；可在任务中心运行文字识别。"
              emptyLabel="未检测到可辨认文字"
            />
            {analysisQuery.data?.ocr.status === "recognized" ? (
              <div className="py-2 text-white/90">
                <p className="whitespace-pre-wrap break-words text-body leading-relaxed">
                  {analysisQuery.data.ocr.text}
                </p>
                <p className="mt-1 text-meta text-white/50">
                  检出 {analysisQuery.data.ocr.lines?.length ?? 0} 行文字
                </p>
              </div>
            ) : null}
            <AnalysisHeading>人脸识别</AnalysisHeading>
            <ImageAnalysisStatus
              status={analysisQuery.data?.face.status}
              error={analysisQuery.data?.face.error?.message}
              loading={analysisQuery.isLoading}
              pendingLabel="尚未分析；可在任务中心运行人脸识别。"
              emptyLabel="未检测到人脸"
            />
            {analysisQuery.data?.face.status === "faces_found" ? (
              <div className="py-2">
                <p className="text-meta text-white/70">
                  检测到 {analysisQuery.data.face.faces?.length ?? 0} 张人脸
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {analysisQuery.data.face.faces?.map((face, index) => (
                    <button
                      key={`${index}-${face.box.join(",")}`}
                      type="button"
                      className="rounded border border-white/15 px-2.5 py-1.5 text-meta text-white/80 transition-colors hover:bg-white/10"
                      onClick={() => setSelectedFace(index)}
                    >
                      人脸 {index + 1} · 找相似
                    </button>
                  ))}
                </div>
                {selectedFace !== null ? (
                  <div className="mt-3 rounded-md border border-white/10 bg-black/15 p-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-meta font-medium text-white/80">
                        相似照片
                      </p>
                      <button
                        type="button"
                        className="text-meta text-white/50 hover:text-white"
                        onClick={() => setSelectedFace(null)}
                      >
                        收起
                      </button>
                    </div>
                    {faceSearchQuery.isLoading ? (
                      <p className="mt-2 text-meta text-white/55">正在检索…</p>
                    ) : faceSearchQuery.isError ? (
                      <p className="mt-2 text-meta text-overlay-danger">
                        {apiErrorMessage(
                          faceSearchQuery.error,
                          "相似人脸检索失败",
                        )}
                      </p>
                    ) : faceSearchQuery.data?.results.length ? (
                      <ul className="mt-2 space-y-2">
                        {faceSearchQuery.data.results.map((hit) => (
                          <li key={hit.item.id}>
                            <Link
                              to={albumRoute("photo", hit.item.albumId)}
                              className="flex items-center gap-2 rounded p-1 transition-colors hover:bg-white/10"
                            >
                              <img
                                src={previewUrl(
                                  hit.item.id,
                                  160,
                                  hit.item.version,
                                )}
                                alt=""
                                className="h-12 w-12 shrink-0 rounded object-cover"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-meta text-white/85">
                                  {hit.item.name}
                                </span>
                                <span className="block truncate text-meta text-white/50">
                                  {hit.item.albumName}
                                </span>
                              </span>
                              <span className="font-mono text-meta tabular-nums text-white/55">
                                {Math.round(hit.similarity * 100)}%
                              </span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-meta text-white/55">
                        没有找到相似人脸
                      </p>
                    )}
                    <p className="mt-2 text-meta leading-relaxed text-white/40">
                      相似度用于找回同一人物的照片，不代表身份确认。
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}
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

function AnalysisHeading({ children }: { children: string }) {
  return (
    <div className="my-2 border-t border-white/10 pt-2 text-meta font-medium text-white/70">
      {children}
    </div>
  );
}

function ImageAnalysisStatus({
  status,
  error,
  loading,
  pendingLabel,
  emptyLabel,
}: {
  status?: string;
  error?: string;
  loading: boolean;
  pendingLabel: string;
  emptyLabel: string;
}) {
  if (loading)
    return <p className="py-1 text-meta text-white/45">正在读取分析结果…</p>;
  if (status === "pending")
    return <p className="py-1 text-meta text-white/45">{pendingLabel}</p>;
  if (status === "no_text" || status === "no_faces") {
    return <p className="py-1 text-meta text-white/45">{emptyLabel}</p>;
  }
  if (status === "failed") {
    return (
      <p className="py-1 text-meta text-overlay-danger">
        {error ?? "分析失败，可在任务中心重试。"}
      </p>
    );
  }
  if (!status)
    return <p className="py-1 text-meta text-white/45">分析状态暂不可用</p>;
  return null;
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
