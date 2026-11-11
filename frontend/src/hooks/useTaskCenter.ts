import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sse } from "../api/client";
import {
  aiJobsApi,
  type AIJob,
  type AIJobSnapshot,
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

export interface TaskCenterPlan {
  /** 草稿状态：与服务器设置分开，改完点保存才写回。 */
  enabled: boolean;
  time: string;
  /** 服务器设置已读取，可以开始编辑。 */
  ready: boolean;
  setEnabled: (value: boolean) => void;
  setTime: (value: string) => void;
  save: () => void;
  saving: boolean;
  saved: boolean;
  error: boolean;
}

export interface TaskCenterState {
  snapshot?: AIJobSnapshot;
  active?: AIJob;
  /** 已结束的任务，最新的在前。 */
  history: AIJob[];
  loading: boolean;
  loadError: boolean;
  plan: TaskCenterPlan;
  start: (mode: AnalysisMode) => void;
  act: (id: string, action: JobAction) => void;
  /** 启动或任务操作正在提交。 */
  busy: boolean;
  operationError: boolean;
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
  const snapshot = jobsQuery.data?.snapshot;
  const active = snapshot?.active;
  const activeId = active?.id;
  // 每日计划是草稿：先等服务器设置到达，再允许编辑。
  // 没等就渲染会让用户改到一个随后被覆盖的假值上。
  const [planDraft, setPlanDraft] = useState<{
    enabled: boolean;
    time: string;
  } | null>(null);

  useEffect(() => {
    if (!snapshot || planDraft) return;
    setPlanDraft({
      enabled: snapshot.settings.dailyEnabled,
      time: snapshot.settings.dailyTime || "03:00",
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
      },
      { events: JOB_EVENTS, signal: controller.signal },
    );
    return () => controller.abort();
  }, [activeId, queryClient]);

  const startMutation = useMutation({
    mutationFn: (mode: AnalysisMode) => aiJobsApi.start("metadata", mode),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: JOBS_KEY }),
  });
  const actionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: JobAction }) =>
      aiJobsApi.action(id, action),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: JOBS_KEY }),
  });
  const settingsMutation = useMutation({
    mutationFn: (draft: { enabled: boolean; time: string }) =>
      aiJobsApi.updateSettings({
        dailyEnabled: draft.enabled,
        dailyTime: draft.time,
      }),
    onSuccess: ({ settings }) => {
      setPlanDraft({
        enabled: settings.dailyEnabled,
        time: settings.dailyTime,
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

  const history = useMemo(
    () => snapshot?.jobs.filter((job) => job.id !== active?.id) ?? [],
    [active?.id, snapshot?.jobs],
  );

  return {
    snapshot,
    active,
    history,
    loading: jobsQuery.isLoading,
    loadError: jobsQuery.isError,
    plan: {
      enabled: planDraft?.enabled ?? false,
      time: planDraft?.time ?? "03:00",
      ready: planDraft !== null,
      setEnabled: (value: boolean) =>
        setPlanDraft((current) =>
          current ? { ...current, enabled: value } : current,
        ),
      setTime: (value: string) =>
        setPlanDraft((current) =>
          current ? { ...current, time: value } : current,
        ),
      save: () => {
        if (planDraft) settingsMutation.mutate(planDraft);
      },
      saving: settingsMutation.isPending,
      saved: settingsMutation.isSuccess,
      error: settingsMutation.isError,
    },
    start: (mode: AnalysisMode) => startMutation.mutate(mode),
    act: (id: string, action: JobAction) =>
      actionMutation.mutate({ id, action }),
    busy: startMutation.isPending || actionMutation.isPending,
    operationError: startMutation.isError || actionMutation.isError,
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
