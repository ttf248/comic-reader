import PageHeading from "../components/common/PageHeading";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { prefsApi, favoritesApi, historyApi, type Prefs } from "../api/prefs";
import { scanApi } from "../api/scan";
import { useScanSSE } from "../hooks/useScanSSE";
import ThemeSwitcher from "../components/common/ThemeSwitcher";
import Segmented from "../components/common/Segmented";
import { useUIStore } from "../store/uiStore";
import { libraryQueryKeys, useLibraryManifest } from "../hooks/useLibrary";
import StateBackupPanel from "../components/settings/StateBackupPanel";
import ServerConfigPanel from "../components/settings/ServerConfigPanel";
import SectionRail from "../components/settings/SectionRail";
import {
  scrollToSection,
  useSectionSpy,
  type SettingsSection,
} from "../components/settings/sectionSpy";
import ScanWarnings from "../components/common/ScanWarnings";
import Toggle from "../components/common/Toggle";
import { syncHistoryCache } from "../utils/historyCache";
import { useAppMode } from "../hooks/useAppMode";
import { usePhotoStore, WALL_DENSITY_LABEL } from "../store/photoStore";
import { useGalleryStore } from "../store/galleryStore";
import {
  RefreshIcon,
  TrashIcon,
  LibraryIcon,
  SunIcon,
  KeyboardIcon,
  InfoIcon,
  ServerIcon,
  ReaderIcon,
} from "../components/common/Icon";

/**
 * 设置页的分区。
 *
 * 之前用 CSS 多列排版，两列高度差一大就留下一整片空白，看起来像没加载完。
 * 现在是一条粘性导航加一列内容：分区关系写在导航里，滚动时高亮当前分区。
 */
