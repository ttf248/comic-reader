import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { libraryApi, type LibraryNodeSummary } from "../api/library";

/**
 * 随手看看：随机给几本照片相册。
 *
 * 「随手看看」专区的数据源：用「种子」做查询键，换一次种子就是换一批，
 * React Query 的缓存也跟着走。enabled 为假时不发请求 —— 漫画工作台
 * 没有这个专区。
 *
 * 一次给三本：专区原本只摆一本，下方空出一大片；三本候选把那块填上，
 * 也让人一次撞见几种没预期的照片。服务端保证抽出的相册互不相同。
 */
export function useSerendipityAlbum(enabled = true): {
  albums: LibraryNodeSummary[];
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
      const response = await libraryApi.randomAlbums("photo", "any", 3);
      return response.albums;
    },
    enabled,
    staleTime: 60_000,
  });
  return { albums: query.data ?? [], isLoading: query.isLoading, reshuffle };
}
