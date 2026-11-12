import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sse } from "../api/client";
import { useScanStore } from "../store/scanStore";
import {
  aiJobsApi,
  type AIJob,
  type AIJobEstimate,
  type AIJobSnapshot,
  type AIWorkerStatus,
  type AnalysisType,
  type AnalysisMode,
} from "../api/aiJobs";

const JOBS_KEY = ["ai-jobs"] as const;
const ESTIMATE_KEY = ["ai-job-estimate"] as const;
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
  modules: AnalysisType[];
  peopleEnabled: boolean;
  /** 服务器设置已读取，可以开始编辑。 */
  ready: boolean;
  setEnabled: (value: boolean) => void;
  setTime: (value: string) => void;
  setModules: (value: AnalysisType[]) => void;
  setPeopleEnabled: (value: boolean) => void;
  save: () => void;
  saving: boolean;
  saved: boolean;
  error: boolean;
}

export interface TaskCenterState {
  snapshot?: AIJobSnapshot;
  active?: AIJob;
  sequenceSkipped?: AIJobSnapshot["modules"];
  /** 等待队列，按后端执行顺序排列。 */
  queue: AIJob[];
  /** 已结束的任务，最新的在前。 */
  history: AIJob[];
  loading: boolean;
  loadError: boolean;
  plan: TaskCenterPlan;
  /** 当前选中的分析模块与处理方式。 */
  selection: TaskCenterSelection;
  start: (type: AnalysisType, mode: AnalysisMode) => void;
  startAll: (mode: AnalysisMode) => void;
  act: (id: string, action: JobAction) => void;
  moveQueued: (id: string, direction: "up" | "down") => void;
  clearQueue: () => void;
  deleteHistoryItem: (id: string) => void;
  clearHistory: () => void;
  /** 启动或任务操作正在提交。 */
  busy: boolean;
  operationError: boolean;
  embeddingStatus?: AIWorkerStatus;
  embeddingStatusLoading: boolean;
  gpuEnabled: boolean;
  setGPUEnabled: (enabled: boolean) => void;
  gpuSaving: boolean;
  gpuSaveError: boolean;
  /** 空闲时的规模与耗时核算。 */
  estimate?: AIJobEstimate;
  estimateLoading: boolean;
  estimateError: boolean;
  /** 重新核算一次。 */
  refreshEstimate: () => void;
}

/**
 * 当前选中的模块与处理方式。
 *
 * 选择态放在数据层而不是组件里：规模估算表、按钮上的张数说明与真正发出去的
 * 启动请求必须读到同一个 mode，否则表格显示增量的数、启动的却是全量。
 */
export interface TaskCenterSelection {
  module: AnalysisType;
  mode: AnalysisMode;
  setModule: (type: AnalysisType) => void;
  setMode: (mode: AnalysisMode) => void;
}

/**
 * 任务中心的数据层：任务快照、SSE 实时更新与每日计划草稿。
 *
 * 页面组件只负责排版；数据来源只有这一处，避免页面各处各算一份。
 */
