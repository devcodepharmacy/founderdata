import { useId, useState, type ReactNode } from 'react';
import { Spinner, StatusChip, type StatusTone } from '../ui';

/**
 * Small pieces every setup card shares: a copy button, a secret field with a reveal toggle, numbered steps for work a
 * person does in another tool, the designed result of a check, and the card shells. The design system has no
 * equivalents yet (docs/DESIGN.md), so they live here.
 */

/** Copies `value`, then says so in place for 1.5 s. */
export function CopyButton({ value, label = 'Copy', className = 'btn', onCopied }: { value: string; label?: string; className?: string; onCopied?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`${className} shrink-0`}
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            onCopied?.();
            setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {copied ? <path d="m5 12.5 4.5 4.5L19 7.5" /> : <path d="M9 9h10v10H9zM5 15V5h10" />}
      </svg>
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </button>
  );
}

/** A read-only value with a copy button: a URL, a key, a command on one line. */
export function CopyField({ value, label, mono = true }: { value: string; label?: string; mono?: boolean }) {
  const id = useId();
  return (
    <div>
      {label && (
        <label className="label" htmlFor={id}>
          {label}
        </label>
      )}
      <div className="flex gap-2">
        <input id={id} className={`input min-w-0 py-1.5 text-[13px] ${mono ? 'font-mono' : ''}`} readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
        <CopyButton value={value} />
      </div>
    </div>
  );
}

const Eye = ({ open }: { open: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
    {!open && <path d="M4 20 20 4" />}
  </svg>
);

/** A masked input with a show and hide toggle. The value never leaves component state. */
export function SecretInput({
  value,
  onChange,
  placeholder,
  id,
  label,
  invalid,
  disabled,
  className = 'min-w-0 flex-1',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  id?: string;
  label?: string;
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className={`relative ${className}`}>
      <input
        id={id}
        className="input pr-10 font-mono text-[13px]"
        type={shown ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        aria-label={id ? undefined : label}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="absolute right-1 top-1/2 flex h-7 w-8 -translate-y-1/2 items-center justify-center rounded-[7px] text-stone-400 transition-colors duration-fast hover:bg-stone-100 hover:text-ink"
        aria-label={shown ? 'Hide the value' : 'Show the value'}
        aria-pressed={shown}
        onClick={() => setShown((s) => !s)}
      >
        <Eye open={!shown} />
      </button>
    </div>
  );
}

/**
 * A signing secret or token: masked input, Save, and a line that says whether one is stored. The server answers a
 * stored secret masked, so the field starts with the mask and Save sends what the person typed.
 */
export function SecretField({
  saved,
  placeholder,
  onSave,
  label,
  hint,
}: {
  saved: string | null | undefined;
  placeholder: string;
  onSave: (v: string) => Promise<void> | void;
  label?: string;
  hint?: ReactNode;
}) {
  const id = useId();
  const [value, setValue] = useState(saved ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-2.5">
      {label && (
        <label className="label" htmlFor={id}>
          {label}
        </label>
      )}
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSave(value);
          } finally {
            setBusy(false);
          }
        }}
      >
        <SecretInput id={id} label={label ?? placeholder} value={value} onChange={setValue} placeholder={placeholder} />
        <button className="btn-dark" disabled={busy || value === (saved ?? '')}>
          {busy ? (
            <>
              <Spinner /> Saving
            </>
          ) : (
            'Save'
          )}
        </button>
      </form>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-stone-500">
        {saved ? <StatusChip tone="ok">Secret saved</StatusChip> : <StatusChip tone="neutral">No secret yet</StatusChip>}
        {hint}
      </div>
    </div>
  );
}

