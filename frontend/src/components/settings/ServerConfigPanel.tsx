import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  configApi,
  type ServerConfig,
  type ServerConfigPatch,
} from "../../api/config";
import { useUIStore } from "../../store/uiStore";
import { fsApi } from "../../api/fs";
import { updateFsCapabilities } from "../../hooks/useFsCapabilities";
import { fileManagerErrorMessage } from "../../utils/fileManager";
import { authApi } from "../../api/auth";
import { ApiError } from "../../api/client";
import { useScanSSE } from "../../hooks/useScanSSE";
import { scanApi } from "../../api/scan";
import { libraryQueryKeys } from "../../hooks/useLibrary";
import DirectoryPicker from "./DirectoryPicker";
import {
  CheckIcon,
  AlertIcon,
  RefreshIcon,
  RestartIcon,
  TrashIcon,
  PlusIcon,
  FolderOpenIcon,
  FolderSearchIcon,
} from "../common/Icon";

// 单个字段的保存状态。
type FieldStatus = "idle" | "saving" | "saved" | "error";

// 哪些字段改动后需要重启才生效。
const REQUIRES_RESTART = new Set([
  "host",
  "port",
  "staticDir",
  "cacheDir",
  "ffmpegPath",
]);

// 哪些字段是路径类（用 onBlur 自动保存,不用 debounce）。
// mediaRoots 是例外:它在用户停止输入后自动保存,避免刷新页面时丢失
// 尚未失焦的修改。其余路径输入仍须按 Enter 或离开输入框确认。
//
// excludePatterns / systemFiles 同样按 onBlur 保存 — 它们虽不是路径,
// 但都是「类数组文本」(一行一项),用户经常连续粘贴多行;debounce 会
// 把多次按键当作一次输入,体感很怪,所以走 pathDirtyRef 同一条路径。
const PATH_FIELDS = new Set([
  "mediaRoots",
  "cacheDir",
  "staticDir",
  "excludePatterns",
  "systemFiles",
]);

// 媒体根目录在用户停止输入后的自动保存等待时间。不能逐字符提交：后端会
// 校验目录必须存在，输入中的不完整路径不应产生错误提示或污染当前配置。
const MEDIA_ROOTS_AUTOSAVE_DELAY = 450;

// 字段定义:标签、说明、是否重启字段、UI 类型。
// mediaRoots 是特例:用 MediaRootsField 组件单独渲染,不走通用 ConfigRow。
type FieldDef =
  | {
      key: Exclude<keyof ServerConfigPatch, "mediaRoots">;
      label: string;
      hint?: string;
      kind: "text";
    }
  | {
      key: Exclude<keyof ServerConfigPatch, "mediaRoots">;
      label: string;
      hint?: string;
      kind: "number";
      min?: number;
      max?: number;
    }
  | {
      key: Exclude<keyof ServerConfigPatch, "mediaRoots">;
      label: string;
      hint?: string;
      kind: "boolean";
    };

const FIELDS: { section: string; defs: FieldDef[] }[] = [
  {
    section: "媒体库",
    defs: [
      {
        key: "cacheDir",
        label: "缓存目录",
        hint: "存放缩略图 / 扫描结果 / 用户偏好，修改后需重启",
        kind: "text",
      },
    ],
  },
  {
    section: "缩略图",
    defs: [
      {
        key: "thumbSizeW",
        label: "缩略图宽度",
        kind: "number",
        min: 50,
        max: 2000,
      },
      {
        key: "thumbSizeH",
        label: "缩略图高度",
        kind: "number",
        min: 50,
        max: 2000,
      },
      {
        key: "thumbCacheSize",
        label: "LRU 缓存项数",
        hint: "内存中保留多少张已生成的缩略图",
        kind: "number",
        min: 50,
        max: 5000,
      },
      {
        key: "cacheMaxAgeDays",
        label: "缓存保留天数",
        hint: "超出后被清理",
        kind: "number",
        min: 1,
        max: 365,
      },
      {
        key: "cacheMaxSizeMB",
        label: "派生缓存容量（MiB）",
        hint: "启动和每小时清理；0 不限制容量，新产物保留至少十分钟",
        kind: "number",
        min: 0,
        max: 1048576,
      },
    ],
  },
  {
    section: "网络",
    defs: [
      {
        key: "host",
        label: "监听地址",
        hint: "修改后需要重启后端",
        kind: "text",
      },
      {
        key: "port",
        label: "监听端口",
        hint: "修改后需要重启后端",
        kind: "number",
        min: 1,
        max: 65535,
      },
    ],
  },
  {
    section: "静态资源",
    defs: [
      {
        key: "staticDir",
        label: "前端构建目录",
        hint: "修改后需要重启后端",
        kind: "text",
      },
    ],
  },
  {
    section: "安全",
    defs: [
      {
        key: "allowOsOpen",
        label: "允许在系统文件管理器中打开",
        hint: "仅建议在受信环境开启",
        kind: "boolean",
      },
    ],
  },
];

