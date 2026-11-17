import { useId, useState, type ReactNode } from 'react';

export type NoteTone = 'neutral' | 'warn' | 'error';

const ICON: Record<NoteTone, ReactNode> = {
  neutral: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.4v3.6" />
      <path d="M8 4.9h.01" />
    </>
  ),
  warn: (
    <>
      <path d="M8 2.2 14.2 13H1.8L8 2.2Z" />
      <path d="M8 6.6v3" />
      <path d="M8 11.4h.01" />
    </>
  ),
  error: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.8v3.6" />
      <path d="M8 11h.01" />
    </>
  ),
};
const COLOR: Record<NoteTone, string> = { neutral: 'text-stone-500', warn: 'text-amber-800', error: 'text-red-700' };
const ICON_COLOR: Record<NoteTone, string> = { neutral: 'text-stone-400', warn: 'text-amber-600', error: 'text-red-600' };

/**
 * A one-line hint inside a card: a small icon and 13 px muted text, no box. `more` is the rest of the explanation,
 * opened in place by a "More" button after the line. Tones: `neutral` (gray), `warn` (amber text and icon), `error`
 * (the only tone with a colored box: it is a problem the reader must see). Keep `children` to one short sentence;
 * anything longer goes in `more` or an InfoTip.
 */
export function Note({ tone = 'neutral', children, more, className = '' }: { tone?: NoteTone; children: ReactNode; more?: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = tone === 'error' ? 'rounded-xl border border-red-200/60 bg-red-50 px-3 py-2.5' : '';
  return (
    <div className={`flex items-start gap-2 text-[13px] leading-5 ${COLOR[tone]} ${box} ${className}`} role={tone === 'error' ? 'alert' : undefined}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`mt-[3px] shrink-0 ${ICON_COLOR[tone]}`}>
        {ICON[tone]}
      </svg>
      <div className="min-w-0 flex-1">
        <span>{children}</span>
        {more && (
          <>
            {' '}
            <button
              type="button"
              aria-expanded={open}
              aria-controls={id}
              onClick={() => setOpen((o) => !o)}
              className="rounded font-medium text-stone-500 underline decoration-stone-300 underline-offset-2 transition-colors duration-fast hover:text-ink hover:decoration-stone-500"
            >
              {open ? 'Less' : 'More'}
            </button>
            {open && (
              <div id={id} className="mt-1.5 animate-fade space-y-1.5 text-stone-500">
                {more}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