const SECTIONS: SettingsSection[] = [
  { id: "appearance", label: "外观" },
  { id: "reading", label: "阅读" },
  { id: "data", label: "数据" },
  { id: "server", label: "服务端" },
  { id: "backup", label: "备份" },
  { id: "about", label: "关于" },
];

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
  const pushToast = useUIStore((s) => s.pushToast);
  const manifest = useLibraryManifest().data?.manifest;
  const sse = useScanSSE();
  // 工作台模式走服务端偏好；照片与漫画的偏好各自走本地 store，
  // 三者落点不同，在设置页里分开写。
  const { mode: workbenchMode, setMode: setWorkbenchMode } = useAppMode();
  const density = usePhotoStore((s) => s.density);
  const setDensity = usePhotoStore((s) => s.setDensity);
  const showInfo = usePhotoStore((s) => s.showInfo);
  const setShowInfo = usePhotoStore((s) => s.setShowInfo);
  const readerMode = useGalleryStore((s) => s.mode);
  const setReaderMode = useGalleryStore((s) => s.setMode);
  const fit = useGalleryStore((s) => s.fit);
  const setFit = useGalleryStore((s) => s.setFit);
  const direction = useGalleryStore((s) => s.direction);
  const setDirection = useGalleryStore((s) => s.setDirection);

  const activeSection = useSectionSpy(SECTIONS);

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
          : previous,
      );
      void qc.invalidateQueries({ queryKey: ["favorites"] });
      pushToast({
        kind: "success",
        message: `已清理 ${r.removed.length} 项失效收藏`,
      });
    },
    onError: () => pushToast({ kind: "error", message: "清理失效收藏失败" }),
  });

  // 清空媒体库索引。不同于「重新扫描」(会立即起一次新扫描覆盖旧结果),
  // 这里只把索引丢掉,等用户手动点「重新扫描」——避免误清后立刻被一次
  // 长任务占住 UI、掩盖问题。
  const clearScanCache = useMutation({
    mutationFn: () => scanApi.clearCache(),
    onSuccess: () => {
      // 丢弃所有摘要页，避免旧媒体根数据在下一次扫描前短暂回显。
      qc.removeQueries({ queryKey: libraryQueryKeys.root });
      pushToast({
        kind: "success",
        message: "已清空媒体库索引 · 建议点击「重新扫描」重建",
      });
    },
    onError: () => pushToast({ kind: "error", message: "清空媒体库索引失败" }),
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
      className="flex items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger/5 px-4 py-3 mb-6 text-body"
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
      <div className="page-shell settings-page pb-10">
        <div className="max-w-3xl">
          <PageHeading
            title="设置"
            eyebrow="你的空间，你的习惯"
            contained
            description="调整外观、阅读方式与本地媒体配置。"
          />
          {prefsError || (
            <div role="status" className="text-fg-muted text-body">
              正在加载设置…
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell settings-page pb-10">
      <PageHeading
        title="设置"
        eyebrow="你的空间，你的习惯"
        contained
        description="调整外观、阅读方式与本地媒体配置。"
      />
      {prefsError}
      <div className="mt-8 grid gap-6 lg:grid-cols-[164px_minmax(0,1fr)] lg:items-start lg:gap-10">
        <SectionRail
          sections={SECTIONS}
          active={activeSection}
          onSelect={scrollToSection}
        />

        <div className="min-w-0 max-w-4xl space-y-10">
          <section id="appearance" className="scroll-mt-4">
            <Section title="外观" icon={<SunIcon size={13} />}>
              <Row label="主题">
                <ThemeSwitcher />
              </Row>
              {/* 侧栏的折叠只属于宽屏：窄屏侧栏是抽屉，宽度不由折叠决定，
                  设置里也就不再摆这一行 —— 让人改一个当前看不见的东西，
                  等于把设置页变成第二本说明。 */}
              <div className="hidden lg:block">
                <Row label="侧边栏">
                  <Segmented
                    label="侧边栏"
                    value={sidebarCollapsed ? "collapsed" : "expanded"}
                    onChange={(value) => {
                      if ((value === "collapsed") !== sidebarCollapsed) {
                        toggleSidebar();
                      }
                    }}
                    options={[
                      { value: "expanded", label: "展开" },
                      { value: "collapsed", label: "折叠" },
                    ]}
                  />
                </Row>
              </div>
              <Row label="默认视图">
                <Segmented
                  label="默认视图"
                  value={viewMode}
                  onChange={setViewMode}
                  options={[
                    { value: "grid", label: "网格" },
                    { value: "list", label: "列表" },
                  ]}
                />
              </Row>
              {/* 工作台：应用当前面向哪一类目录。它决定列表呈现什么、
                  页面用什么措辞；两类目录的属性在「服务端 › 媒体根目录」里设定。 */}
              <Row label="默认工作台">
                <Segmented
                  label="默认工作台"
                  value={workbenchMode}
                  onChange={setWorkbenchMode}
                  options={[
                    { value: "photo", label: "照片" },
                    { value: "comic", label: "漫画" },
                  ]}
                />
              </Row>
            </Section>
          </section>

          <section id="reading" className="scroll-mt-4">
            <Section title="阅读" icon={<ReaderIcon size={13} />}>
              <GroupLabel>照片</GroupLabel>
              <Row label="照片墙密度">
                <Segmented
                  label="照片墙密度"
                  value={density}
                  onChange={setDensity}
                  options={(
                    ["auto", "compact", "cozy", "large"] as const
                  ).map((key) => ({ value: key, label: WALL_DENSITY_LABEL[key] }))}
                />
              </Row>
              <Row label="大图预览显示信息">
                <Toggle
                  label="大图预览显示信息"
                  checked={showInfo}
                  onChange={(v) => setShowInfo(v)}
                />
              </Row>

              <GroupLabel>漫画</GroupLabel>
              <Row label="默认显示模式">
                <Segmented
                  label="默认显示模式"
                  value={readerMode}
                  onChange={setReaderMode}
                  options={[
                    { value: "single", label: "单页" },
                    { value: "continuous", label: "连续" },
                    { value: "double", label: "双页" },
                  ]}
                />
              </Row>
              {/* 漫画侧的媒体是页：写「图片适配」会与整册的用词冲突。 */}
              <Row label="默认页面适配">
                <Segmented
                  label="默认页面适配"
                  value={fit}
                  onChange={setFit}
                  options={[
                    { value: "fit", label: "适应" },
                    { value: "width", label: "按宽" },
                    { value: "height", label: "按高" },
                    { value: "original", label: "原始" },
                  ]}
                />
              </Row>
              <Row label="双页翻页方向">
                <Segmented
                  label="双页翻页方向"
                  value={direction}
                  onChange={setDirection}
                  options={[
                    { value: "ltr", label: "左→右" },
                    { value: "rtl", label: "右→左" },
                  ]}
                />
              </Row>
              <Row label="阅读到末尾自动切换下一卷">
                <Toggle
                  label="阅读到末尾自动切换下一卷"
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
              <p className="px-5 pb-4 text-meta text-fg-subtle -mt-2">
                显示模式、适配与方向只保存在本机浏览器；自动切换与通知保存在服务端，所有设备共享。
              </p>
            </Section>
          </section>

          <section id="data" className="scroll-mt-4">
            <Section title="数据" icon={<LibraryIcon size={13} />}>
              <Row label="媒体库索引">
                <div className="flex min-w-0 flex-1 flex-col items-end gap-2">
                  <div className="flex flex-wrap items-center justify-end gap-3">
                    <span className="text-meta text-fg-muted">
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
                        void qc.invalidateQueries({
                          queryKey: libraryQueryKeys.root,
                        })
                      }
                      className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-border-faint hover:bg-bg-subtle text-meta transition-colors"
                    >
                      <RefreshIcon size={11} />
                      <span>刷新</span>
                    </button>
                    <button
                      onClick={() => startScan.mutate()}
                      disabled={startScan.isPending || sse.isRunning}
                      className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-border-faint hover:bg-bg-subtle text-meta transition-colors disabled:opacity-50"
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
                      className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-danger/40 text-danger hover:bg-danger/5 text-meta transition-colors disabled:opacity-50"
                      title="清空媒体库索引（不会立即重新扫描）"
                    >
                      <TrashIcon size={11} />
                      <span>
                        {clearScanCache.isPending ? "清空中…" : "清空索引"}
                      </span>
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
              <Row label="最近访问保留条数">
                <NumberInput
                  value={data.maxRecent}
                  disabled={patchPrefs.isPending}
                  min={1}
                  max={50}
                  onChange={(v) => patchPrefs.mutate({ maxRecent: v })}
                />
              </Row>
              <Row label="清理失效收藏">
                <button
                  onClick={() => pruneFav.mutate()}
                  disabled={pruneFav.isPending}
                  className="h-8 px-3 rounded-md border border-border-faint hover:bg-bg-subtle text-meta transition-colors disabled:opacity-50"
                >
                  {pruneFav.isPending ? "清理中…" : "清理"}
                </button>
              </Row>
              <Row label="清空最近访问" danger>
                <button
                  onClick={() => clearHist.mutate()}
                  disabled={clearHist.isPending}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-danger/40 text-danger hover:bg-danger/5 text-meta transition-colors disabled:opacity-50"
                >
                  <TrashIcon size={11} />
                  <span>{clearHist.isPending ? "清空中…" : "清空"}</span>
                </button>
              </Row>
            </Section>
          </section>

          <section id="server" className="scroll-mt-4">
            <section className="settings-section">
              <div className="settings-section__heading">
                <span className="text-fg-muted">
                  <ServerIcon size={13} />
                </span>
                <h2 className="section-title">服务端</h2>
                <span className="text-meta text-fg-subtle ml-2">
                  修改后自动保存，部分设置需重启
                </span>
              </div>
              <ServerConfigPanel />
            </section>
          </section>

          <section id="backup" className="scroll-mt-4">
            <StateBackupPanel />
          </section>

          <section id="about" className="scroll-mt-4">
            <Section title="关于" icon={<InfoIcon size={13} />}>
              <div className="text-body text-fg-muted leading-relaxed">
                <div className="font-display text-label text-fg">
                  Local Gallery · 本地画廊
                </div>
                <div className="mt-1">Web 版 · v{__APP_VERSION__}</div>
                <div className="mt-4 text-meta text-fg-subtle flex items-center gap-2">
                  <span>按</span>
                  <kbd className="font-mono px-1.5 py-0.5 rounded border border-border-faint bg-bg-subtle text-fg-muted">
                    ?
                  </kbd>
                  <span>查看所有快捷键</span>
                </div>
                <div className="mt-3 text-meta text-fg-subtle flex items-center gap-2">
                  <KeyboardIcon size={12} />
                  <span>媒体保存在本地，收藏与阅读记录由服务端保存</span>
                </div>
              </div>
            </Section>
          </section>
        </div>
      </div>
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
    <section className="settings-section">
      <div className="settings-section__heading">
        {icon && <span className="text-fg-muted">{icon}</span>}
        <h2 className="section-title">{title}</h2>
      </div>
      <div className="settings-section__body divide-y divide-border-faint">
        {children}
      </div>
    </section>
  );
}

/** 一组相关设置的小标题。 */
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-5 pt-4 pb-1 text-meta text-fg-subtle">{children}</p>
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
    // 标签固定不换行：内容多的时候应该让内容换行，而不是把标签
    // 挤成两行、同时把右侧内容裁掉。
    <div className="settings-row flex items-center justify-between gap-4 px-5 py-4 text-body">
      <span
        className={`shrink-0 whitespace-nowrap ${danger ? "text-danger" : "text-fg"}`}
      >
        {label}
      </span>
      {children}
    </div>
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
      <span className="px-3 h-8 inline-flex items-center text-body tabular-nums min-w-[40px] justify-center">
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