// 每个 field 的当前保存状态;key 由 section+key 拼成。
type StatusMap = Record<string, FieldStatus>;

export default function ServerConfigPanel() {
  const qc = useQueryClient();
  const pushToast = useUIStore((s) => s.pushToast);
  const scanSSE = useScanSSE();

  const {
    data,
    error: queryError,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["server-config"],
    queryFn: async ({ signal }) => {
      const config = await configApi.get();
      if (!signal.aborted) updateFsCapabilities(qc, config.allowOsOpen);
      return config;
    },
  });

  const [status, setStatus] = useState<StatusMap>({});
  const mounted = useRef(false);
  // 每个字段独立计时；再次保存或离开面板时取消旧提示的清理任务。
  const savedTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    mounted.current = true;
    const timers = savedTimers.current;
    return () => {
      mounted.current = false;
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  function setFieldStatus(keys: string[], value: FieldStatus) {
    // 写请求可在卸载后完成，共享缓存仍更新，但不再创建页面状态和定时器。
    if (!mounted.current) return;
    const timers = savedTimers.current;
    keys.forEach((key) => {
      clearTimeout(timers.get(key));
      timers.delete(key);
    });
    setStatus((current) => {
      const next = { ...current };
      keys.forEach((key) => (next[key] = value));
      return next;
    });
    if (value !== "saved") return;
    keys.forEach((key) => {
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          setStatus((current) =>
            current[key] === "saved" ? { ...current, [key]: "idle" } : current,
          );
        }, 1500),
      );
    });
  }

  const [mediaRootsDirty, setMediaRootsDirty] = useState(false);
  // 暂存用户输入:草稿,避免每次 onChange 都触发 PUT(输入体验更顺)
  const [draft, setDraft] = useState<ServerConfigPatch>({});
  const [composingFields, setComposingFields] = useState<
    ReadonlyMap<keyof ServerConfigPatch, number>
  >(() => new Map());
  const debouncedMediaRoots = useAutosaveSnapshot(
    draft.mediaRoots,
    MEDIA_ROOTS_AUTOSAVE_DELAY,
    composingFields.has("mediaRoots"),
  );
  const [accessTokenDraft, setAccessTokenDraft] = useState("");
  const [accessError, setAccessError] = useState("");
  // 按字段排除仍在组合输入的候选文字，不阻塞其他字段的自动保存。
  const autosaveDraft = useMemo(
    () =>
      Object.fromEntries(
        (Object.keys(draft) as (keyof ServerConfigPatch)[])
          .filter((key) => !PATH_FIELDS.has(key) && !composingFields.has(key))
          .map((key) => [key, draft[key]]),
      ) as ServerConfigPatch,
    [draft, composingFields],
  );
  const debouncedDraft = useAutosaveSnapshot(autosaveDraft, 600);
  // 当前"路径类草稿"按字段拆,onBlur 时取对应字段提交
  const pathDirtyRef = useRef<
    Partial<Record<keyof ServerConfigPatch, unknown>>
  >({});
  const flushRef = useRef<(patch: ServerConfigPatch) => void>(() => {});

  // 只提交当前完整等待过保存间隔的快照，旧计时结果不能清掉新输入。
  useEffect(() => {
    if (!debouncedDraft) return;
    const keys = Object.keys(debouncedDraft) as (keyof ServerConfigPatch)[];
    if (keys.length === 0) return;
    flushRef.current(debouncedDraft);
    setDraft((current) => {
      const next = { ...current };
      keys.forEach((key) => {
        if (current[key] === debouncedDraft[key]) delete next[key];
      });
      return next;
    });
  }, [debouncedDraft]);

  function setFieldComposing(key: keyof ServerConfigPatch, active: boolean) {
    if (!mounted.current) return;
    setComposingFields((current) => {
      const previous = current.get(key) ?? 0;
      const count = Math.max(0, previous + (active ? 1 : -1));
      if (previous === count) return current;
      const next = new Map(current);
      if (count > 0) next.set(key, count);
      else next.delete(key);
      return next;
    });
  }

  const update = useMutation({
    mutationFn: (patch: ServerConfigPatch) => configApi.update(patch),
    onMutate: (patch) => {
      void qc.cancelQueries({ queryKey: ["server-config"], exact: true });
      setFieldStatus(Object.keys(patch), "saving");
    },
    onSuccess: (resp, patch) => {
      const keys = Object.keys(patch);
      setFieldStatus(keys, "saved");
      qc.setQueryData(["server-config"], resp.config);

      // 标记 MediaRoots 变脏 → 提示用户重新扫描
      if (resp.mediaRootsChanged) {
        // 后端会丢弃旧扫描快照；同步删除所有前端摘要，不能让旧库短暂回显。
        qc.removeQueries({ queryKey: libraryQueryKeys.root });
        if (mounted.current) setMediaRootsDirty(true);
      }
      // 保存结果已确认权限，直接发布，避免额外健康请求失败或旧响应覆盖。
      if (keys.includes("allowOsOpen")) {
        updateFsCapabilities(qc, resp.config.allowOsOpen);
      }
      // 重启字段提示
      const needRestart = resp.requiresRestart ?? [];
      const changedRestart = needRestart.filter((f) => keys.includes(f));
      if (changedRestart.length > 0) {
        pushToast({
          kind: "info",
          message: `${changedRestart.join(", ")} 修改后需要重启后端才能生效`,
          ttl: 4500,
        });
      }
    },
    onError: (err: unknown, patch) => {
      setFieldStatus(Object.keys(patch ?? {}), "error");
      const msg = err instanceof Error ? err.message : "保存失败";
      pushToast({ kind: "error", message: msg });
    },
  });

  function flush(patch: ServerConfigPatch) {
    update.mutate(patch);
  }
  flushRef.current = flush;

  // 媒体根目录输入后自动保存，而非等待 blur。pathDirtyRef 保存的是最近
  // 一次输入的数组引用；借此忽略已被新输入替换的过期 debounce 结果。
  useEffect(() => {
    if (debouncedMediaRoots === undefined) return;
    if (pathDirtyRef.current.mediaRoots !== debouncedMediaRoots) return;

    // "添加根目录"会先插入空输入槽位。目录尚未补全时不发无效 PATCH，
    // 待所有输入槽位都有值后再自动提交。
    if (debouncedMediaRoots.some((root) => root.trim() === "")) return;

    delete pathDirtyRef.current.mediaRoots;
    setDraft((current) => {
      if (current.mediaRoots !== debouncedMediaRoots) return current;
      const next = { ...current };
      delete next.mediaRoots;
      return next;
    });
    flushRef.current({ mediaRoots: debouncedMediaRoots });
  }, [debouncedMediaRoots]);

  async function enableLANAccess() {
    const token = accessTokenDraft.trim();
    if (token.length < 32 || token.length > 256 || /\s/u.test(token)) {
      setAccessError("访问令牌必须是 32-256 个无空白字符");
      return;
    }
    setAccessError("");
    try {
      await update.mutateAsync({ accessMode: "lan", accessToken: token });
      // 配置热更新后旧会话立即失效；用同一令牌立即换取新会话，
      // 避免设置页下一个请求才突然跳到解锁页。
      await authApi.login(token);
      setAccessTokenDraft("");
    } catch {
      setAccessError("访问配置未完成，请确认令牌后重试");
    }
  }

  async function disableLANAccess() {
    setAccessError("");
    try {
      await update.mutateAsync({ accessMode: "local", accessToken: "" });
      await authApi.logout().catch(() => {});
      setAccessTokenDraft("");
    } catch {
      setAccessError("无法切换为仅本机访问");
    }
  }

  // 路径类字段保存:onBlur 时调用
  function flushPathField(key: keyof ServerConfigPatch) {
    const v = pathDirtyRef.current[key];
    if (v === undefined) return;
    delete pathDirtyRef.current[key];
    setDraft((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });
    flush({ [key]: v } as ServerConfigPatch);
  }

  function cancelPathField(key: keyof ServerConfigPatch) {
    // 先同步失效待提交引用，避免随后的 blur 或旧 debounce 再次保存。
    delete pathDirtyRef.current[key];
    setDraft((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  if (isLoading) {
    return <div className="text-sm text-fg-muted">加载中…</div>;
  }

  if (!data) {
    const localOnly =
      queryError instanceof ApiError &&
      queryError.code === "local_access_required";
    return (
      <div className="rounded-md border border-border-faint bg-bg-elevated px-4 py-4">
        <p className="text-sm text-fg">
          {localOnly
            ? "服务端设置仅可在运行服务的计算机上管理"
            : "无法读取服务端设置"}
        </p>
        {!localOnly && (
          <button
            type="button"
            className="mt-3 h-8 px-3 rounded-md border border-border text-xs hover:bg-bg-hover"
            onClick={() => void refetch()}
          >
            重试
          </button>
        )}
      </div>
    );
  }

  const fieldValue = (
    key: keyof ServerConfigPatch,
  ): string | number | boolean => {
    // draft 优先:用户正在编辑的字段实时反映,否则从后端返回的当前值读
    if (key in draft && draft[key] !== undefined) {
      return draft[key] as never;
    }
    return (data as ServerConfig)[key as keyof ServerConfig] as never;
  };

  return (
    <div className="space-y-6">
      {/* 媒体库 — 多根(独立渲染) */}
      <div>
        <div className="text-[11px] uppercase tracking-[0.18em] text-fg-muted font-medium mb-2 px-1">
          媒体库
        </div>
        <div className="bg-bg-elevated border border-border-faint rounded-md overflow-hidden">
          <MediaRootsField
            // 用 draft 中的 mediaRoots 覆盖 data(draft 是用户当前编辑状态)
            // data.mediaRoots 在新装 / 没显式设过媒体库时是 null,不能传给下游
            // MediaRootsField(其内部对 roots 做 .join / .length 等操作,直接炸)
            roots={draft.mediaRoots ?? data.mediaRoots ?? []}
            status={status["mediaRoots"] ?? "idle"}
            allowOsOpen={data.allowOsOpen}
            onChange={(next) => {
              setDraft((d) => ({ ...d, mediaRoots: next }));
              pathDirtyRef.current.mediaRoots = next;
              setStatus((s) =>
                s["mediaRoots"] === "saved" ? { ...s, mediaRoots: "idle" } : s,
              );
            }}
            onOpenInExplorer={openConfiguredDirectory}
            onCancel={() => cancelPathField("mediaRoots")}
            onCompositionChange={(active) =>
              setFieldComposing("mediaRoots", active)
            }
          />
        </div>
      </div>

      {/* 扫描 — 排除规则(独立渲染,行为与 MediaRootsField 类似但用 textarea) */}
      <div>
        <div className="text-[11px] uppercase tracking-[0.18em] text-fg-muted font-medium mb-2 px-1">
          扫描
        </div>
        <div className="bg-bg-elevated border border-border-faint rounded-md overflow-hidden">
          <ExcludeRulesField
            patterns={draft.excludePatterns ?? data.excludePatterns ?? []}
            systemFiles={draft.systemFiles ?? data.systemFiles ?? []}
            skipHidden={draft.skipHidden ?? data.skipHidden}
            patternsStatus={status["excludePatterns"] ?? "idle"}
            systemFilesStatus={status["systemFiles"] ?? "idle"}
            skipHiddenStatus={status["skipHidden"] ?? "idle"}
            onPatternsChange={(next) => {
              setDraft((d) => ({ ...d, excludePatterns: next }));
              pathDirtyRef.current.excludePatterns = next;
              setStatus((s) =>
                s["excludePatterns"] === "saved"
                  ? { ...s, excludePatterns: "idle" }
                  : s,
              );
            }}
            onSystemFilesChange={(next) => {
              setDraft((d) => ({ ...d, systemFiles: next }));
              pathDirtyRef.current.systemFiles = next;
              setStatus((s) =>
                s["systemFiles"] === "saved"
                  ? { ...s, systemFiles: "idle" }
                  : s,
              );
            }}
            onSkipHiddenChange={(v) => {
              setDraft((d) => ({ ...d, skipHidden: v }));
              setStatus((s) =>
                s["skipHidden"] === "saved" ? { ...s, skipHidden: "idle" } : s,
              );
            }}
            onPatternsCommit={() => flushPathField("excludePatterns")}
            onSystemFilesCommit={() => flushPathField("systemFiles")}
          />
        </div>
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-[0.18em] text-fg-muted font-medium mb-2 px-1">
          访问控制
        </div>
        <div className="bg-bg-elevated border border-border-faint rounded-md px-4 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm text-fg">
                {data.accessMode === "lan" ? "局域网令牌保护" : "仅本机访问"}
              </div>
              <p className="text-xs text-fg-subtle mt-1 leading-5 max-w-xl">
                {data.accessMode === "lan"
                  ? "远程浏览器必须用令牌换取 8 小时会话；令牌不会回显。"
                  : "默认模式，所有 API 只允许运行服务的计算机访问。"}
              </p>
            </div>
            <span className="shrink-0 rounded-full border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-fg-muted">
              {data.accessMode === "lan" ? "LAN" : "LOCAL"}
            </span>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              type="password"
              value={accessTokenDraft}
              onChange={(event) => {
                setAccessTokenDraft(event.target.value);
                setAccessError("");
              }}
              autoComplete="new-password"
              spellCheck={false}
              maxLength={256}
              aria-label={
                data.accessMode === "lan" ? "新访问令牌" : "LAN 访问令牌"
              }
              placeholder={
                data.accessMode === "lan" && data.accessTokenConfigured
                  ? "输入至少 32 位新令牌以轮换"
                  : "至少 32 个无空白字符"
              }
              className="h-9 min-w-72 flex-1 rounded-md border border-border-faint bg-bg-subtle px-3 font-mono text-sm focus:outline-none focus:border-accent"
            />
            <button
              type="button"
              disabled={update.isPending || accessTokenDraft.trim().length < 32}
              onClick={() => void enableLANAccess()}
              className="h-9 px-3 rounded-md bg-accent text-accent-contrast text-xs font-medium disabled:opacity-50"
            >
              {data.accessMode === "lan" ? "轮换令牌" : "开启 LAN 访问"}
            </button>
            {data.accessMode === "lan" && (
              <button
                type="button"
                disabled={update.isPending}
                onClick={() => void disableLANAccess()}
                className="h-9 px-3 rounded-md border border-border text-xs text-fg-muted hover:bg-bg-hover disabled:opacity-50"
              >
                切换为仅本机
              </button>
            )}
          </div>
          {accessError && (
            <p role="alert" className="mt-2 text-xs text-danger">
              {accessError}
            </p>
          )}
          <p className="mt-2 text-[11px] text-fg-subtle">
            对外访问还需将监听地址设为局域网 IP 或
            0.0.0.0；修改监听地址需重启。内置服务不提供
            TLS，请仅用于可信家庭网络。
          </p>
        </div>
      </div>

      {FIELDS.map((group) => (
        <div key={group.section}>
          <div className="text-[11px] uppercase tracking-[0.18em] text-fg-muted font-medium mb-2 px-1">
            {group.section}
          </div>
          <div className="bg-bg-elevated border border-border-faint rounded-md divide-y divide-border-faint overflow-hidden">
            {group.defs.map((def) => {
              const statusKey = def.key;
              const st = status[statusKey] ?? "idle";
              const requiresRestart = REQUIRES_RESTART.has(def.key as string);
              const isPath = PATH_FIELDS.has(def.key as string);
              return (
                <ConfigRow
                  key={def.key}
                  def={def}
                  value={fieldValue(def.key)}
                  status={st}
                  requiresRestart={requiresRestart}
                  isPath={isPath}
                  allowOsOpen={data.allowOsOpen}
                  onChange={(v) => {
                    // 每次输入只更新草稿;非路径字段 debounce 后再 flush,
                    // 路径字段由 onBlur 触发 flush
                    setDraft((d) => ({ ...d, [def.key]: v as never }));
                    if (isPath) {
                      pathDirtyRef.current[def.key] = v;
                      setStatus((s) =>
                        s[statusKey] === "saved"
                          ? { ...s, [statusKey]: "idle" }
                          : s,
                      );
                    } else {
                      setStatus((s) =>
                        s[statusKey] === "saved"
                          ? { ...s, [statusKey]: "idle" }
                          : s,
                      );
                    }
                  }}
                  onCommit={isPath ? () => flushPathField(def.key) : undefined}
                  onCancel={() => cancelPathField(def.key)}
                  onCompositionChange={(active) =>
                    setFieldComposing(def.key, active)
                  }
                />
              );
            })}
          </div>
        </div>
      ))}

      {mediaRootsDirty && (
        <div className="bg-accent/5 border border-accent/30 rounded-md px-4 py-3 flex items-center justify-between gap-3 text-sm">
          <div className="flex items-center gap-2 text-fg">
            <RefreshIcon size={14} />
            <span>媒体根目录已变更,旧扫描结果已清空,建议重新扫描</span>
          </div>
          <button
            onClick={async () => {
              try {
                const { scanId } = await scanApi.start();
                scanSSE.startWith(scanId);
                setMediaRootsDirty(false);
                pushToast({ kind: "success", message: "已开始重新扫描" });
              } catch {
                pushToast({ kind: "error", message: "启动扫描失败" });
              }
            }}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-accent/40 text-accent hover:bg-accent/10 text-xs transition-colors"
          >
            <RefreshIcon size={11} />
            立即重新扫描
          </button>
        </div>
      )}

      <div className="text-xs text-fg-subtle leading-relaxed px-1">
        配置文件路径:
        <code className="font-mono text-fg-muted">{data.configPath}</code>;
        改完自动写回 YAML,无需手动保存。
      </div>
    </div>
  );
}

// 仅在当前输入完整等待过间隔后返回快照；暂停、恢复和新输入都会让旧结果失效。
function useAutosaveSnapshot<T>(
  value: T,
  delay: number,
  paused = false,
): T | undefined {
  const [snapshot, setSnapshot] = useState<{ value: T } | null>(null);
  useEffect(() => {
    if (paused) {
      setSnapshot(null);
      return;
    }
    const timer = setTimeout(() => setSnapshot({ value }), delay);
    return () => clearTimeout(timer);
  }, [value, delay, paused]);
  return !paused && snapshot !== null && snapshot.value === value
    ? snapshot.value
    : undefined;
}

function useConfigComposition(
  onChange: (value: string) => void,
  onCompositionChange: (active: boolean) => void,
) {
  const active = useRef(false);
  const notify = useRef(onCompositionChange);
  notify.current = onCompositionChange;
  const clear = () => {
    if (!active.current) return;
    active.current = false;
    notify.current(false);
  };
  useEffect(
    () => () => {
      if (active.current) {
        active.current = false;
        notify.current(false);
      }
    },
    [],
  );
  return {
    active,
    start: () => {
      if (active.current) return;
      active.current = true;
      notify.current(true);
    },
    finish: (value: string) => {
      if (!active.current) return;
      // 即使文字未变化也发布一次新草稿，从确认输入起重新计算保存间隔。
      onChange(value);
      clear();
    },
    clear,
  };
}

// ---- 多根字段(独立组件)----

function MediaRootsField({
  roots,
  status,
  allowOsOpen,
  onChange,
  onOpenInExplorer,
  onCancel,
  onCompositionChange,
}: {
  roots: string[];
  status: FieldStatus;
  allowOsOpen: boolean;
  onChange: (next: string[]) => void;
  onOpenInExplorer: (path: string) => void;
  onCancel: () => void;
  onCompositionChange: (active: boolean) => void;
}) {
  // 始终渲染一个空槽位(即使当前为空),方便用户添加第一个根
  const list = roots.length === 0 ? [""] : roots;
  const updateAt = (i: number, v: string) => {
    const next = [...roots];
    if (i < next.length) {
      next[i] = v;
    } else {
      // 空槽位:替换为新值
      next[0] = v;
    }
    onChange(next);
  };
  const removeAt = (i: number) => {
    if (i >= roots.length) {
      // 当前是空槽位:直接清空
      onChange([]);
      return;
    }
    const next = [...roots];
    next.splice(i, 1);
    onChange(next);
  };
  const addEmpty = () => {
    onChange([...roots, ""]);
  };
  return (
    <div className="px-4 py-3 text-sm space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col">
          <span className="text-fg">图像根目录</span>
          <span className="text-xs text-fg-subtle mt-0.5">
            多个目录都会扫描，相册按来源分组，徽标显示所属目录。按 Esc
            撤销整组尚未提交的修改。
          </span>
        </div>
        <StatusBadge status={status} />
      </div>
      <div className="space-y-2">
        {list.map((v, i) => (
          <PathField
            key={i}
            value={v}
            placeholder="E:\照片 或 /home/user/pics"
            // 只在已存在的根上提供"打开资源管理器"(空槽位不算)
            onOpenInExplorer={
              i < roots.length && v && allowOsOpen
                ? () => onOpenInExplorer(v)
                : undefined
            }
            onPick={(picked) => updateAt(i, picked)}
            onChange={(nv) => updateAt(i, nv)}
            onCancel={onCancel}
            onCompositionChange={onCompositionChange}
            removable={roots.length > 1}
            onRemove={() => removeAt(i)}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={addEmpty}
        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border-faint text-fg-muted hover:text-fg hover:border-border-strong text-xs transition-colors"
      >
        <PlusIcon size={12} />
        添加根目录
      </button>
    </div>
  );
}

// ---- 单个字段行 ----

function ConfigRow({
  def,
  value,
  status,
  requiresRestart,
  isPath,
  allowOsOpen,
  onChange,
  onCommit,
  onCancel,
  onCompositionChange,
}: {
  def: FieldDef;
  value: string | number | boolean;
  status: FieldStatus;
  requiresRestart: boolean;
  isPath: boolean;
  allowOsOpen: boolean;
  onChange: (v: string | number | boolean) => void;
  onCommit?: () => void;
  onCancel: () => void;
  onCompositionChange: (active: boolean) => void;
}) {
  const composition = useConfigComposition((value) => {
    if (def.kind === "number") {
      const number = Number(value);
      if (Number.isFinite(number)) onChange(number);
    } else if (def.kind === "text") {
      onChange(value);
    }
  }, onCompositionChange);
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
      <div className="flex flex-col min-w-0">
        <span className="text-fg flex items-center gap-2">
          {def.label}
          {requiresRestart && (
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-fg-subtle border border-border-faint px-1.5 py-0.5 rounded">
              <RestartIcon size={10} />
              需重启
            </span>
          )}
        </span>
        {def.hint && (
          <span className="text-xs text-fg-subtle mt-0.5">{def.hint}</span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {def.kind === "text" && isPath ? (
          <PathField
            value={String(value)}
            placeholder={def.hint ?? "路径"}
            onChange={(v) => onChange(v)}
            onCommit={onCommit}
            onCancel={onCancel}
            onCompositionChange={onCompositionChange}
            onOpenInExplorer={
              value && String(value).length > 0 && allowOsOpen
                ? () => openConfiguredDirectory(String(value))
                : undefined
            }
            onPick={(picked) => onChange(picked)}
            compact
            withStatus
            status={status}
          />
        ) : def.kind === "text" ? (
          <input
            type="text"
            value={String(value)}
            onChange={(e) => onChange(e.target.value)}
            onCompositionStart={composition.start}
            onCompositionEnd={(e) => composition.finish(e.currentTarget.value)}
            onBlur={(e) => composition.finish(e.currentTarget.value)}
            className="bg-bg-subtle border border-border-faint rounded-md h-8 px-2.5 text-sm font-mono w-72 max-w-[40vw] focus:outline-none focus:border-accent"
          />
        ) : def.kind === "number" ? (
          <input
            type="number"
            value={Number(value)}
            min={def.min}
            max={def.max}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onChange(n);
            }}
            onCompositionStart={composition.start}
            onCompositionEnd={(e) => composition.finish(e.currentTarget.value)}
            onBlur={(e) => composition.finish(e.currentTarget.value)}
            className="bg-bg-subtle border border-border-faint rounded-md h-8 px-2.5 text-sm font-mono w-24 text-right tabular-nums focus:outline-none focus:border-accent"
          />
        ) : (
          <Toggle
            checked={Boolean(value)}
            onChange={onChange}
            ariaLabel={def.label}
          />
        )}
        {/* 状态指示:只在非路径/非紧凑模式单独显示(紧凑模式由 PathField 内部带) */}
        {!(def.kind === "text" && isPath) && <StatusBadge status={status} />}
      </div>
    </div>
  );
}

// ---- 排除规则字段(独立组件)----
//
// 一个「扫描」section 同时管三个相关设置:
//   - excludePatterns: glob 模式列表(每行一条,按 basename 匹配)
//   - systemFiles: 额外的系统噪声文件(每行一条,内置 Thumbs.db 不可关闭)
//   - skipHidden: 是否跳过 . 开头的隐藏目录
//
// 之所以做成一个组件:三者在概念上紧密相关(都是「扫描时跳过什么」),
// 拆三个组件反而让用户困惑「这俩啥关系」。
function ExcludeRulesField({
  patterns,
  systemFiles,
  skipHidden,
  patternsStatus,
  systemFilesStatus,
  skipHiddenStatus,
  onPatternsChange,
  onSystemFilesChange,
  onSkipHiddenChange,
  onPatternsCommit,
  onSystemFilesCommit,
}: {
  patterns: string[];
  systemFiles: string[];
  skipHidden: boolean;
  patternsStatus: FieldStatus;
  systemFilesStatus: FieldStatus;
  skipHiddenStatus: FieldStatus;
  onPatternsChange: (next: string[]) => void;
  onSystemFilesChange: (next: string[]) => void;
  onSkipHiddenChange: (v: boolean) => void;
  onPatternsCommit: () => void;
  onSystemFilesCommit: () => void;
}) {
  // 多行文本 → string[]:split 时 trim + 去空行(用户经常多打空行)
  function linesToList(s: string): string[] {
    return s
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
  }
  // 反向:string[] → 多行文本(末尾不加多余空行,让光标自然停在最后一行)
  function listToLines(arr: string[]): string {
    return arr.join("\n");
  }
  return (
    <div className="px-4 py-3 text-sm space-y-4">
      <div>
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col">
            <span className="text-fg">排除模式</span>
            <span className="text-xs text-fg-subtle mt-0.5">
              一行一条,glob 匹配单个目录/文件名(任意深度)。例如
              <code className="font-mono mx-1 text-fg-muted">node_modules</code>
              <code className="font-mono mx-1 text-fg-muted">temp*</code>
              <code className="font-mono mx-1 text-fg-muted">~*</code>
            </span>
          </div>
          <StatusBadge status={patternsStatus} />
        </div>
        <textarea
          value={listToLines(patterns)}
          spellCheck={false}
          rows={Math.max(3, Math.min(8, patterns.length + 1))}
          placeholder="node_modules&#10;temp*&#10;~$*"
          onChange={(e) => onPatternsChange(linesToList(e.target.value))}
          onBlur={onPatternsCommit}
          className="mt-2 w-full bg-bg-subtle border border-border-faint rounded-md px-2.5 py-2 text-sm font-mono focus:outline-none focus:border-accent resize-y min-h-[80px]"
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-fg">跳过隐藏目录</span>
          <span className="text-xs text-fg-subtle mt-0.5">
            任何以 <code className="font-mono text-fg-muted">.</code>{" "}
            开头的子目录(. <code className="font-mono text-fg-muted">.git</code>{" "}
            / <code className="font-mono text-fg-muted">.cache</code> 等)
            整体不进库
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Toggle
            checked={skipHidden}
            onChange={onSkipHiddenChange}
            ariaLabel="跳过隐藏目录"
          />
          <StatusBadge status={skipHiddenStatus} />
        </div>
      </div>

      <div>
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col">
            <span className="text-fg">额外的系统白名单</span>
            <span className="text-xs text-fg-subtle mt-0.5">
              在内置 <code className="font-mono text-fg-muted">Thumbs.db</code>{" "}
              / <code className="font-mono text-fg-muted">desktop.ini</code> /{" "}
              <code className="font-mono text-fg-muted">.DS_Store</code>{" "}
              之上追加
            </span>
          </div>
          <StatusBadge status={systemFilesStatus} />
        </div>
        <textarea
          value={listToLines(systemFiles)}
          spellCheck={false}
          rows={Math.max(2, Math.min(4, systemFiles.length + 1))}
          placeholder=".Spotlight-V100&#10;~$*"
          onChange={(e) => onSystemFilesChange(linesToList(e.target.value))}
          onBlur={onSystemFilesCommit}
          className="mt-2 w-full bg-bg-subtle border border-border-faint rounded-md px-2.5 py-2 text-sm font-mono focus:outline-none focus:border-accent resize-y min-h-[60px]"
        />
      </div>
    </div>
  );
}

// ---- 路径输入组件 ----

interface PathFieldProps {
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  onCommit?: () => void;
  /** 撤销当前配置字段未提交的草稿；媒体根以整组数组为单位 */
  onCancel: () => void;
  onCompositionChange: (active: boolean) => void;
  /** 点击「在资源管理器中打开」时调用(undefined 时按钮隐藏) */
  onOpenInExplorer?: () => void;
  /** 用户确认服务端返回的完整目录路径后回调 */
  onPick: (picked: string) => void;
  /** 紧凑模式(用于 ConfigRow 内):按钮图标更小 */
  compact?: boolean;
  /** 状态指示(紧凑模式用) */
  withStatus?: boolean;
  status?: FieldStatus;
  removable?: boolean;
  onRemove?: () => void;
}

function PathField({
  value,
  placeholder,
  onChange,
  onCommit,
  onCancel,
  onCompositionChange,
  onOpenInExplorer,
  onPick,
  compact,
  withStatus,
  status = "idle",
  removable,
  onRemove,
}: PathFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);
  const composition = useConfigComposition(onChange, onCompositionChange);

  // 提交:Enter / Blur
  const commit = () => onCommit?.();

  const btnSize = compact ? "h-7 w-7" : "h-8 w-8";
  const iconSize = compact ? 12 : 14;

  return (
    <div className="flex items-center gap-2 w-full">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onCompositionStart={composition.start}
        onCompositionEnd={(e) => composition.finish(e.currentTarget.value)}
        onBlur={(e) => {
          composition.finish(e.currentTarget.value);
          commit();
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || composition.active.current) return;
          if (e.key === "Enter") {
            e.preventDefault();
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            // 清掉草稿后再失焦，onBlur 将没有待提交的内容。
            onCancel();
            e.currentTarget.blur();
          }
        }}
        placeholder={placeholder}
        title={
          onCommit
            ? "Enter 或移开焦点保存；Esc 撤销未提交修改"
            : "停止输入后自动保存；Esc 撤销整组未提交修改"
        }
        aria-keyshortcuts="Enter Escape"
        className="flex-1 min-w-0 bg-bg-subtle border border-border-faint rounded-md h-8 px-2.5 text-sm font-mono focus:outline-none focus:border-accent"
      />
      {/* 「选择目录」 */}
      <button
        type="button"
        onClick={() => setPicking(true)}
        title="选择本地目录"
        className={`inline-flex items-center justify-center ${btnSize} rounded-md border border-border-faint text-fg-muted hover:text-fg hover:border-border-strong transition-colors disabled:opacity-40`}
      >
        <FolderSearchIcon size={iconSize} />
      </button>
      {/* 「在资源管理器中打开」 */}
      {onOpenInExplorer && (
        <button
          type="button"
          onClick={onOpenInExplorer}
          title="在系统文件管理器中打开此目录"
          className={`inline-flex items-center justify-center ${btnSize} rounded-md border border-border-faint text-fg-muted hover:text-fg hover:border-border-strong transition-colors`}
        >
          <FolderOpenIcon size={iconSize} />
        </button>
      )}
      {/* 「移除」(多根列表用) */}
      {removable && onRemove && (
        <button
          type="button"
          onClick={() => {
            composition.clear();
            onRemove();
          }}
          title="删除此根目录"
          className={`inline-flex items-center justify-center ${btnSize} rounded-md border border-border-faint text-fg-subtle hover:text-danger hover:border-danger/40 transition-colors`}
        >
          <TrashIcon size={iconSize} />
        </button>
      )}
      {/* 状态指示 */}
      {withStatus && <StatusBadge status={status} />}
      {picking && (
        <DirectoryPicker
          initialDirectory={value}
          onClose={() => setPicking(false)}
          onPick={(directory) => {
            onPick(directory);
            onCommit?.();
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

// 设置中的目录统一使用已配置路径白名单入口，与媒体资源 ID 接口区分。
async function openConfiguredDirectory(path: string): Promise<void> {
  const ui = useUIStore.getState();
  try {
    await fsApi.openConfiguredPath(path);
    ui.pushToast({ kind: "success", message: "已请求打开目录", ttl: 1200 });
  } catch (e: unknown) {
    ui.pushToast({ kind: "error", message: fileManagerErrorMessage(e) });
  }
}

function Toggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** 给屏幕阅读器 / 测试用 — 多开关时区分哪个对应哪个设置 */
  ariaLabel?: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${
        checked ? "bg-accent" : "bg-bg-strong"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 bg-bg-elevated rounded-full shadow transition-transform ${
          checked ? "translate-x-4" : ""
        }`}
      />
    </button>
  );
}

function StatusBadge({ status }: { status: FieldStatus }) {
  if (status === "idle") return <span className="w-4 shrink-0" />;
  if (status === "saving") {
    return (
      <span
        className="inline-block w-3 h-3 rounded-full border-2 border-fg-muted border-t-transparent animate-spin shrink-0"
        aria-label="保存中"
      />
    );
  }
  if (status === "saved") {
    return (
      <CheckIcon
        size={14}
        className="text-accent shrink-0"
        aria-label="已保存"
      />
    );
  }
  return (
    <AlertIcon
      size={14}
      className="text-danger shrink-0"
      aria-label="保存失败"
    />
  );
}
