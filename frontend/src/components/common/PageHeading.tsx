import type { ReactNode } from "react";

interface Props {
  title: string;
  eyebrow: string;
  description?: ReactNode;
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
  contained = false,
  size = "sm",
}: Props) {
  return (
    <section className={`${contained ? "" : "page-shell "}page-heading`}>
      <p className="page-eyebrow">{eyebrow}</p>
      <h1 className={`page-title${size === "lg" ? "" : " page-title--sm"}`}>
        {title}
      </h1>
      {description && (
        <div className="text-body text-fg-muted mt-3 leading-relaxed">
          {description}
        </div>
      )}
    </section>
  );
}
