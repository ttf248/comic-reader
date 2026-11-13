interface TravelStatLedgerProps {
  /** 每一项：一个大数字与它说明的事。 */
  items: { value: string; label: string }[];
}

/**
 * 数字台：先给规模，再给内容。
 *
 * 一排数字比一排卡片轻。卡片给每个数字都加了边框与底色，四个数字读
 * 起来像四件独立的事，实际上它们是同一句话。
 */
export default function TravelStatLedger({ items }: TravelStatLedgerProps) {
  if (items.length === 0) return null;
  return (
    <section aria-label="规模" className="travel-ledger">
      {items.map((item) => (
        <div key={item.label} className="travel-ledger__item">
          <span className="travel-ledger__value">{item.value}</span>
          <span className="travel-ledger__label">{item.label}</span>
        </div>
      ))}
    </section>
  );
}
