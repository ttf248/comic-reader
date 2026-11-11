import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sse } from "../api/client";
import {
  aiJobsApi,
  type AIJob,
  type AIJobSnapshot,
  type AIWorkerStatus,
  type AnalysisType,
  type AnalysisMode,
} from "../api/aiJobs";

const JOBS_KEY = ["ai-jobs"] as const;
const JOB_EVENTS = [
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
];

export type JobAction = "pause" | "resume" | "cancel" | "retry";

const FIXED_ANALYSIS_ORDER: readonly AnalysisType[] = [
  "metadata",
  "embedding",
  "ocr",
  "face",
];

export interface TaskCenterPlan {
  /** 草稿状态：与服务器设置分开，改完点保存才写回。 */
  enabled: boolean;
  time: string;
  modules: AnalysisType[];
  /** 服务器设置已读取，可以开始编辑。 */
  ready: boolean;
  setEnabled: (value: boolean) => void;
  setTime: (value: string) => void;
  setModules: (value: AnalysisType[]) => void;
  save: () => void;
  saving: boolean;
  saved: boolean;
  error: boolean;
}

export interface TaskCenterState {
  snapshot?: AIJobSnapshot;
  active?: AIJob;
  sequenceSkipped?: AIJobSnapshot["modules"];
  /** 已结束的任务，最新的在前。 */
  history: AIJob[];
  loading: boolean;
  loadError: boolean;
  plan: TaskCenterPlan;
  start: (type: AnalysisType, mode: AnalysisMode) => void;
  startAll: (mode: AnalysisMode) => void;
  act: (id: string, action: JobAction) => void;
  /** 启动或任务操作正在提交。 */
  busy: boolean;
  operationError: boolean;
  embeddingStatus?: AIWorkerStatus;
  embeddingStatusLoading: boolean;
}

/**
 * 任务中心的数据层：任务快照、SSE 实时更新与每日计划草稿。
 *
 * 页面组件只负责排版；数据来源只有这一处，避免页面各处各算一份。
 */
