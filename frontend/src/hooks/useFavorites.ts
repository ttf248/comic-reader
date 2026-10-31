import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { favoritesApi } from "../api/prefs";

const EMPTY_FAVORITES: string[] = [];
const favoritesQueryOptions = {
  queryKey: ["favorites"],
  queryFn: () => favoritesApi.list(),
  staleTime: 30_000,
};

// 收藏集合的全局 hook：list + toggle
export function useFavorites() {
  const qc = useQueryClient();

  const query = useQuery(favoritesQueryOptions);

  const updateFavorites = (
    saved: Awaited<ReturnType<typeof favoritesApi.list>>,
  ) => {
    qc.setQueryData(favoritesQueryOptions.queryKey, saved);
    void qc.invalidateQueries({ queryKey: favoritesQueryOptions.queryKey });
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