export function useTaskCenter(): TaskCenterState {
  const queryClient = useQueryClient();
  // 任务状态变了，核算也跟着变：跑完一轮增量张数会归零，清掉历史会少掉
  // 可参考的样本。
  const invalidateJobs = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: JOBS_KEY });
    void queryClient.invalidateQueries({ queryKey: ESTIMATE_KEY });
  }, [queryClient]);
  const jobsQuery = useQuery({
    queryKey: JOBS_KEY,
    queryFn: aiJobsApi.list,
    refetchInterval: (query) => {
      const snapshot = query.state.data?.snapshot;
      return snapshot?.active || snapshot?.queue?.length ? 15_000 : false;
    },
  });
  const embeddingStatusQuery = useQuery({
    queryKey: ["ai-embedding-status"],
    queryFn: aiJobsApi.embeddingStatus,
    refetchInterval: 30_000,
  });
  const estimateQuery = useQuery({
    queryKey: ESTIMATE_KEY,
    queryFn: aiJobsApi.estimate,
    staleTime: 30_000,
    refetchOnMount: "always",
  });
  const snapshot = jobsQuery.data?.snapshot;
  const active = snapshot?.active;
  const activeId = active?.id;

  // 扫描一结束，媒体库就换了：规模核算要按新库重做。
  const scanStatus = useScanStore((state) => state.progress?.status);
  useEffect(() => {
    if (scanStatus !== "complete") return;
    void queryClient.invalidateQueries({ queryKey: ESTIMATE_KEY });
  }, [queryClient, scanStatus]);

  // 每日计划是草稿：先等服务器设置到达，再允许编辑。
  // 没等就渲染会让用户改到一个随后被覆盖的假值上。
  const [planDraft, setPlanDraft] = useState<{
    enabled: boolean;
    time: string;
    modules: AnalysisType[];
    peopleEnabled: boolean;
  } | null>(null);

  // 选中的模块与处理方式。放在这里是因为规模估算表、按钮上的张数说明与
  // 启动请求都要读它 —— 分开存必然漂移。
  const [selectedModule, setSelectedModule] =
    useState<AnalysisType>("metadata");
  const [mode, setMode] = useState<AnalysisMode>("incremental");
  // 人物开关按草稿走：芯片在草稿里解锁了，选中项就不该被弹回去。
  const peopleEnabled = planDraft?.peopleEnabled ?? false;
  const runnableModules = useMemo(
    () =>
      (snapshot?.modules ?? [])
        .filter((module) => module.installed)
        .filter((module) => module.type !== "face" || peopleEnabled),
    [snapshot?.modules, peopleEnabled],
  );

  // 选中的模块不可运行时换成第一个能跑的，免得按钮一直按不下去。
  useEffect(() => {
    if (runnableModules.length === 0) return;
    if (!runnableModules.some((module) => module.type === selectedModule)) {
      setSelectedModule(runnableModules[0].type);
    }
  }, [runnableModules, selectedModule]);

  useEffect(() => {
    if (!snapshot || planDraft) return;
    setPlanDraft({
      enabled: snapshot.settings.dailyEnabled,
      time: snapshot.settings.dailyTime || "03:00",
      modules: snapshot.settings.dailyModules ?? ["metadata"],
      peopleEnabled: snapshot.settings.peopleEnabled ?? false,
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
          void invalidateJobs();
        }
      },
      { events: JOB_EVENTS, signal: controller.signal },
    );
    return () => controller.abort();
  }, [activeId, invalidateJobs, queryClient]);

  const startMutation = useMutation({
    mutationFn: ({ type, mode }: { type: AnalysisType; mode: AnalysisMode }) =>
      aiJobsApi.start(type, mode),
    onSuccess: () => void invalidateJobs(),
  });
  const startAllMutation = useMutation({
    mutationFn: (mode: AnalysisMode) => aiJobsApi.startAll(mode),
    onSuccess: () => void invalidateJobs(),
  });
  const actionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: JobAction }) =>
      aiJobsApi.action(id, action),
    onSuccess: () => void invalidateJobs(),
  });
  const managementMutation = useMutation({
    mutationFn: (
      action:
        | { type: "move"; id: string; direction: "up" | "down" }
        | { type: "clearQueue" }
        | { type: "deleteHistory"; id: string }
        | { type: "clearHistory" },
    ) => {
      switch (action.type) {
        case "move":
          return aiJobsApi.moveQueued(action.id, action.direction);
        case "clearQueue":
          return aiJobsApi.clearQueue();
        case "deleteHistory":
          return aiJobsApi.deleteHistoryItem(action.id);
        case "clearHistory":
          return aiJobsApi.clearHistory();
      }
    },
    onSuccess: () => void invalidateJobs(),
  });
  const settingsMutation = useMutation({
    mutationFn: (draft: {
      enabled: boolean;
      time: string;
      modules: AnalysisType[];
      peopleEnabled: boolean;
    }) =>
      aiJobsApi.updateSettings({
        dailyEnabled: draft.enabled,
        dailyTime: draft.time,
        dailyModules: draft.modules,
        peopleEnabled: draft.peopleEnabled,
      }),
    onSuccess: ({ settings }) => {
      setPlanDraft({
        enabled: settings.dailyEnabled,
        time: settings.dailyTime,
        modules: settings.dailyModules,
        peopleEnabled: settings.peopleEnabled,
      });
      queryClient.setQueryData<{ ok: boolean; snapshot: AIJobSnapshot }>(
        JOBS_KEY,
        (current) =>
          current
            ? { ...current, snapshot: { ...current.snapshot, settings } }
            : current,
      );
      // 人物分析开关会决定人脸模块能不能跑，核算要跟着重算。
      void queryClient.invalidateQueries({ queryKey: ESTIMATE_KEY });
    },
  });
  const hardwareMutation = useMutation({
    mutationFn: (gpuEnabled: boolean) => aiJobsApi.updateHardware(gpuEnabled),
    onMutate: async (gpuEnabled) => {
      await queryClient.cancelQueries({ queryKey: JOBS_KEY });
      const previous = queryClient.getQueryData<{
        ok: boolean;
        snapshot: AIJobSnapshot;
      }>(JOBS_KEY);
      queryClient.setQueryData<{ ok: boolean; snapshot: AIJobSnapshot }>(
        JOBS_KEY,
        (current) =>
          current
            ? {
                ...current,
                snapshot: {
                  ...current.snapshot,
                  settings: { ...current.snapshot.settings, gpuEnabled },
                },
              }
            : current,
      );
      return { previous };
    },
    onError: (_error, _gpuEnabled, context) => {
      if (context?.previous) {
        queryClient.setQueryData(JOBS_KEY, context.previous);
      }
    },
    onSuccess: ({ settings }) => {
      queryClient.setQueryData<{ ok: boolean; snapshot: AIJobSnapshot }>(
        JOBS_KEY,
        (current) =>
          current
            ? { ...current, snapshot: { ...current.snapshot, settings } }
            : current,
      );
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: JOBS_KEY }),
  });

  const queue = useMemo(() => {
    const jobsById = new Map(snapshot?.jobs.map((job) => [job.id, job]) ?? []);
    return (snapshot?.queue ?? [])
      .map((id) => jobsById.get(id))
      .filter((job): job is AIJob => job?.status === "pending");
  }, [snapshot?.jobs, snapshot?.queue]);
  const history = useMemo(
    () =>
      snapshot?.jobs.filter(
        (job) =>
          job.status === "completed" ||
          job.status === "failed" ||
          job.status === "cancelled",
      ) ?? [],
    [snapshot?.jobs],
  );

  return {
    snapshot,
    active,
    sequenceSkipped: startAllMutation.data?.skippedModules,
    queue,
    history,
    loading: jobsQuery.isLoading,
    loadError: jobsQuery.isError,
    plan: {
      enabled: planDraft?.enabled ?? false,
      time: planDraft?.time ?? "03:00",
      modules: planDraft?.modules ?? ["metadata"],
      peopleEnabled: planDraft?.peopleEnabled ?? false,
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
      setPeopleEnabled: (value: boolean) =>
        setPlanDraft((current) =>
          current
            ? {
                ...current,
                peopleEnabled: value,
                modules: value
                  ? current.modules
                  : current.modules.filter((type) => type !== "face"),
              }
            : current,
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
    moveQueued: (id: string, direction: "up" | "down") =>
      managementMutation.mutate({ type: "move", id, direction }),
    clearQueue: () => managementMutation.mutate({ type: "clearQueue" }),
    deleteHistoryItem: (id: string) =>
      managementMutation.mutate({ type: "deleteHistory", id }),
    clearHistory: () => managementMutation.mutate({ type: "clearHistory" }),
    busy:
      startMutation.isPending ||
      startAllMutation.isPending ||
      actionMutation.isPending ||
      managementMutation.isPending,
    operationError:
      startMutation.isError ||
      startAllMutation.isError ||
      actionMutation.isError ||
      managementMutation.isError,
    embeddingStatus: embeddingStatusQuery.data?.status,
    embeddingStatusLoading: embeddingStatusQuery.isLoading,
    gpuEnabled: snapshot?.settings.gpuEnabled ?? true,
    setGPUEnabled: (enabled: boolean) => hardwareMutation.mutate(enabled),
    gpuSaving: hardwareMutation.isPending,
    gpuSaveError: hardwareMutation.isError,
    selection: {
      module: selectedModule,
      mode,
      setModule: setSelectedModule,
      setMode,
    },
    estimate: estimateQuery.data?.estimate,
    estimateLoading: estimateQuery.isLoading,
    estimateError: estimateQuery.isError,
    refreshEstimate: () =>
      void queryClient.invalidateQueries({ queryKey: ESTIMATE_KEY }),
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