export function useTaskCenter(): TaskCenterState {
  const queryClient = useQueryClient();
  const jobsQuery = useQuery({
    queryKey: JOBS_KEY,
    queryFn: aiJobsApi.list,
    refetchInterval: (query) =>
      query.state.data?.snapshot.active ? 15_000 : false,
  });
  const embeddingStatusQuery = useQuery({
    queryKey: ["ai-embedding-status"],
    queryFn: aiJobsApi.embeddingStatus,
    refetchInterval: 30_000,
  });
  const snapshot = jobsQuery.data?.snapshot;
  const active = snapshot?.active;
  const activeId = active?.id;
  // 每日计划是草稿：先等服务器设置到达，再允许编辑。
  // 没等就渲染会让用户改到一个随后被覆盖的假值上。
  const [planDraft, setPlanDraft] = useState<{
    enabled: boolean;
    time: string;
    modules: AnalysisType[];
  } | null>(null);

  useEffect(() => {
    if (!snapshot || planDraft) return;
    setPlanDraft({
      enabled: snapshot.settings.dailyEnabled,
      time: snapshot.settings.dailyTime || "03:00",
      modules: snapshot.settings.dailyModules ?? ["metadata"],
    });
  }, [snapshot, planDraft]);

  useEffect(() => {
    if (!activeId) return;
    const controller = new AbortController();
    sse(
      `/api/ai/jobs/${encodeURIComponent(activeId)}/events`,
      (_eventName, value) => {
        if (!isAIJob(value)) return;
        queryClient.setQueryData<{ ok: boolean; snapshot: AIJobSnapshot }>(
          JOBS_KEY,
          (current) => {
            if (!current) return current;
            const existing = current.snapshot.jobs.filter(
              (job) => job.id !== value.id,
            );
            const nextActive =
              value.status === "completed" ||
              value.status === "failed" ||
              value.status === "cancelled"
                ? undefined
                : value;
            return {
              ...current,
              snapshot: {
                ...current.snapshot,
                jobs: [value, ...existing],
                active: nextActive,
              },
            };
          },
        );
        if (
          value.status === "completed" ||
          value.status === "failed" ||
          value.status === "cancelled"
        ) {
          void queryClient.invalidateQueries({ queryKey: JOBS_KEY });
        }
      },
      { events: JOB_EVENTS, signal: controller.signal },
    );
    return () => controller.abort();
  }, [activeId, queryClient]);

  const startMutation = useMutation({
    mutationFn: ({ type, mode }: { type: AnalysisType; mode: AnalysisMode }) =>
      aiJobsApi.start(type, mode),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: JOBS_KEY }),
  });
  const startAllMutation = useMutation({
    mutationFn: (mode: AnalysisMode) => aiJobsApi.startAll(mode),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: JOBS_KEY }),
  });
  const actionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: JobAction }) =>
      aiJobsApi.action(id, action),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: JOBS_KEY }),
  });
  const settingsMutation = useMutation({
    mutationFn: (draft: {
      enabled: boolean;
      time: string;
      modules: AnalysisType[];
    }) =>
      aiJobsApi.updateSettings({
        dailyEnabled: draft.enabled,
        dailyTime: draft.time,
        dailyModules: draft.modules,
      }),
    onSuccess: ({ settings }) => {
      setPlanDraft({
        enabled: settings.dailyEnabled,
        time: settings.dailyTime,
        modules: settings.dailyModules,
      });
      queryClient.setQueryData<{ ok: boolean; snapshot: AIJobSnapshot }>(
        JOBS_KEY,
        (current) =>
          current
            ? { ...current, snapshot: { ...current.snapshot, settings } }
            : current,
      );
    },
  });

  const history = useMemo(() => {
    const jobs = snapshot?.jobs.filter((job) => job.id !== active?.id) ?? [];
    const pending = jobs
      .filter((job) => job.status === "pending")
      .sort((left, right) => {
        const createdOrder = left.createdAt.localeCompare(right.createdAt);
        if (createdOrder !== 0) return createdOrder;
        const leftOrder = left.scheduled
          ? (snapshot?.settings.dailyModules ?? FIXED_ANALYSIS_ORDER)
          : FIXED_ANALYSIS_ORDER;
        const rightOrder = right.scheduled
          ? (snapshot?.settings.dailyModules ?? FIXED_ANALYSIS_ORDER)
          : FIXED_ANALYSIS_ORDER;
        const leftRank = leftOrder.indexOf(left.type);
        const rightRank = rightOrder.indexOf(right.type);
        return leftRank - rightRank;
      });
    return [...pending, ...jobs.filter((job) => job.status !== "pending")];
  }, [active?.id, snapshot?.jobs, snapshot?.settings.dailyModules]);

  return {
    snapshot,
    active,
    sequenceSkipped: startAllMutation.data?.skippedModules,
    history,
    loading: jobsQuery.isLoading,
    loadError: jobsQuery.isError,
    plan: {
      enabled: planDraft?.enabled ?? false,
      time: planDraft?.time ?? "03:00",
      modules: planDraft?.modules ?? ["metadata"],
      ready: planDraft !== null,
      setEnabled: (value: boolean) =>
        setPlanDraft((current) =>
          current ? { ...current, enabled: value } : current,
        ),
      setTime: (value: string) =>
        setPlanDraft((current) =>
          current ? { ...current, time: value } : current,
        ),
      setModules: (value: AnalysisType[]) =>
        setPlanDraft((current) =>
          current ? { ...current, modules: value } : current,
        ),
      save: () => {
        if (planDraft) settingsMutation.mutate(planDraft);
      },
      saving: settingsMutation.isPending,
      saved: settingsMutation.isSuccess,
      error: settingsMutation.isError,
    },
    start: (type: AnalysisType, mode: AnalysisMode) =>
      startMutation.mutate({ type, mode }),
    startAll: (mode: AnalysisMode) => startAllMutation.mutate(mode),
    act: (id: string, action: JobAction) =>
      actionMutation.mutate({ id, action }),
    busy:
      startMutation.isPending ||
      startAllMutation.isPending ||
      actionMutation.isPending,
    operationError:
      startMutation.isError ||
      startAllMutation.isError ||
      actionMutation.isError,
    embeddingStatus: embeddingStatusQuery.data?.status,
    embeddingStatusLoading: embeddingStatusQuery.isLoading,
  };
}

function isAIJob(value: unknown): value is AIJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Record<string, unknown>;
  return (
    typeof job.id === "string" &&
    typeof job.status === "string" &&
    typeof job.done === "number"
  );
}
