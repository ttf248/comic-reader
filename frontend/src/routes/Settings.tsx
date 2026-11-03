import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { prefsApi, favoritesApi, historyApi, type Prefs } from "../api/prefs";
import { scanApi } from "../api/scan";
import { cacheApi, formatBytes } from "../api/cache";
import { useScanSSE } from "../hooks/useScanSSE";
import ThemeSwitcher from "../components/common/ThemeSwitcher";
import { useUIStore, type AccentKey } from "../store/uiStore";
import { libraryQueryKeys, useLibraryManifest } from "../hooks/useLibrary";
import { ACCENT_SWATCHES } from "../hooks/useTheme";
import ServerConfigPanel from "../components/settings/ServerConfigPanel";
import ScanWarnings from "../components/common/ScanWarnings";
import { syncHistoryCache } from "../utils/historyCache";
import {
  RefreshIcon,
  TrashIcon,
  LibraryIcon,
  SunIcon,
  KeyboardIcon,
  InfoIcon,
  CheckIcon,
  ServerIcon,
} from "../components/common/Icon";

export default function Settings() {
  const prefsQuery = useQuery({
    queryKey: ["prefs"],
    queryFn: () => prefsApi.get(),
  });
  const { data } = prefsQuery;
  const qc = useQueryClient();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const viewMode = useUIStore((s) => s.viewMode);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const accent = useUIStore((s) => s.accent);
  const setAccent = useUIStore((s) => s.setAccent);
  const pushToast = useUIStore((s) => s.pushToast);
  const manifest = useLibraryManifest().data?.manifest;
  const sse = useScanSSE();

  // 缓存占用统计(后端 30s TTL,前端 staleTime 设小一点保证手动刷新能即时看到)
  const cacheStats = useQuery({
    queryKey: ["cache-stats"],
    queryFn: () => cacheApi.stats(),
    staleTime: 5_000,
  });
  function refreshCacheStats() {
    cacheStats.refetch();
  }

  const patchPrefs = useMutation({
    mutationFn: (p: Partial<Parameters<typeof prefsApi.patch>[0]>) =>
      prefsApi.patch(p),
    onSuccess: (saved, patch) => {
      qc.setQueryData(["prefs"], saved);
      if (patch.maxRecent !== undefined) syncHistoryCache(qc, saved.history);
      void qc.invalidateQueries({ queryKey: ["prefs"] });
    },
    onError: () => pushToast({ kind: "error", message: "保存阅读设置失败" }),
  });

  const pruneFav = useMutation({
    mutationFn: () => favoritesApi.prune(),
    onSuccess: (r) => {
      const removed = new Set(r.removed);
      const keep = (id: string) => !removed.has(id);
      qc.setQueryData<Awaited<ReturnType<typeof favoritesApi.list>>>(
        ["favorites"],
        (previous) =>
          previous ? { favorites: previous.favorites.filter(keep) } : undefined,
      );
      qc.setQueryData<Prefs>(["prefs"], (previous) =>
        previous
          ? { ...previous, favorites: previous.favorites.filter(keep) }
          : undefined,
      );
      void qc.invalidateQueries({ queryKey: ["favorites"] });
      pushToast({
        kind: "success",
        message: `已清理 ${r.removed.length} 项失效收藏`,
      });
    },
    onError: () => pushToast({ kind: "error", message: "清理失效收藏失败" }),
  });

  // 单 scope 清空(thumbs / converted / previews / faststart / transcode)。五个独立
  // mutation 实例让每个按钮的 isPending 互不干扰,UI 状态干净;公共逻辑
  // 收敛在 onSuccessScope 里。
  const onSuccessScope = (
    r: Awaited<ReturnType<typeof cacheApi.clearCache>>,
    scope: "thumbs" | "converted" | "previews" | "faststart" | "transcode",
  ) => {
    qc.invalidateQueries({ queryKey: ["cache-stats"] });
    const sub = r[scope];
    if (!sub || sub.deleted === 0) {
      pushToast({
        kind: "info",
        message: `${scopeLabel(scope)} 缓存本就是空的`,
      });
      return;
    }
    const freed =
      sub.freedBytes > 0 ? ` · 释放 ${formatBytes(sub.freedBytes)}` : "";
    pushToast({
      kind: "success",
      message: `已清空 ${scopeLabel(scope)} ${sub.deleted} 个文件${freed}`,
    });
  };
  const onErrorScope = (
    scope: "thumbs" | "converted" | "previews" | "faststart" | "transcode",
  ) =>
    pushToast({ kind: "error", message: `清空 ${scopeLabel(scope)} 缓存失败` });

  const clearThumbsScope = useMutation({
    mutationFn: () => cacheApi.clearCache("thumbs"),
    onSuccess: (r) => onSuccessScope(r, "thumbs"),
    onError: () => onErrorScope("thumbs"),
  });
  const clearConverted = useMutation({
    mutationFn: () => cacheApi.clearCache("converted"),
    onSuccess: (r) => onSuccessScope(r, "converted"),
    onError: () => onErrorScope("converted"),
  });
  const clearPreviews = useMutation({
    mutationFn: () => cacheApi.clearCache("previews"),
    onSuccess: (r) => onSuccessScope(r, "previews"),
    onError: () => onErrorScope("previews"),
  });
  const clearFaststart = useMutation({
    mutationFn: () => cacheApi.clearCache("faststart"),
    onSuccess: (r) => onSuccessScope(r, "faststart"),
    onError: () => onErrorScope("faststart"),
  });
  const clearTranscode = useMutation({
    mutationFn: () => cacheApi.clearCache("transcode"),
    onSuccess: (r) => onSuccessScope(r, "transcode"),
    onError: () => onErrorScope("transcode"),
  });

  // 一键全清:thumbs + converted + previews + faststart + transcode 一起清。
  // 解决「3 GB 缓存只点了一个缩略图清空按钮,数据纹丝不动」的痛点。
  const clearAll = useMutation({
    mutationFn: () => cacheApi.clearCache("all"),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["cache-stats"] });
      if (r.totalDeleted === 0) {
        pushToast({ kind: "info", message: "缓存本就是空的" });
        return;
      }
      pushToast({
        kind: "success",
        message: `已清空全部缓存 · ${r.totalDeleted} 个文件 · 释放 ${formatBytes(
          r.totalFreedBytes,
        )}`,
      });
    },
    onError: () => pushToast({ kind: "error", message: "清空全部缓存失败" }),
  });

  // 清空图像库缓存。不同于「重新扫描」(会立即起一次新扫描覆盖旧结果),
  // 这里只把缓存丢掉,等用户手动点「重新扫描」——避免误清后立刻被一次
  // 长任务占住 UI、掩盖问题。
  const clearScanCache = useMutation({
    mutationFn: () => scanApi.clearCache(),
    onSuccess: () => {
      // 丢弃所有摘要页，避免旧媒体根数据在下一次扫描前短暂回显。
      qc.removeQueries({ queryKey: libraryQueryKeys.root });
      pushToast({
        kind: "success",
        message: "已清空图像库缓存 · 建议点击「重新扫描」重建",
      });
    },
    onError: () => pushToast({ kind: "error", message: "清空图像库缓存失败" }),
  });

  const clearHist = useMutation({
    mutationFn: () => historyApi.clear(),
    onSuccess: () => {
      syncHistoryCache(qc, []);
      pushToast({ kind: "success", message: "已清空最近访问" });
    },
    onError: () => pushToast({ kind: "error", message: "清空最近访问失败" }),
  });

  // Settings 页内也能触发扫描：与 Home / Toolbar 走同一套 SSE。
  const startScan = useMutation({
    mutationFn: () => scanApi.start(),
    onSuccess: (r) => {
      sse.startWith(r.scanId);
      pushToast({ kind: "info", message: "扫描已开始" });
    },
    onError: () => pushToast({ kind: "error", message: "启动扫描失败" }),
  });
  const prefsError = prefsQuery.isError && (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger/5 px-4 py-3 mb-6 text-sm"
    >
      <p>
        设置加载失败。
        {data ? "仍显示上次加载的设置。" : "请重试加载。"}
      </p>
      <button
        type="button"
        onClick={() => void prefsQuery.refetch()}
        disabled={prefsQuery.isFetching}
        className="shrink-0 text-accent hover:underline disabled:opacity-50"
      >
        {prefsQuery.isFetching ? "正在重试…" : "重试加载"}
      </button>
    </div>
  );
  if (!data) {
    return (
      <div className="page-shell py-10 max-w-3xl mx-auto">
        <h1 className="page-title mb-6">设置</h1>
        {prefsError || (
          <div role="status" className="text-fg-muted text-[13px]">
            正在加载设置…
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="page-shell py-10 max-w-3xl mx-auto">
      <h1 className="page-title">设置</h1>
      <p className="text-[13px] text-fg-muted mt-2 mb-10">个性化你的阅读体验</p>
      {prefsError}

      <Section title="外观" icon={<SunIcon size={13} />}>
        <Row label="主题">
          <ThemeSwitcher />
        </Row>
        <Row label="强调色">
          <div className="flex items-center gap-2">
            {ACCENT_SWATCHES.map((s) => {
              const active = accent === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setAccent(s.id as AccentKey)}
                  className="relative w-7 h-7 rounded-full transition-transform hover:scale-110 focus:outline-none"
                  style={{ background: s.light }}
                  title={s.name}
                  aria-label={s.name}
                >
                  {active && (
                    <span className="absolute inset-0 ring-2 ring-fg ring-offset-2 ring-offset-bg-elevated rounded-full flex items-center justify-center">
                      <CheckIcon size={12} className="text-fg" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </Row>
        <Row label="侧边栏">
          <button
            onClick={toggleSidebar}
            className="px-3 h-8 rounded-md border border-border-faint hover:bg-bg-subtle text-sm transition-colors"
          >
            {sidebarCollapsed ? "展开" : "折叠"}
          </button>
        </Row>
        <Row label="默认视图">
          <div className="flex items-center border border-border-faint rounded-md overflow-hidden">
            {(["grid", "list"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setViewMode(k)}
                className={`h-8 px-3 text-[12.5px] transition-colors ${
                  viewMode === k
                    ? "bg-bg-subtle text-fg"
                    : "text-fg-muted hover:text-fg"
                }`}
              >
                {k === "grid" ? "网格" : "列表"}
              </button>
            ))}
          </div>
        </Row>
      </Section>

      <Section title="阅读" icon={<LibraryIcon size={13} />}>
        <Row label="阅读到末尾自动切换下一本">
          <Toggle
            label="阅读到末尾自动切换下一本"
            checked={data.autoSwitchAlbum}
            disabled={patchPrefs.isPending}
            onChange={(v) => patchPrefs.mutate({ autoSwitchAlbum: v })}
          />
        </Row>
        <Row label="切换时显示通知">
          <Toggle
            label="切换时显示通知"
            checked={data.showSwitchNotif}
            disabled={patchPrefs.isPending}
            onChange={(v) => patchPrefs.mutate({ showSwitchNotif: v })}
          />
        </Row>
        <Row label="最近访问保留条数">
          <NumberInput
            value={data.maxRecent}
            disabled={patchPrefs.isPending}
            min={1}
            max={50}
            onChange={(v) => patchPrefs.mutate({ maxRecent: v })}
          />
        </Row>
      </Section>

      <Section title="数据" icon={<LibraryIcon size={13} />}>
        <Row label="图像库缓存">
          <div className="flex min-w-0 flex-1 flex-col items-end gap-2">
            <div className="flex flex-wrap items-center justify-end gap-3">
              <span className="text-[12.5px] text-fg-muted">
                {manifest
                  ? `${manifest.statistics.albumCount} 本相册 · ${manifest.statistics.tagCount} 个标签${
                      manifest.scannedAt
                        ? ` · ${new Date(manifest.scannedAt).toLocaleString("zh-CN", { hour12: false })}`
                        : " · 尚未扫描"
                    }`
                  : "尚未加载"}
              </span>
              <button
                onClick={() =>
                  void qc.invalidateQueries({ queryKey: libraryQueryKeys.root })
                }
                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-border-faint hover:bg-bg-subtle text-[12.5px] transition-colors"
              >
                <RefreshIcon size={11} />
                <span>刷新</span>
              </button>
              <button
                onClick={() => startScan.mutate()}
                disabled={startScan.isPending || sse.isRunning}
                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-border-faint hover:bg-bg-subtle text-[12.5px] transition-colors disabled:opacity-50"
                title="扫描 (Ctrl+S)"
              >
                <RefreshIcon size={11} />
                <span>
                  {sse.isRunning
                    ? "扫描中…"
                    : startScan.isPending
                      ? "启动中…"
                      : "重新扫描"}
                </span>
              </button>
              <button
                onClick={() => clearScanCache.mutate()}
                disabled={clearScanCache.isPending}
                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-danger/40 text-danger hover:bg-danger/5 text-[12.5px] transition-colors disabled:opacity-50"
                title="清空图像库缓存（不会立即重新扫描）"
              >
                <TrashIcon size={11} />
                <span>{clearScanCache.isPending ? "清空中…" : "清空缓存"}</span>
              </button>
            </div>
            {manifest && (
              <ScanWarnings
                warnings={manifest.warnings}
                total={manifest.statistics.warningCount}
              />
            )}
          </div>
        </Row>
        <Row label="缓存占用">
          {/* 统计行与细分徽章纵向排列：作为 Row 的两个并列子元素时，
              徽章会被排到统计行右边，把整行挤到换行。 */}
          <div className="flex min-w-0 flex-1 flex-col items-end gap-2">
            <div className="flex flex-wrap items-center justify-end gap-3 text-[12.5px] text-fg-muted">
              <span className="whitespace-nowrap">
                {cacheStats.isLoading
                  ? "计算中…"
                  : !cacheStats.data
                    ? "—"
                    : !cacheStats.data.available
                      ? "不可用"
                      : `${formatBytes(cacheStats.data.totalBytes)} · ${
                          cacheStats.data.fileCount
                        } 个文件`}
              </span>
              {cacheStats.data && (
                <span
                  className="whitespace-nowrap text-fg-subtle tabular-nums"
                  title={
                    cacheStats.data.scannedAt
                      ? `扫描于 ${new Date(cacheStats.data.scannedAt).toLocaleString("zh-CN", { hour12: false })}`
                      : ""
                  }
                >
                  {cacheStats.data.cacheTtlSeconds > 0
                    ? `${cacheStats.data.cacheTtlSeconds}s 内复用`
                    : "缓存已过期"}
                </span>
              )}
              <button
                onClick={refreshCacheStats}
                disabled={cacheStats.isFetching}
                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-border-faint hover:bg-bg-subtle text-[12.5px] transition-colors disabled:opacity-50"
                title="重新扫描磁盘计算缓存占用"
              >
                {cacheStats.isFetching ? (
                  <span className="inline-block w-3 h-3 rounded-full border-2 border-fg-muted border-t-transparent animate-spin" />
                ) : (
                  <RefreshIcon size={11} />
                )}
                <span>刷新</span>
              </button>
              <button
                onClick={() => clearAll.mutate()}
                disabled={clearAll.isPending}
                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-danger/40 text-danger hover:bg-danger/5 text-[12.5px] transition-colors disabled:opacity-50"
                title="清空全部缓存（缩略图 + 转换图 + 预览图 + faststart + 转码）"
              >
                <TrashIcon size={11} />
                <span>{clearAll.isPending ? "清空中…" : "一键全清"}</span>
              </button>
            </div>
            {/* 按类型细分 — 大头一目了然,转码缓存过大时可单独清。
                五类之和等于上面的总占用,少列一类用户就对不上账。 */}
            {cacheStats.data && cacheStats.data.available && (
              <div className="mt-2 grid grid-cols-2 sm:grid-cols-5 gap-2 text-[12.5px]">
                <SubUsageBadge
                  label="缩略图"
                  sub={cacheStats.data.thumbs}
                  onClear={() => clearThumbsScope.mutate()}
                  clearPending={clearThumbsScope.isPending}
                />
                <SubUsageBadge
                  label="转换图"
                  sub={cacheStats.data.converted}
                  onClear={() => clearConverted.mutate()}
                  clearPending={clearConverted.isPending}
                />
                <SubUsageBadge
                  label="预览图"
                  sub={cacheStats.data.previews}
                  onClear={() => clearPreviews.mutate()}
                  clearPending={clearPreviews.isPending}
                />
                <SubUsageBadge
                  label="faststart"
                  sub={cacheStats.data.videoFaststart}
                  onClear={() => clearFaststart.mutate()}
                  clearPending={clearFaststart.isPending}
                />
                <SubUsageBadge
                  label="转码"
                  sub={cacheStats.data.videoTranscode}
                  onClear={() => clearTranscode.mutate()}
                  clearPending={clearTranscode.isPending}
                />
              </div>
            )}
          </div>
        </Row>
        <Row label="清理失效收藏">
          <button
            onClick={() => pruneFav.mutate()}
            disabled={pruneFav.isPending}
            className="h-8 px-3 rounded-md border border-border-faint hover:bg-bg-subtle text-[12.5px] transition-colors disabled:opacity-50"
          >
            {pruneFav.isPending ? "清理中…" : "清理"}
          </button>
        </Row>
        <Row label="清空最近访问" danger>
          <button
            onClick={() => clearHist.mutate()}
            disabled={clearHist.isPending}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-danger/40 text-danger hover:bg-danger/5 text-[12.5px] transition-colors disabled:opacity-50"
          >
            <TrashIcon size={11} />
            <span>{clearHist.isPending ? "清空中…" : "清空"}</span>
          </button>
        </Row>
      </Section>

      <section className="mb-10">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-fg-muted">
            <ServerIcon size={13} />
          </span>
          <h2 className="section-title">服务端</h2>
          <span className="text-[12.5px] text-fg-subtle ml-2">
            改动自动写回后端 config.yaml
          </span>
        </div>
        <ServerConfigPanel />
      </section>

      <Section title="关于" icon={<InfoIcon size={13} />}>
        <div className="text-[13px] text-fg-muted leading-relaxed">
          <div className="font-display text-base text-fg">
            Local Gallery · 本地画廊
          </div>
          <div className="mt-1">Web 版 · v{__APP_VERSION__}</div>
          <div className="mt-4 text-[12.5px] text-fg-subtle flex items-center gap-2">
            <span>按</span>
            <kbd className="font-mono px-1.5 py-0.5 rounded border border-border-faint bg-bg-subtle text-fg-muted">
              ?
            </kbd>
            <span>查看所有快捷键</span>
          </div>
          <div className="mt-3 text-[12.5px] text-fg-subtle flex items-center gap-2">
            <KeyboardIcon size={12} />
            <span>所有偏好（主题、强调色、视图、收藏）均存于本机</span>
          </div>
        </div>
      </Section>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <div className="flex items-center gap-2 mb-3">
        {icon && <span className="text-fg-muted">{icon}</span>}
        <h2 className="section-title">{title}</h2>
      </div>
      <div className="bg-bg-elevated border border-border-faint rounded-lg divide-y divide-border-faint overflow-hidden">
        {children}
      </div>
    </section>
  );
}

function Row({
  label,
  children,
  danger,
}: {
  label: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    // 标签固定不换行：内容多的时候应该让内容换行，而不是把"缓存占用"
    // 挤成两行、同时把右侧内容裁掉。
    <div className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
      <span
        className={`shrink-0 whitespace-nowrap ${danger ? "text-danger" : "text-fg"}`}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    // 视觉是 20px 的药丸（和系统设置一致），可点区域撑到 28px：
    // 外层按钮 28px 高、内部药丸居中，命中区从 20px 提到 28px，
    // 视觉尺寸完全不变。20px 的开关在触摸设备上很难点准。
    <button
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-7 w-9 items-center justify-center rounded-full disabled:opacity-50"
    >
      <span
        className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${
          checked ? "bg-accent" : "bg-bg-strong"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 bg-bg-elevated rounded-full shadow transition-transform ${
            checked ? "translate-x-4" : ""
          }`}
        />
      </span>
    </button>
  );
}

function NumberInput({
  value,
  disabled,
  min,
  max,
  onChange,
}: {
  value: number;
  disabled: boolean;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="inline-flex items-center border border-border-faint rounded-md overflow-hidden">
      <button
        aria-label="减少最近访问保留条数"
        disabled={disabled}
        onClick={() => onChange(Math.max(min, value - 1))}
        className="w-8 h-8 text-fg-muted hover:bg-bg-subtle hover:text-fg transition-colors disabled:opacity-50"
      >
        −
      </button>
      <span className="px-3 h-8 inline-flex items-center text-sm tabular-nums min-w-[40px] justify-center">
        {value}
      </span>
      <button
        aria-label="增加最近访问保留条数"
        disabled={disabled}
        onClick={() => onChange(Math.min(max, value + 1))}
        className="w-8 h-8 text-fg-muted hover:bg-bg-subtle hover:text-fg transition-colors disabled:opacity-50"
      >
        +
      </button>
    </div>
  );
}

// 缓存细分 badge:展示单个子目录(thumbs / converted / faststart / transcode)的占用。
// 不可用(子目录还没产生)时整块灰显;可用时右上角带「清空」按钮(只清
// 这一类,不影响其他子项),方便定位"大头"快速清理。
function SubUsageBadge({
  label,
  sub,
  onOpen,
  onClear,
  clearPending,
}: {
  label: string;
  sub: { path: string; bytes: number; fileCount: number; available: boolean };
  onOpen?: () => void;
  onClear?: () => void;
  clearPending?: boolean;
}) {
  const body = sub.available ? (
    <div className="flex items-baseline gap-1.5">
      <span className="text-fg tabular-nums font-medium">
        {formatBytes(sub.bytes)}
      </span>
      <span className="text-fg-subtle tabular-nums">{sub.fileCount} 个</span>
    </div>
  ) : (
    <span className="text-fg-subtle">—</span>
  );
  // 只有"可用 + 有数据 + 提供 onClear"时显示清空按钮;0 字节的子项
  // 没必要再点一次(后端也是 no-op)。
  const showClear = !!onClear && sub.available && sub.bytes > 0;
  const cls = `flex flex-col gap-0.5 px-2.5 py-1.5 rounded border border-border-faint bg-bg-subtle/40 ${
    onOpen
      ? "cursor-pointer hover:border-border-strong hover:bg-bg-subtle transition-colors"
      : ""
  }`;
  const inner = (
    <>
      <div className="flex items-center justify-between gap-1.5">
        <span className="text-fg-muted text-[12.5px]">
          {label}
        </span>
        {showClear && (
          <button
            onClick={(e) => {
              e.stopPropagation(); // 防止冒泡到外层 onOpen
              onClear!();
            }}
            disabled={clearPending}
            className="inline-flex items-center justify-center w-7 h-7 -mr-1 rounded text-fg-subtle hover:text-danger hover:bg-danger/10 transition-colors disabled:opacity-50"
            title={`清空 ${label} 缓存`}
            aria-label={`清空 ${label} 缓存`}
          >
            {clearPending ? (
              <span className="inline-block w-2 h-2 rounded-full border border-fg-muted border-t-transparent animate-spin" />
            ) : (
              <TrashIcon size={9} />
            )}
          </button>
        )}
      </div>
      {body}
    </>
  );
  if (onOpen) {
    return (
      <button
        onClick={onOpen}
        className={cls}
        title={`在资源管理器中打开 ${sub.path}`}
      >
        {inner}
      </button>
    );
  }
  return <div className={cls}>{inner}</div>;
}

// 缓存 scope 中文标签(toast 复用)。
function scopeLabel(
  s: "thumbs" | "converted" | "previews" | "faststart" | "transcode",
): string {
  switch (s) {
    case "thumbs":
      return "缩略图";
    case "converted":
      return "转换图";
    case "previews":
      return "预览图";
    case "faststart":
      return "faststart";
    case "transcode":
      return "转码";
  }
}
