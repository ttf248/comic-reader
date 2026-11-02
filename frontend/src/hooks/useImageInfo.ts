import { useCallback, useEffect, useState } from "react";
import { imageInfoApi, type ImageInfo } from "../api/imageInfo";

// 图片属性和画廊信息面板共享文件资源 ID 查询，切换或重试时清除旧字段。
export function useImageInfo(fileId: string | null | undefined) {
  const [info, setInfo] = useState<ImageInfo | null>(null);
  // 保留原始异常对象：错误码要交给 apiErrorMessage 翻成中文，
  // 只留 message 会把后端的英文原文直接显示给用户。
  const [err, setErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const refetch = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    if (!fileId) {
      setInfo(null);
      setErr(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setInfo(null);
    setErr(null);
    let cancelled = false;
    imageInfoApi
      .get(fileId)
      .then((d) => {
        if (!cancelled) setInfo(d);
      })
      .catch((error: unknown) => {
        if (!cancelled) setErr(error ?? new Error("加载失败"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, attempt]);

  return { info, err, loading, refetch };
}
