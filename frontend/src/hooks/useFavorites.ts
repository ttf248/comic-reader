import { useCallback } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { favoritesApi } from "../api/prefs";

const EMPTY_FAVORITES: string[] = [];
const favoritesQueryOptions = {
  queryKey: ["favorites"],
  queryFn: () => favoritesApi.list(),
  staleTime: 30_000,
};

type FavoritesResponse = Awaited<ReturnType<typeof favoritesApi.list>>;

// 把服务端返回的收藏列表写回缓存，并顺手触发一次后台刷新。
function applyFavorites(qc: QueryClient, saved: FavoritesResponse) {
  qc.setQueryData(favoritesQueryOptions.queryKey, saved);
  void qc.invalidateQueries({ queryKey: favoritesQueryOptions.queryKey });
}

// 收藏集合的全局 hook：list + toggle
export function useFavorites() {
  const qc = useQueryClient();

  const query = useQuery(favoritesQueryOptions);

  const updateFavorites = (saved: FavoritesResponse) => {
    applyFavorites(qc, saved);
  };

  const add = useMutation({
    mutationFn: (resourceId: string) => favoritesApi.add(resourceId),
    onSuccess: updateFavorites,
  });

  const remove = useMutation({
    mutationFn: (resourceId: string) => favoritesApi.remove(resourceId),
    onSuccess: updateFavorites,
  });

  const list = query.data?.favorites ?? EMPTY_FAVORITES;

  async function toggle(resourceId: string) {
    const current = await qc.ensureQueryData(favoritesQueryOptions);
    if (current.favorites.includes(resourceId)) {
      await remove.mutateAsync(resourceId);
    } else {
      await add.mutateAsync(resourceId);
    }
  }

  return {
    favorites: list,
    isLoading: query.isLoading,
    isError: query.isError,
    isFetching: query.isFetching,
    refetch: query.refetch,
    add: (resourceId: string) => add.mutateAsync(resourceId),
    remove: (resourceId: string) => remove.mutateAsync(resourceId),
    toggle,
  };
}

// 只写不订阅：卡片上的星标按钮用。
// 列表页可能有上百张卡片，每张都订阅收藏列表会让任意一次收藏写入触发全量重渲染，
// 所以这里直接按需读写缓存，不建立查询订阅。
export function useToggleFavorite() {
  const qc = useQueryClient();

  return useCallback(
    async (resourceId: string) => {
      const current = await qc.ensureQueryData(favoritesQueryOptions);
      const saved = current.favorites.includes(resourceId)
        ? await favoritesApi.remove(resourceId)
        : await favoritesApi.add(resourceId);
      applyFavorites(qc, saved);
    },
    [qc],
  );
}