/** Numbered steps for work a person does somewhere else: a dashboard, a terminal, Xcode. */
export function Steps({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <ol className={`fd-steps space-y-5 text-sm ${className}`}>{children}</ol>;
}

export function Step({ n, title, children, done }: { n: number; title?: ReactNode; children?: ReactNode; done?: boolean }) {
  return (
    <li className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-x-3">
      <span
        className={`mt-px flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ring-1 ring-inset ${
          done ? 'bg-emerald-50 text-emerald-700 ring-emerald-200/60' : 'bg-stone-50 text-stone-600 ring-stone-200'
        }`}
        aria-hidden="true"
      >
        {done ? (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m2.5 6.5 2.5 2.5 4.5-6" />
          </svg>
        ) : (
          n
        )}
      </span>
      <div className="min-w-0 pt-1">
        {title && <div className="font-medium text-ink">{title}</div>}
        {children && <div className={`${title ? 'mt-1' : ''} text-stone-600 [&_code:not(.code)]:rounded [&_code:not(.code)]:bg-stone-100 [&_code:not(.code)]:px-1 [&_code:not(.code)]:text-[12.5px]`}>{children}</div>}
      </div>
    </li>
  );
}

/** The outcome of a check or a test send: what happened, and why when it failed. */
export function CheckResult({ ok, title, children, onRetry }: { ok: boolean; title: ReactNode; children?: ReactNode; onRetry?: () => void }) {
  return (
    <div
      role="status"
      className={`flex items-start gap-3 rounded-xl px-3.5 py-3 text-sm ring-1 ring-inset animate-fade ${
        ok ? 'bg-emerald-50 text-emerald-800 ring-emerald-200/60' : 'bg-red-50 text-red-800 ring-red-200/60'
      }`}
    >
      <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[#fff] ${ok ? 'bg-emerald-500' : 'bg-red-500'}`} aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          {ok ? <path d="m2.5 6.5 2.5 2.5 4.5-6" /> : <path d="M3 3l6 6M9 3l-6 6" />}
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        {children && <div className="mt-0.5 opacity-90">{children}</div>}
      </div>
      {onRetry && (
        <button type="button" className="btn h-8 shrink-0 text-xs" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** An error next to its cause, with a retry. */
export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-red-600">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="font-medium underline underline-offset-2" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** A tinted note inside a card: amber for something to fix, red for refused data, stone for context. */
export function Callout({ tone = 'neutral', children }: { tone?: 'neutral' | 'warn' | 'error' | 'info'; children: ReactNode }) {
  const cls = {
    neutral: 'bg-stone-50 text-stone-600 ring-stone-200/70',
    warn: 'bg-amber-50 text-amber-900 ring-amber-200/60',
    error: 'bg-red-50 text-red-800 ring-red-200/60',
    info: 'bg-sky-50 text-sky-800 ring-sky-200/60',
  }[tone];
  return <div className={`rounded-xl px-3.5 py-3 text-sm ring-1 ring-inset ${cls}`}>{children}</div>;
}

export interface CardStatus {
  tone: StatusTone;
  /** One or two words: Connected, Needs setup, Refused. */
  label: string;
  /** The last time data arrived, or the next step, in a short line. */
  detail?: string;
}

/** A settings card that is always open: General, Reporting timezone, Team. */
export function SettingsCard({
  id,
  title,
  desc,
  status,
  actions,
  children,
  className = '',
}: {
  id?: string;
  title: ReactNode;
  desc?: ReactNode;
  status?: CardStatus | null;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`card scroll-mt-24 ${className}`} aria-labelledby={id ? `${id}-title` : undefined}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 p-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={id ? `${id}-title` : undefined} className="text-title text-ink">
              {title}
            </h3>
            {status && <StatusChip tone={status.tone}>{status.label}</StatusChip>}
          </div>
          {desc && <p className="mt-1 max-w-2xl text-sm text-stone-500">{desc}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="border-t border-stone-200/60 px-5 pb-5 pt-4">{children}</div>}
    </section>
  );
}

/**
 * An integration: a row with its mark, name, one line and state chip that opens to its form. The body renders only
 * while open, so a closed card fetches nothing.
 */
export function IntegrationCard({
  id,
  mark,
  title,
  desc,
  status,
  open,
  onToggle,
  children,
}: {
  id: string;
  mark: ReactNode;
  title: string;
  desc: ReactNode;
  status: CardStatus | null;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const body = `${id}-body`;
  return (
    <section id={id} className={`card scroll-mt-24 transition-[box-shadow,border-color] duration-base ${open ? 'shadow-raised' : 'card-hover'}`}>
      <h3 className="m-0">
        <button
          type="button"
          id={`${id}-toggle`}
          className="flex w-full items-center gap-3.5 rounded-2xl px-5 py-4 text-left"
          aria-expanded={open}
          aria-controls={body}
          onClick={onToggle}
        >
          {mark}
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-semibold text-ink">{title}</span>
            <span className="mt-0.5 line-clamp-2 text-[13px] font-normal sm:block sm:truncate text-stone-500">{status?.detail ?? desc}</span>
          </span>
          {status && <StatusChip tone={status.tone} className="hidden sm:inline-flex">{status.label}</StatusChip>}
          {status && (
            <StatusChip tone={status.tone} className="px-1.5 sm:hidden" title={status.label}>
              <span className="sr-only">{status.label}</span>
            </StatusChip>
          )}
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`shrink-0 text-stone-400 transition-transform duration-base ease-out ${open ? 'rotate-180' : ''}`}
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </h3>
      {open && (
        <div id={body} role="region" aria-labelledby={`${id}-toggle`} className="border-t border-stone-200/60 px-5 pb-5 pt-4 animate-fade">
          {status?.detail && <p className="mb-4 text-[13px] text-stone-500">{desc}</p>}
          {children}
        </div>
      )}
    </section>
  );
}

/** A provider's mark: its initials in a quiet rounded square. No third-party logos ship with the repo. */
export function Mark({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'brand' }) {
  return (
    <span
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-[13px] font-semibold ring-1 ring-inset ${
        tone === 'brand' ? 'bg-brand-soft text-brand-text ring-brand/20' : 'bg-stone-50 text-stone-600 ring-stone-200/80'
      }`}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}
