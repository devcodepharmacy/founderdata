import type { ReactNode } from 'react';
import { InfoTip } from '../InfoTip';

/**
 * The header of a card: a 13 px semibold title, an optional (i) with the fine print, an optional one-line `sub`, and
 * the controls on the right. Paddings match `GCard` and site/primitives' `Card` (title at 20 px from the left, its
 * line centered 28 px from the top), so every card header lines up on every page. Put it first inside `.card`, then a
 * body with `px-5 pb-5` (or `pb-2` for a table that runs edge to edge).
 */
export function CardHeader({
  title,
  info,
  infoLabel,
  sub,
  right,
  className = '',
}: {
  title: ReactNode;
  /** The card's fine print, behind an (i) next to the title. */
  info?: ReactNode;
  /** The (i) button's accessible name; defaults to "How <title> is counted". */
  infoLabel?: string;
  sub?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pb-3 pt-4 ${className}`}>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          {typeof title === 'string' ? <h3 className="truncate text-[13px] font-semibold leading-6 text-ink">{title}</h3> : title}
          {info && (
            <InfoTip label={infoLabel ?? (typeof title === 'string' ? `How ${title.toLowerCase()} is counted` : 'How this card is counted')} className="text-stone-400">
              {info}
            </InfoTip>
          )}
        </div>
        {sub && <div className="mt-0.5 text-[13px] text-stone-500">{sub}</div>}
      </div>
      {/* A 36 px control centers on the 24 px title line: the wrapper is 36 px tall and pulled up 6 px from sm. */}
      {right && <div className="flex min-h-9 min-w-0 max-w-full flex-wrap items-center gap-2 sm:-my-1.5">{right}</div>}
    </header>
  );
}
