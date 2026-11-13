import { ChevronLeftIcon } from "../common/Icon";

export interface LocationCrumb {
  adcode: number | null;
  name: string;
}

interface LocationBreadcrumbProps {
  /** 从「全国」到当前层级的祖先链。 */
  chain: LocationCrumb[];
  /** 跳到某个层级。 */
  onNavigate: (adcode: number | null) => void;
}

/**
 * 地点层级面包屑。
 *
 * 「返回」说的是回去 —— 在这张图上就是回到上一级地图；面包屑说的是
 * 我在哪 —— 祖先的名字可点。缺一个，用户就不知道自己是在往回走还是
 * 往深里钻。
 */
export default function LocationBreadcrumb({
  chain,
  onNavigate,
}: LocationBreadcrumbProps) {
  const parent = chain.length > 1 ? chain[chain.length - 2] : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {parent ? (
        <>
          <button
            type="button"
            className="btn btn-sm btn-outline shrink-0"
            onClick={() => onNavigate(parent.adcode)}
          >
            <ChevronLeftIcon size={13} />
            <span>返回</span>
          </button>
          <span className="hidden h-4 w-px shrink-0 bg-border sm:block" aria-hidden="true" />
        </>
      ) : null}
      <nav aria-label="地点层级" className="flex min-w-0 items-center gap-1">
        {chain.map((crumb, index) => {
          const isCurrent = index === chain.length - 1;
          return (
            <span key={crumb.adcode ?? "nation"} className="flex min-w-0 items-center gap-1">
              {index > 0 ? (
                <span className="shrink-0 text-fg-subtle" aria-hidden="true">
                  ／
                </span>
              ) : null}
              {isCurrent ? (
                <span aria-current="page" className="truncate text-body text-fg">
                  {crumb.name}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onNavigate(crumb.adcode)}
                  className="truncate text-body text-fg-muted transition-colors hover:text-brand-ink"
                >
                  {crumb.name}
                </button>
              )}
            </span>
          );
        })}
      </nav>
    </div>
  );
}
