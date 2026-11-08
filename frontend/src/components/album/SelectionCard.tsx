import type { CardData, CoverRatio } from "./AlbumCard";
import { mediaCountParts } from "../../utils/mediaCount";
import CardCover from "./CardCover";
import { CheckIcon } from "../common/Icon";
import type { ViewMode } from "../../store/uiStore";

export default function SelectionCard({
  card,
  checked,
  busy,
  variant,
  ratio,
  onToggle,
}: {
  card: CardData;
  checked: boolean;
  busy: boolean;
  variant: ViewMode;
  ratio: CoverRatio;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={`选择“${card.displayTitle ?? card.title}”`}
      disabled={busy}
      onClick={onToggle}
      className={`relative w-full overflow-hidden rounded-lg border-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${checked ? "border-brand bg-brand-soft" : "border-border bg-bg-elevated"} ${variant === "list" ? "flex items-center gap-3 p-2" : "p-2"}`}
    >
      <div
        className={`overflow-hidden rounded-sm bg-bg-subtle ${variant === "list" ? "h-14 w-14 shrink-0" : "w-full"}`}
        style={variant === "list" ? undefined : { aspectRatio: ratio }}
      >
        <CardCover data={card} fit="cover" compact />
      </div>
      <div className="min-w-0 py-2 pr-6">
        <div className="h-10 line-clamp-2 text-body font-medium">
          {card.displayTitle ?? card.title}
        </div>
        <div className="text-meta text-fg-muted">
          {card.variant === "album"
            ? mediaCountParts({
                imageCount: card.imageCount ?? card.count,
                videoCount: card.videoCount,
                contentKind: card.contentKind,
              }).label
            : `${card.count} ${card.contentKind === "comic" ? "卷" : "本"}`}
        </div>
      </div>
      <span
        aria-hidden="true"
        className={`absolute right-3 top-3 grid h-6 w-6 place-items-center rounded border ${checked ? "border-brand bg-brand text-brand-contrast" : "border-border-strong bg-bg-elevated"}`}
      >
        {checked && <CheckIcon size={14} />}
      </span>
    </button>
  );
}
