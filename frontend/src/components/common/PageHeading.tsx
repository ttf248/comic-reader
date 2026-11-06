import type { ReactNode } from "react";

interface Props {
  title: string;
  eyebrow: string;
  description?: ReactNode;
  /**
   * 页头右侧的动作（这一页的主要操作）。
   *
   * 放在标题这一行的右端，而不是塞进描述句里：宽屏的页头右侧本来是
   * 空的，动作贴在那儿既不挤正文，也不会跟一句话读成一串。
   */
  action?: ReactNode;
  contained?: boolean;
  /**
   * 标题尺寸。
   *
   * 「sm」是列表页的默认档：最近 / 收藏 / 未读 / 设置 / 标签。
   * 工作台首页用「大」——首页是入口，标题要压得住首屏；
   * 列表页只是工作台里的一个视图，用同样大的标题会让两者看起来是
   * 同一级的东西，页面之间也就失去了主次。
   */
  size?: "sm" | "lg";
}

export default function PageHeading({
  title,
  eyebrow,
  description,
  action,
  contained = false,
  size = "sm",
}: Props) {
  return (
    <section className={`${contained ? "" : "page-shell "}page-heading`}>
      <div className="flex items-end justify-between gap-6 flex-wrap">
        <div className="min-w-0">
          <p className="page-eyebrow">{eyebrow}</p>
          <h1
            className={`page-title${size === "lg" ? "" : " page-title--sm"}`}
          >
            {title}
          </h1>
        </div>
        {action && <div className="shrink-0 pb-1">{action}</div>}
      </div>
      {description && (
        <div
          className="text-body text-fg-muted mt-3 leading-relaxed"
          data-testid="page-heading-description"
        >
          {description}
        </div>
      )}
    </section>
  );
}
