import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { libraryApi, type LibraryNodeSummary } from "../api/library";

/**
 * 随机取一本照片相册。
 *
 * 「随手看看」专区的数据源：用「种子」做查询键，换一次种子就是换一本，
 * React Query 的缓存也跟着走。enabled 为假时不发请求 —— 漫画工作台
 * 没有这个专区。
 */
export function useSerendipityAlbum(enabled = true): {
  album: LibraryNodeSummary | null;
  isLoading: boolean;
  reshuffle: () => void;
} {
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9));
  const reshuffle = useCallback(
    () => setSeed(Math.floor(Math.random() * 1e9)),
    [],
  );
  const query = useQuery({
    queryKey: ["library", "serendipity", "photo", seed],
    queryFn: async () => {
      const response = await libraryApi.randomAlbum("photo");
      return response.album;
    },
    enabled,
    staleTime: 60_000,
  });
  return { album: query.data ?? null, isLoading: query.isLoading, reshuffle };
}
