import type { ReactNode } from "react";

interface Props {
  title: string;
  eyebrow: string;
  description?: ReactNode;
  contained?: boolean;
}

export default function PageHeading({
  title,
  eyebrow,
  description,
  contained = false,
}: Props) {
  return (
    <section className={`${contained ? "" : "page-shell "}page-heading`}>
      <p className="page-eyebrow">{eyebrow}</p>
      <h1 className="page-title">{title}</h1>
      {description && (
        <div className="text-[13px] text-fg-muted mt-3 leading-relaxed">
          {description}
        </div>
      )}
    </section>
  );
}
