import { useQuery, type QueryClient } from "@tanstack/react-query";
import { fsApi, type FsCapabilities } from "../api/fs";

export const fsCapabilitiesQueryKey = ["fs-capabilities"] as const;

export function useFsCapabilities(): boolean {
  const { data } = useQuery({
    queryKey: fsCapabilitiesQueryKey,
    queryFn: ({ signal }) => fsApi.capabilities(signal),
    staleTime: 30_000,
    retry: false,
  });
  return data?.allowOsOpen === true;
}

// 配置读取或保存已确认的权限直接更新共享缓存，取消旧健康检查的回填。
export function updateFsCapabilities(
  client: QueryClient,
  allowOsOpen: boolean,
) {
  void client.cancelQueries({ queryKey: fsCapabilitiesQueryKey, exact: true });
  client.setQueryData<FsCapabilities>(fsCapabilitiesQueryKey, { allowOsOpen });
}
