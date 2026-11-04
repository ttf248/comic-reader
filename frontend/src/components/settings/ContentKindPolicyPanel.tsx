import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { configApi, type ContentKind } from "../../api/config";
import { useUIStore } from "../../store/uiStore";

/**
 * 相册用途策略：决定「相册默认按哪种方式打开」。
 *
 * 它与工作台模式是两件事：
 *  - 工作台模式（照片 / 漫画 / 全部）是用户此刻在看哪一类；
 *  - 相册用途是每本相册自己的属性，新相册按这个默认值归类。
 *
 * 这块原来藏在「服务端」面板最深处的媒体根列表里——那是一个写 YAML
 * 的运维面板，而用途是产品级设置，位置太深了。
 */
export default function ContentKindPolicyPanel() {
  const qc = useQueryClient();
  const pushToast = useUIStore((s) => s.pushToast);
  const { data, isLoading } = useQuery({
    queryKey: ["server-config"],
    queryFn: () => configApi.get(),
  });

  const update = useMutation({
    mutationFn: (patch: {
      defaultContentKind?: ContentKind;
      rootContentKinds?: Record<string, ContentKind>;
    }) => configApi.update(patch),
    onSuccess: (response) => {
      // 与「服务端」面板共用同一份配置缓存：写完两边立刻一致。
      qc.setQueryData(["server-config"], response.config);
      pushToast({ kind: "success", message: "相册用途已保存", ttl: 1200 });
    },
    onError: () => pushToast({ kind: "error", message: "保存相册用途失败" }),
  });

  if (isLoading) {
    return <div className="text-[13px] text-fg-muted px-5 py-4">加载中…</div>;
  }
  if (!data) {
    return (
      <div className="text-[13px] text-fg-muted px-5 py-4">
        无法读取服务端配置：相册用途只能在运行服务的本机上修改。
      </div>
    );
  }

  const defaultKind = data.defaultContentKind ?? "photo";
  const rootKinds = data.rootContentKinds ?? {};

  const setRootKind = (root: string, kind: ContentKind | null) => {
    const next: Record<string, ContentKind> = { ...rootKinds };
    if (kind === null) delete next[root];
    else next[root] = kind;
    update.mutate({ rootContentKinds: next });
  };

  return (
    <div className="px-5 py-4 text-sm space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col">
          <span className="text-fg">全局默认相册类型</span>
          <span className="text-[12.5px] text-fg-subtle mt-0.5">
            没有单独指定的相册按这个方式打开：照片墙是平铺浏览，
            漫画是单页阅读器。也可以在相册页的「更多」菜单里单独改。
          </span>
        </div>
        <KindSegmentedControl
          value={defaultKind}
          onChange={(kind) => {
            if (kind) update.mutate({ defaultContentKind: kind });
          }}
        />
      </div>

      {data.mediaRoots.length > 0 && (
        <div className="space-y-2 border-t border-border-faint pt-4">
          <div className="flex flex-col">
            <span className="text-fg">按媒体根指定</span>
            <span className="text-[12.5px] text-fg-subtle mt-0.5">
              照片和漫画常分在两个根里；这里可以逐个根定默认打开方式。
            </span>
          </div>
          {data.mediaRoots.map((root) => (
            <div
              key={root}
              className="flex items-center justify-between gap-4"
            >
              <span className="min-w-0 truncate text-fg-muted">{root}</span>
              <KindSegmentedControl
                value={rootKinds[root] ?? null}
                inheritLabel={`跟随全局（${
                  defaultKind === "comic" ? "漫画" : "照片"
                }）`}
                onChange={(kind) => setRootKind(root, kind)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 用途选择器：照片墙 / 漫画阅读器。
 *
 * null 表示「跟随全局默认」，只用在按根设置上。
 */
function KindSegmentedControl({
  value,
  onChange,
  inheritLabel,
}: {
  value: ContentKind | null;
  onChange: (kind: ContentKind | null) => void;
  inheritLabel?: string;
}) {
  const options: { key: ContentKind | null; label: string }[] = [
    { key: "photo", label: "照片" },
    { key: "comic", label: "漫画" },
  ];
  if (inheritLabel) options.push({ key: null, label: inheritLabel });
  return (
    <div
      role="group"
      aria-label="相册类型"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border-faint p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.key ?? "inherit"}
          type="button"
          onClick={() => onChange(option.key)}
          aria-pressed={value === option.key}
          className={`h-7 rounded px-2.5 text-[12.5px] transition-colors ${
            value === option.key
              ? "bg-bg-subtle text-fg"
              : "text-fg-muted hover:text-fg"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
