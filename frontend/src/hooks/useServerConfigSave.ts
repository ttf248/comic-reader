import { useEffect, useMemo, useRef, useState } from "react";
import {
  skipToken,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { configApi, type ServerConfigPatch } from "../api/config";
import { ApiError } from "../api/client";
import { authApi } from "../api/auth";
import { useUIStore } from "../store/uiStore";
import { updateFsCapabilities } from "./useFsCapabilities";
import { libraryQueryKeys } from "./useLibrary";

export type FieldStatus = "idle" | "saving" | "saved" | "error";
type RetryablePatch = Omit<ServerConfigPatch, "accessMode" | "accessToken">;
const CONFIG_KEY = ["server-config"] as const;
const SAVE_KEY = [...CONFIG_KEY, "save"] as const;
const RECOVERY_KEY = [...CONFIG_KEY, "recovery"] as const;

interface RecoveryState {
  failed: RetryablePatch;
  rootsUncertain: boolean;
  needsScan: boolean;
  revision: number;
}

const emptyRecovery = (): RecoveryState => ({
  failed: {},
  rootsUncertain: false,
  needsScan: false,
  revision: 0,
});

function retryable(patch: ServerConfigPatch): RetryablePatch {
  return Object.fromEntries(
    Object.entries(patch).filter(
      ([key, value]) =>
        key !== "accessMode" && key !== "accessToken" && value !== undefined,
    ),
  ) as RetryablePatch;
}

function withoutFields(patch: RetryablePatch, keys: string[]): RetryablePatch {
  return Object.fromEntries(
    Object.entries(patch).filter(([key]) => !keys.includes(key)),
  ) as RetryablePatch;
}

export function useServerConfigSave(
  draft: ServerConfigPatch,
  setFieldStatus: (keys: string[], value: FieldStatus) => void,
) {
  const qc = useQueryClient();
  const pushToast = useUIStore((state) => state.pushToast);
  const mounted = useRef(false);
  const readController = useRef<AbortController | null>(null);
  const [isReading, setIsReading] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readController.current?.abort();
      readController.current = null;
    };
  }, []);

  // 只存于本次应用会话的查询缓存；不写入偏好、浏览器存储或凭据恢复记录。
  const { data: recovery = emptyRecovery() } = useQuery({
    queryKey: RECOVERY_KEY,
    queryFn: skipToken,
    enabled: false,
    initialData: emptyRecovery,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const currentRecovery = () =>
    qc.getQueryData<RecoveryState>(RECOVERY_KEY) ?? emptyRecovery();
  const changeRecovery = (change: (state: RecoveryState) => RecoveryState) =>
    qc.setQueryData<RecoveryState>(RECOVERY_KEY, (state) =>
      change(state ?? emptyRecovery()),
    );
  const pendingPatches = useMutationState<ServerConfigPatch>({
    filters: { mutationKey: SAVE_KEY, exact: true, status: "pending" },
    select: (mutation) => mutation.state.variables as ServerConfigPatch,
  });
  const pendingValues = useMemo(
    () =>
      pendingPatches.reduce<ServerConfigPatch>(
        (values, patch) => ({ ...values, ...patch }),
        {},
      ),
    [pendingPatches],
  );
  const currentPending = () =>
    qc.getMutationCache().findAll({
      mutationKey: SAVE_KEY,
      exact: true,
      status: "pending",
    });

  function cancelRead() {
    readController.current?.abort();
    readController.current = null;
    if (mounted.current) setIsReading(false);
  }

  function refreshLibrary() {
    qc.removeQueries({ queryKey: libraryQueryKeys.root });
    changeRecovery((state) => ({
      ...state,
      rootsUncertain: false,
      needsScan: true,
    }));
  }

  const update = useMutation({
    mutationKey: SAVE_KEY,
    scope: { id: "server-config" },
    mutationFn: (patch: ServerConfigPatch) => configApi.update(patch),
    onMutate: async (patch) => {
      cancelRead();
      changeRecovery((state) => ({
        ...state,
        failed: withoutFields(state.failed, Object.keys(patch)),
        revision: state.revision + 1,
      }));
      await qc.cancelQueries({ queryKey: CONFIG_KEY, exact: true });
      setFieldStatus(Object.keys(patch), "saving");
      return { committed: false };
    },
    onSuccess: async (response, patch, context) => {
      // 配置落盘与 LAN 会话建立是两步；后一步失败不能重放已确认的凭据。
      context.committed = true;
      changeRecovery((state) => ({ ...state, revision: state.revision + 1 }));
      await qc.cancelQueries({ queryKey: CONFIG_KEY, exact: true });
      qc.setQueryData(CONFIG_KEY, response.config);
      const keys = Object.keys(patch);
      changeRecovery((state) => ({
        ...state,
        failed: withoutFields(state.failed, keys),
      }));
      if (
        response.mediaRootsChanged ||
        (patch.mediaRoots !== undefined && currentRecovery().rootsUncertain)
      ) {
        // 丢失响应后重试可能得到 changed=false，仍需清理客户端旧媒体库。
        refreshLibrary();
      }
      if (keys.includes("allowOsOpen"))
        updateFsCapabilities(qc, response.config.allowOsOpen);
      if (response.config.accessMode === "lan" && patch.accessToken) {
        await authApi.login(patch.accessToken);
      } else if (patch.accessMode === "local") {
        await authApi.logout().catch(() => {});
      }
      setFieldStatus(keys, "saved");
      const changedRestart = (response.requiresRestart ?? []).filter((key) =>
        keys.includes(key),
      );
      if (changedRestart.length > 0)
        pushToast({
          kind: "info",
          message: `${changedRestart.join(", ")} 修改后需要重启后端才能生效`,
          ttl: 4500,
        });
    },
    onError: (error: unknown, patch, context) => {
      if (!context?.committed) {
        const failed = retryable(patch);
        // 网络异常、超时和 5xx 无法证明根目录写入是否已经生效。
        const uncertain =
          failed.mediaRoots !== undefined &&
          (!(error instanceof ApiError) ||
            error.status >= 500 ||
            error.status === 408);
        changeRecovery((state) => ({
          ...state,
          failed: { ...state.failed, ...failed },
          rootsUncertain: state.rootsUncertain || uncertain,
          revision: state.revision + 1,
        }));
      }
      setFieldStatus(Object.keys(patch), "error");
      pushToast({
        kind: "error",
        message: error instanceof Error ? error.message : "保存失败",
      });
    },
  });

  function visibleFailures(
    pending: ServerConfigPatch,
    keys?: (keyof ServerConfigPatch)[],
  ) {
    return Object.fromEntries(
      Object.entries(currentRecovery().failed).filter(([name]) => {
        const key = name as keyof RetryablePatch;
        return (
          draft[key] === undefined &&
          pending[key] === undefined &&
          (!keys || keys.includes(key))
        );
      }),
    ) as RetryablePatch;
  }

  function retryFailed(keys?: (keyof ServerConfigPatch)[]) {
    if (readController.current) return;
    // 直接查看实时 mutation 状态，连续点击也只会排入一次保存。
    const pending = currentPending().reduce<ServerConfigPatch>(
      (values, mutation) => ({
        ...values,
        ...(mutation.state.variables as ServerConfigPatch),
      }),
      {},
    );
    const patch = visibleFailures(pending, keys);
    if (Object.keys(patch).length > 0) update.mutate(patch);
  }

  function clearFailedFields(keys: (keyof ServerConfigPatch)[]) {
    changeRecovery((state) => ({
      ...state,
      failed: withoutFields(state.failed, keys),
    }));
    setFieldStatus(keys, "idle");
  }

  async function readCurrent() {
    if (readController.current || currentPending().length > 0) return;
    const controller = new AbortController();
    readController.current = controller;
    setIsReading(true);
    const revision = currentRecovery().revision;
    const valid = () =>
      mounted.current &&
      !controller.signal.aborted &&
      readController.current === controller &&
      currentRecovery().revision === revision;
    try {
      const config = await configApi.get(controller.signal);
      if (!valid()) return;
      await qc.cancelQueries({ queryKey: CONFIG_KEY, exact: true });
      if (!valid()) return;
      qc.setQueryData(CONFIG_KEY, config);
      updateFsCapabilities(qc, config.allowOsOpen);
      const state = currentRecovery();
      if (state.rootsUncertain) refreshLibrary();
      changeRecovery((current) => ({ ...current, failed: {} }));
      setFieldStatus(Object.keys(state.failed), "idle");
    } catch (error: unknown) {
      if (valid())
        pushToast({
          kind: "error",
          message: error instanceof Error ? error.message : "重新读取配置失败",
        });
    } finally {
      if (readController.current === controller) {
        readController.current = null;
        if (mounted.current) setIsReading(false);
      }
    }
  }

  const failedValues = recovery.failed;
  const canRetry = Object.keys(visibleFailures(pendingValues)).length > 0;
  const hasFailures =
    canRetry ||
    (recovery.rootsUncertain &&
      draft.mediaRoots === undefined &&
      pendingValues.mediaRoots === undefined);
  return {
    update,
    pendingValues,
    failedValues,
    hasFailures,
    canRetry,
    retryFailed,
    clearFailedFields,
    isReading,
    readCurrent,
    cancelRead,
    hasPending: pendingPatches.length > 0,
    needsScan: recovery.needsScan,
    clearScanNotice: () =>
      changeRecovery((state) => ({ ...state, needsScan: false })),
    canScan:
      !isReading &&
      pendingPatches.length === 0 &&
      draft.mediaRoots === undefined &&
      failedValues.mediaRoots === undefined &&
      !recovery.rootsUncertain,
  };
}
